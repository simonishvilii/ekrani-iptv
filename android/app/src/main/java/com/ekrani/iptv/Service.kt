package com.ekrani.iptv

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/* The same methods as the webOS Node service (service/index.js), for the web app's Net.luna():
   fetch / chunk / release / epgOpen / epgNext / lanStart / lanPoll / lanStop / ytServe / ping. */
class Service(private val ctx: Context) {
    private class Item(val body: String) { @Volatile var time = System.currentTimeMillis() }

    private val store = ConcurrentHashMap<String, Item>()
    private val jobs = ConcurrentHashMap<String, EpgJob>()
    private val seq = AtomicInteger(0)
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private val CACHE_TTL = 120_000L
    private val JOB_TTL = 300_000L

    private fun ok() = JSONObject().put("returnValue", true)

    private fun cleanup() {
        val now = System.currentTimeMillis()
        store.entries.removeAll { now - it.value.time > CACHE_TTL }
        for ((k, j) in jobs) if (now - j.time > JOB_TTL) { jobs.remove(k); j.close() }
    }

    private fun headers(p: JSONObject): Map<String, String> {
        val h = p.optJSONObject("headers") ?: return emptyMap()
        val out = HashMap<String, String>()
        for (k in h.keys()) out[k] = h.optString(k)
        return out
    }

    /* runs on a worker thread; throws -> {returnValue:false, errorText} */
    fun call(method: String, p: JSONObject): JSONObject = when (method) {
        "fetch" -> {
            cleanup()
            val url = p.optString("url")
            if (url.isEmpty()) throw IllegalArgumentException("url is required")
            val (status, type, body) = Http.download(url, headers(p))
            val id = "r" + seq.incrementAndGet()
            store[id] = Item(body)
            ok().put("id", id).put("size", body.length).put("status", status).put("contentType", type)
        }
        "chunk" -> {
            val id = p.optString("id")
            val item = store[id] ?: throw IllegalArgumentException("unknown id")
            item.time = System.currentTimeMillis()
            val offset = p.optInt("offset", 0).coerceAtLeast(0)
            val length = p.optInt("length", 512 * 1024).let { if (it <= 0) 512 * 1024 else it }
            val len = item.body.length
            val data = if (offset >= len) "" else item.body.substring(offset, minOf(len, offset + length))
            val done = offset.toLong() + length >= len
            if (done) store.remove(id)
            ok().put("data", data).put("done", done)
        }
        "release" -> {
            val id = p.optString("id")
            store.remove(id)
            jobs.remove(id)?.close()
            ok()
        }
        "epgOpen" -> {
            cleanup()
            val url = p.optString("url")
            if (url.isEmpty()) throw IllegalArgumentException("url is required")
            val r = Http.open(url, headers(p), readTimeout = 120000)
            if (r.status >= 400) {
                r.close()
                throw ServiceError("HTTP " + r.status, JSONObject().put("status", r.status))
            }
            val id = "e" + seq.incrementAndGet()
            val job = EpgJob(id, r)
            jobs[id] = job
            try {
                val res = job.open()
                if (res.optBoolean("done")) { jobs.remove(id); job.close() }
                res
            } catch (e: Exception) {
                jobs.remove(id)
                job.close()
                throw e
            }
        }
        "epgNext" -> {
            val id = p.optString("id")
            val job = jobs[id] ?: throw IllegalArgumentException("unknown id")
            try {
                val res = job.next(p)
                if (res.optBoolean("done")) { jobs.remove(id); job.close() }
                res
            } catch (e: Exception) {
                jobs.remove(id)
                job.close()
                throw e
            }
        }
        "lanStart" -> lanStart(p)
        "lanPoll" -> {
            val l = lan ?: throw IllegalStateException("not running")
            l.last = System.currentTimeMillis()
            val items = JSONArray()
            synchronized(l.inbox) { l.inbox.forEach { items.put(it) }; l.inbox.clear() }
            ok().put("items", items)
        }
        "lanStop" -> { lanStop(); ok() }
        "ytServe" -> ok().put("port", ytServe())
        "ping" -> ok().put("version", BuildConfigVersion.name(ctx))
        else -> throw IllegalArgumentException("unknown method $method")
    }

    class ServiceError(msg: String, val extra: JSONObject) : Exception(msg)

    /* ---------- phone setup page ---------- */

    private class Lan(val server: LanServer, val port: Int) {
        @Volatile var code = ""
        @Volatile var texts = JSONObject()
        @Volatile var mode = "playlist"
        @Volatile var last = System.currentTimeMillis()
        val inbox = ArrayList<JSONObject>()
        var watch: ScheduledFuture<*>? = null
    }

    @Volatile private var lan: Lan? = null

