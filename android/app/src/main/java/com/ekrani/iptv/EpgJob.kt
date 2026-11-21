package com.ekrani.iptv

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStreamReader
import java.io.Reader
import java.util.regex.Pattern

/* XMLTV guide read as a stream, like EpgJob in service/index.js: guides can be hundreds of MB unpacked,
   so only the wanted channels and time window are kept. Pull model: open() reads up to the first
   <programme> and returns the channel list; each next() reads until a batch of `max` is collected. */
class EpgJob(val id: String, private val resp: Http.Response) {
    @Volatile var time = System.currentTimeMillis()
    private var reader: Reader? = null
    private val buf = StringBuilder()
    private val cbuf = CharArray(65536)
    private var header = true
    private val channels = JSONArray()
    private var want: Set<String>? = null
    private var from = 0L
    private var to = Long.MAX_VALUE
    private var max = 300 * 1024
    private var out = LinkedHashMap<String, JSONArray>()
    private var outSize = 0
    private var ended = false

    companion object {
        private val RE_CH = Pattern.compile("<channel\\b([^>]*)>([\\s\\S]*?)</channel>")
        private val RE_DN = Pattern.compile("<display-name[^>]*>([\\s\\S]*?)</display-name>")
        private val RE_PROG = Pattern.compile("<programme\\b([^>]*)>([\\s\\S]*?)</programme>")
        private val RE_TITLE = Pattern.compile("<title[^>]*>([\\s\\S]*?)</title>")
        private val RE_DESC = Pattern.compile("<desc[^>]*>([\\s\\S]*?)</desc>")
        private val RE_CDATA = Pattern.compile("^\\s*<!\\[CDATA\\[([\\s\\S]*?)]]>\\s*$")
        private val RE_ENT = Pattern.compile("&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);", Pattern.CASE_INSENSITIVE)
        private val RE_TIME = Pattern.compile("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})?\\s*([+-]\\d{2})?(\\d{2})?")
        private val ATTR = HashMap<String, Pair<Pattern, Pattern>>()
        private const val MAX_BUF = 16 * 1024 * 1024
        private const val MAX_DESC = 700

        fun decode(raw: String?): String {
            if (raw.isNullOrEmpty()) return ""
            var s: String = raw
            val c = RE_CDATA.matcher(s)
            if (c.find()) s = c.group(1) ?: ""
            if (s.indexOf('&') >= 0) {
                val m = RE_ENT.matcher(s)
                val sb = StringBuffer()
                while (m.find()) {
                    val e = m.group(1)!!
                    val rep = when (e.lowercase()) {
                        "amp" -> "&"; "lt" -> "<"; "gt" -> ">"; "quot" -> "\""; "apos" -> "'"
                        else -> try {
                            val code = if (e[1] == 'x' || e[1] == 'X') e.substring(2).toInt(16) else e.substring(1).toInt()
                            String(Character.toChars(code))
                        } catch (_: Exception) { "" }
                    }
                    m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(rep))
                }
                m.appendTail(sb)
                s = sb.toString()
            }
            return s.trim()
        }

        private fun attr(str: String, name: String): String {
            val p = synchronized(ATTR) {
                ATTR.getOrPut(name) {
                    Pair(Pattern.compile("\\b$name\\s*=\\s*\"([^\"]*)\""), Pattern.compile("\\b$name\\s*=\\s*'([^']*)'"))
                }
            }
            var m = p.first.matcher(str)
            if (m.find()) return m.group(1) ?: ""
            m = p.second.matcher(str)
            return if (m.find()) m.group(1) ?: "" else ""
        }

        /* days since 1970-01-01 of a calendar date (proleptic Gregorian) */
        private fun days(y0: Int, m: Int, d: Int): Long {
            val y = if (m <= 2) y0 - 1 else y0
            val era = (if (y >= 0) y else y - 399) / 400
            val yoe = y - era * 400
            val doy = (153 * (m + (if (m > 2) -3 else 9)) + 2) / 5 + d - 1
            val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
            return era * 146097L + doe - 719468
        }

