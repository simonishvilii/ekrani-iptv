package com.ekrani.iptv

import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/* HTTP GET as the webOS service does it (service/index.js): redirects followed by hand (also http <-> https),
   any certificate accepted (IPTV panels often have broken ones), gzip undone, including a gzip file body (.xml.gz). */
object Http {
    const val UA = "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 EkraniIPTV/1.0"

    private val trustAll: SSLSocketFactory by lazy {
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(tm), SecureRandom()) }.socketFactory
    }

    /* counts the bytes as received (still compressed), for the guide's progress bar */
    class Counting(input: InputStream) : FilterInputStream(input) {
        @Volatile var count = 0L
        override fun read(): Int { val b = super.read(); if (b >= 0) count++; return b }
        override fun read(b: ByteArray, off: Int, len: Int): Int { val n = super.read(b, off, len); if (n > 0) count += n; return n }
    }

    class Response(val conn: HttpURLConnection, val status: Int, val contentType: String, val length: Long, val raw: Counting) {
        /* the body as plain bytes */
        fun body(): InputStream {
            var s: InputStream = raw
            when ((conn.contentEncoding ?: "").lowercase()) {
                "gzip", "x-gzip" -> s = GZIPInputStream(s, 65536)
                "deflate" -> s = InflaterInputStream(s)
            }
            val b = BufferedInputStream(s, 65536)
            b.mark(4)
            val b0 = b.read()
            val b1 = b.read()
            b.reset()
            return if (b0 == 0x1f && b1 == 0x8b) GZIPInputStream(b, 65536) else b
        }

        fun close() {
            try { raw.close() } catch (_: Exception) {}
            try { conn.disconnect() } catch (_: Exception) {}
        }
    }

    fun open(url: String, headers: Map<String, String> = emptyMap(), readTimeout: Int = 60000): Response {
        var u = url
        var hops = 0
        while (true) {
            val target = URL(u)
            if (target.protocol != "http" && target.protocol != "https") throw IOException("Unsupported URL")
            val conn = target.openConnection() as HttpURLConnection
            if (conn is HttpsURLConnection) {
                conn.sslSocketFactory = trustAll
                conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
            }
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 20000
            conn.readTimeout = readTimeout
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Accept", "*/*")
            // set by hand, so the body arrives as sent and body() undoes it (also for .gz files)
            conn.setRequestProperty("Accept-Encoding", "gzip")
            for ((k, v) in headers) conn.setRequestProperty(k, v)
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location")
                if (loc != null) {
                    conn.disconnect()
                    if (++hops > 6) throw IOException("Too many redirects")
                    u = URL(target, loc).toString()
                    continue
                }
            }
            val stream = (if (code >= 400) conn.errorStream else conn.inputStream) ?: ByteArrayInputStream(ByteArray(0))
            val len = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: 0L
            return Response(conn, code, conn.contentType ?: "", len, Counting(stream))
        }
    }

    /* the whole body as text */
    fun download(url: String, headers: Map<String, String> = emptyMap()): Triple<Int, String, String> {
        val r = open(url, headers)
        try {
            val text = try {
                r.body().readBytes().toString(Charsets.UTF_8)
            } catch (e: java.io.EOFException) {
                ""   // empty body sent as gzip
            }
            return Triple(r.status, r.contentType, text)
        } finally {
            r.close()
        }
    }
}