    private fun localIp(): String {
        var best = ""
        var bestMain = false
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                val main = Regex("^(eth|wlan|wl|wi-?fi)", RegexOption.IGNORE_CASE).containsMatchIn(ni.name)
                for (a in ni.inetAddresses) {
                    if (a !is Inet4Address || a.isLoopbackAddress || a.isLinkLocalAddress) continue
                    if (best.isEmpty() || (main && !bestMain)) { best = a.hostAddress ?: ""; bestMain = main }
                }
            }
        } catch (_: Exception) {}
        return best
    }

    @Synchronized
    private fun lanStart(p: JSONObject): JSONObject {
        val code = p.optString("code").replace(Regex("\\D"), "").take(8)
        if (code.isEmpty()) throw IllegalArgumentException("code is required")
        lan?.let {
            it.code = code
            p.optJSONObject("texts")?.let { t -> it.texts = t }
            it.mode = p.optString("mode", "playlist").ifEmpty { "playlist" }
            it.last = System.currentTimeMillis()
            return ok().put("ip", localIp()).put("port", it.port)
        }
        var err: Exception? = null
        for (port in 8890..8899) {
            val srv = LanServer(port)
            try {
                srv.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
            } catch (e: Exception) { err = e; continue }
            val l = Lan(srv, port)
            l.code = code
            l.texts = p.optJSONObject("texts") ?: JSONObject()
            l.mode = p.optString("mode", "playlist").ifEmpty { "playlist" }
            srv.owner = { lan }
            l.watch = timer.scheduleAtFixedRate({
                if (lan === l && System.currentTimeMillis() - l.last > 60_000) lanStop()
            }, 10, 10, TimeUnit.SECONDS)
            lan = l
            return ok().put("ip", localIp()).put("port", port)
        }
        throw err ?: IllegalStateException("no free port")
    }

    @Synchronized
    private fun lanStop() {
        val l = lan ?: return
        lan = null
        l.watch?.cancel(false)
        try { l.server.stop() } catch (_: Exception) {}
    }

    private class LanServer(port: Int) : NanoHTTPD("0.0.0.0", port) {
        var owner: () -> Lan? = { null }

        private fun page(code: Int, html: String): Response =
            newFixedLengthResponse(Response.Status.lookup(code) ?: Response.Status.OK, "text/html; charset=utf-8", html).apply {
                addHeader("Cache-Control", "no-store")
            }

        override fun serve(session: IHTTPSession): Response {
            val l = owner() ?: return page(503, "stopped")
            val uri = session.uri ?: "/"
            if (session.method == Method.POST && uri.startsWith("/send")) {
                val files = HashMap<String, String>()
                try { session.parseBody(files) } catch (_: Exception) { return page(400, "bad request") }
                val v = session.parameters
                fun get(k: String) = v[k]?.firstOrNull() ?: ""
                if (get("code").trim() != l.code) return page(403, LanPage.render(l.texts, l.texts.optString("badCode"), false, l.mode))
                val item = JSONObject()
                if (l.mode == "yt") {
                    item.put("type", "yt").put("key", get("key").replace(Regex("\\s+"), "").take(200)).put("channels", get("channels").take(8000))
                } else {
                    item.put("type", if (get("type") == "xtream") "xtream" else "m3u")
                    for (k in listOf("name", "url", "server", "user", "pass", "epg")) item.put(k, get(k).trim().take(4000))
                }
                synchronized(l.inbox) {
                    l.inbox.add(item)
                    if (l.inbox.size > 5) l.inbox.removeAt(0)
                }
                return page(200, LanPage.render(l.texts, l.texts.optString("sent"), true, l.mode))
            }
            if (session.method == Method.GET && uri == "/") return page(200, LanPage.render(l.texts, "", false, l.mode))
            return page(404, "not found")
        }
    }

    /* ---------- YouTube host page over http://127.0.0.1 (YouTube refuses embeds from file://) ---------- */

    @Volatile private var yt: NanoHTTPD? = null
    @Volatile private var ytPort = 0

    @Synchronized
    private fun ytServe(): Int {
        if (yt != null) return ytPort
        val html = ctx.assets.open("yt.html").use { it.readBytes() }
        var err: Exception? = null
        for (port in 8900..8909) {
            val srv = object : NanoHTTPD("127.0.0.1", port) {
                override fun serve(session: IHTTPSession): Response {
                    if (session.uri != "/yt.html") return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
                    return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", String(html, Charsets.UTF_8)).apply {
                        addHeader("Cache-Control", "no-store")
                    }
                }
            }
            try { srv.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true) } catch (e: Exception) { err = e; continue }
            yt = srv
            ytPort = port
            return port
        }
        throw err ?: IllegalStateException("no free port")
    }

    fun shutdown() {
        lanStop()
        try { yt?.stop() } catch (_: Exception) {}
        yt = null
        for (j in jobs.values) j.close()
        jobs.clear()
        store.clear()
        timer.shutdownNow()
    }
}

object BuildConfigVersion {
    fun name(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (_: Exception) { "" }

    @Suppress("DEPRECATION")
    fun code(ctx: Context): Long = try {
        val i = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (android.os.Build.VERSION.SDK_INT >= 28) i.longVersionCode else i.versionCode.toLong()
    } catch (_: Exception) { 0L }
}