        /* XMLTV time "20261118220000 +0300" -> unix seconds */
        fun xmlTime(s: String): Long {
            val m = RE_TIME.matcher(s)
            if (!m.find()) return 0
            var t = days(m.group(1)!!.toInt(), m.group(2)!!.toInt(), m.group(3)!!.toInt()) * 86400 +
                m.group(4)!!.toInt() * 3600 + m.group(5)!!.toInt() * 60 + (m.group(6)?.toInt() ?: 0)
            val tz = m.group(7)
            if (tz != null) {
                val sign = if (tz[0] == '-') -1 else 1
                val hh = tz.substring(1).toInt()
                val mm = m.group(8)?.toInt() ?: 0
                t -= sign * (hh * 60 + mm) * 60L
            }
            return t
        }
    }

    val bytes: Long get() = resp.raw.count
    val total: Long get() = resp.length
    val status: Int get() = resp.status

    /* false at the end of the stream */
    private fun readMore(): Boolean {
        if (ended) return false
        val r = reader ?: InputStreamReader(resp.body(), Charsets.UTF_8).also { reader = it }
        val n = r.read(cbuf)
        if (n < 0) {
            ended = true
            return false
        }
        buf.append(cbuf, 0, n)
        if (buf.length > MAX_BUF) buf.delete(0, buf.length - 1024 * 1024)
        return true
    }

    private fun readChannels() {
        val stop = buf.indexOf("<programme")
        val m = RE_CH.matcher(buf)
        var last = 0
        while (m.find()) {
            if (stop >= 0 && m.start() > stop) break
            val row = JSONArray()
            row.put(decode(attr(m.group(1)!!, "id")))
            val d = RE_DN.matcher(m.group(2)!!)
            while (d.find() && row.length() < 4) row.put(decode(d.group(1)))
            channels.put(row)
            last = m.end()
        }
        if (stop >= 0) {
            header = false
            buf.delete(0, stop)
        } else if (last > 0) {
            buf.delete(0, last)
        } else if (buf.length > 65536) {
            val cut = buf.lastIndexOf("<channel")
            if (cut > 0) buf.delete(0, cut) else buf.delete(0, buf.length - 4096)
        }
    }

    private fun readProgrammes() {
        val w = want ?: return
        val m = RE_PROG.matcher(buf)
        var last = 0
        while (m.find()) {
            last = m.end()
            val a = m.group(1)!!
            val cid = decode(attr(a, "channel"))
            if (!w.contains(cid.lowercase())) continue
            val s = xmlTime(attr(a, "start"))
            var e = xmlTime(attr(a, "stop"))
            if (e == 0L) e = s + 1800
            if (s == 0L || e <= from || s >= to) continue
            val body = m.group(2)!!
            val tm = RE_TITLE.matcher(body)
            val dm = RE_DESC.matcher(body)
            val title = if (tm.find()) decode(tm.group(1)) else ""
            var desc = if (dm.find()) decode(dm.group(1)) else ""
            if (desc.length > MAX_DESC) desc = desc.substring(0, MAX_DESC - 1) + "…"
            val row = JSONArray().put(s).put(e).put(title).put(desc)
            out.getOrPut(cid) { JSONArray() }.put(row)
            outSize += title.length + desc.length + 24
            if (outSize >= max) break
        }
        if (last > 0) buf.delete(0, last)
        else if (buf.length > 65536 && buf.indexOf("<programme") < 0) buf.delete(0, buf.length - 4096)
    }

    /* reads the channel list (everything before the first programme) */
    @Synchronized
    fun open(): JSONObject {
        time = System.currentTimeMillis()
        while (header) {
            if (!readMore()) { header = false; readChannels(); break }
            readChannels()
        }
        return JSONObject().put("returnValue", true).put("id", id).put("status", status)
            .put("channels", channels).put("done", ended).put("bytes", bytes).put("total", total)
    }

    @Synchronized
    fun next(p: JSONObject): JSONObject {
        time = System.currentTimeMillis()
        val wl = p.optJSONArray("want")
        if (wl != null) {
            val set = HashSet<String>()
            for (i in 0 until wl.length()) set.add(wl.optString(i).lowercase())
            want = set
            if (p.optLong("from") > 0) from = p.optLong("from")
            if (p.optLong("to") > 0) to = p.optLong("to")
            if (p.optInt("max") > 0) max = p.optInt("max").coerceIn(32 * 1024, 2 * 1024 * 1024)
        }
        if (want == null) throw IllegalStateException("want is required")
        readProgrammes()
        while (outSize < max && readMore()) readProgrammes()
        val data = JSONObject()
        for ((k, v) in out) data.put(k, v)
        out = LinkedHashMap()
        outSize = 0
        return JSONObject().put("returnValue", true).put("data", data).put("done", ended).put("bytes", bytes).put("total", total)
    }

    fun close() {
        try { reader?.close() } catch (_: Exception) {}
        resp.close()
        buf.setLength(0)
        out.clear()
    }
}
