package com.ekrani.iptv

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/* App update: downloads the new APK from GitHub and opens the system installer.
   Progress goes to the page as window.__ekApk({st: 'progress'|'install'|'perm'|'old'|'error', p, msg}). */
class Updater(private val act: MainActivity) {
    @Volatile private var busy = false

    private fun report(o: JSONObject) = act.js("window.__ekApk&&__ekApk(" + o.toString() + ")")

    fun install(url: String) {
        if (busy) return
        // Android 8+: the user has to allow this app to install apps once (Settings opens for it)
        if (Build.VERSION.SDK_INT >= 26 && !act.packageManager.canRequestPackageInstalls()) {
            report(JSONObject().put("st", "perm"))
            act.runOnUiThread {
                try {
                    act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.packageName)))
                } catch (_: Exception) {
                    try { act.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) } catch (_: Exception) {}
                }
            }
            return
        }
        busy = true
        Thread {
            try {
                val dir = if (Build.VERSION.SDK_INT >= 24) File(act.cacheDir, "updates") else (act.externalCacheDir ?: act.cacheDir)
                dir.mkdirs()
                val file = File(dir, "ekrani-iptv.apk")
                file.delete()
                val r = Http.open(url, readTimeout = 60000)
                try {
                    if (r.status >= 400) throw Exception("HTTP " + r.status)
                    val total = r.length
                    var last = 0L
                    file.outputStream().use { out ->
                        val buf = ByteArray(65536)
                        var got = 0L
                        val input = r.raw
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            val now = System.currentTimeMillis()
                            if (now - last > 400) {
                                last = now
                                report(JSONObject().put("st", "progress").put("p", if (total > 0) got.toDouble() / total else 0.0).put("bytes", got))
                            }
                        }
                    }
                } finally {
                    r.close()
                }
                // only a newer version of this very app (the download may still be an old cached copy)
                @Suppress("DEPRECATION")
                val info = act.packageManager.getPackageArchiveInfo(file.path, 0) ?: throw Exception("bad file")
                @Suppress("DEPRECATION")
                val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
                if (info.packageName != act.packageName) throw Exception("wrong package")
                if (code <= BuildConfigVersion.code(act)) {
                    report(JSONObject().put("st", "old"))
                    return@Thread
                }
                if (Build.VERSION.SDK_INT < 24) file.setReadable(true, false)
                val uri = if (Build.VERSION.SDK_INT >= 24) FileProvider.getUriForFile(act, act.packageName + ".files", file) else Uri.fromFile(file)
                report(JSONObject().put("st", "install"))
                act.runOnUiThread {
                    val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    try { act.startActivity(i) } catch (e: Exception) { report(JSONObject().put("st", "error").put("msg", e.message ?: "installer")) }
                }
            } catch (e: Throwable) {
                report(JSONObject().put("st", "error").put("msg", e.message ?: e.javaClass.simpleName))
            } finally {
                busy = false
            }
        }.start()
    }
}
