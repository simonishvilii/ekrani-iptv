package com.ekrani.iptv

import org.json.JSONObject

/* The phone page of "add from phone", the same HTML as lanPage()/ytForm() in service/index.js. */
object LanPage {
    private fun esc(v: String?): String {
        val s = v ?: ""
        val sb = StringBuilder(s.length + 16)
        for (c in s) when (c) {
            '&' -> sb.append("&amp;"); '<' -> sb.append("&lt;"); '>' -> sb.append("&gt;")
            '"' -> sb.append("&quot;"); '\'' -> sb.append("&#39;")
            else -> sb.append(c)
        }
        return sb.toString()
    }

    private fun f(id: String, label: String, type: String = "text", ph: String = ""): String =
        "<label id=\"f_$id\">" + esc(label) + "<input name=\"$id\" type=\"$type\" placeholder=\"" + esc(ph) +
            "\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\"></label>"

    fun render(texts: JSONObject, note: String, ok: Boolean, mode: String): String {
        fun t(k: String) = texts.optString(k)
        val title = if (mode == "yt" && t("ytTitle").isNotEmpty()) t("ytTitle") else t("title")
        val sb = StringBuilder()
        sb.append("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
        sb.append("<title>").append(esc(title)).append("</title><style>")
        sb.append("body{font:16px/1.4 system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}main{max-width:520px;margin:0 auto;padding:20px 16px}")
        sb.append("h1{font-size:20px;margin:0 0 16px}label{display:block;margin:0 0 14px;font-size:14px;color:#9aa7b4}")
        sb.append("input,select{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;font-size:16px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3}")
        sb.append("button{width:100%;padding:14px;font-size:17px;font-weight:600;border:0;border-radius:8px;background:#2f7cf6;color:#fff}")
        sb.append(".note{padding:12px;border-radius:8px;margin:0 0 16px;background:").append(if (ok) "#123d1f" else "#4a1515").append("}.hint{font-size:12px;color:#7d8590;margin-top:4px}")
        sb.append("</style></head><body><main><h1>").append(esc(title)).append("</h1>")
        if (note.isNotEmpty()) sb.append("<div class=\"note\">").append(esc(note)).append("</div>")
        if (mode == "yt") {
            sb.append("<form method=\"post\" action=\"/send\"><input type=\"hidden\" name=\"type\" value=\"yt\">")
            sb.append(f("key", t("ytKey"), "text", "AIza…"))
            sb.append("<label>").append(esc(t("ytChannels")))
            sb.append("<textarea name=\"channels\" rows=\"6\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"@channel&#10;https://www.youtube.com/@channel\" ")
            sb.append("style=\"display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;font-size:16px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3\"></textarea></label>")
            sb.append(f("code", t("codeHint"), "tel", "0000"))
            sb.append("<button type=\"submit\">").append(esc(t("send"))).append("</button></form></main>")
        } else {
            sb.append("<form method=\"post\" action=\"/send\">")
            sb.append("<label>").append(esc(t("type"))).append("<select name=\"type\" id=\"type\"><option value=\"m3u\">").append(esc(t("m3u")))
            sb.append("</option><option value=\"xtream\">").append(esc(t("xtream"))).append("</option></select></label>")
            sb.append(f("name", t("name"), "text", "My IPTV"))
            sb.append(f("url", t("url"), "url", "http://example.com/playlist.m3u"))
            sb.append(f("server", t("server"), "url", "http://host:8080")).append(f("user", t("user"))).append(f("pass", t("pass"), "password"))
            sb.append(f("epg", t("epg"), "text", "https://…/epg.xml.gz")).append("<div class=\"hint\">").append(esc(t("epgHint"))).append("</div><br>")
            sb.append(f("code", t("codeHint"), "tel", "0000"))
            sb.append("<button type=\"submit\">").append(esc(t("send"))).append("</button></form></main><script>")
            sb.append("var s=document.getElementById(\"type\");function u(){var x=s.value===\"xtream\";[\"url\"].forEach(function(i){document.getElementById(\"f_\"+i).style.display=x?\"none\":\"\"});")
            sb.append("[\"server\",\"user\",\"pass\"].forEach(function(i){document.getElementById(\"f_\"+i).style.display=x?\"\":\"none\"})}s.onchange=u;u();</script>")
        }
        sb.append("</body></html>")
        return sb.toString()
    }
}
