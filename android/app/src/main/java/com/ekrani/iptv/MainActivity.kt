package com.ekrani.iptv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/* Ekrani IPTV for Android TV: the same web app as on webOS (assets/app, copied by tools/build-android.js),
   in a WebView. What webOS gives the app natively comes from here instead:
   - the luna bus (PalmServiceBridge) with the network service -> Service
   - the TV's video player -> ExoPlayer (VideoController), under the transparent page
   - remote buttons with webOS key codes -> dispatchKeyEvent */
@UnstableApi
class MainActivity : Activity() {
    lateinit var web: WebView
    private lateinit var video: VideoController
    private lateinit var service: Service
    private lateinit var updater: Updater
    private val pool = Executors.newCachedThreadPool()
    private val results = ConcurrentHashMap<Int, String>()
    private var stopped = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        val pv = PlayerView(this)
        root.addView(pv, FrameLayout.LayoutParams(1, 1))
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        immersive()     // needs the window's views

        service = Service(this)
        video = VideoController(this, pv)
        updater = Updater(this)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web.setBackgroundColor(Color.TRANSPARENT)
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.overScrollMode = View.OVER_SCROLL_NEVER
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        @Suppress("DEPRECATION")
        s.databaseEnabled = true
        s.allowFileAccess = true
        // the page runs from file:// like on webOS: no CORS limits for playlists and guides
        @Suppress("DEPRECATION")
        s.allowFileAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        s.allowUniversalAccessFromFileURLs = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.textZoom = 100
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.userAgentString = s.userAgentString + " EkraniAndroid/" + BuildConfigVersion.name(this)

        web.addJavascriptInterface(Native(), "EkraniNative")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("Ekrani", "${m.messageLevel()} ${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})")
                return true
            }
            // no grey "play" picture for <video> elements without a frame
            override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // the app page stays; links elsewhere open outside (if anything)
                if (!request.isForMainFrame || request.url.scheme == "file") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // the page's renderer died (out of memory): start again instead of crashing
                recreate()
                return true
            }
        }
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.requestFocus()
        web.loadUrl("file:///android_asset/app/index.html")
    }

    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    fun js(code: String) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            if (!isDestroyed) web.evaluateJavascript(code, null)
        } else runOnUiThread { if (!isDestroyed) web.evaluateJavascript(code, null) }
    }

    /* ---------- remote buttons ---------- */

    /* Android key -> webOS key code the app knows (app/js/util.js KEY). Arrows, OK, digits and
       Backspace reach the page by themselves; 0 = leave the key to Android (volume, Home…). */
    private fun webosKey(code: Int): Int = when (code) {
        KeyEvent.KEYCODE_BACK -> 461
        KeyEvent.KEYCODE_MENU -> 10013                 // = long OK: the context menu
        KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_MEDIA_NEXT -> 33
        KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_MEDIA_PREVIOUS -> 34
        KeyEvent.KEYCODE_PROG_RED -> 403
        KeyEvent.KEYCODE_PROG_GREEN -> 404
        KeyEvent.KEYCODE_PROG_YELLOW -> 405
        KeyEvent.KEYCODE_PROG_BLUE -> 406
        KeyEvent.KEYCODE_INFO -> 457
        KeyEvent.KEYCODE_GUIDE -> 458
        KeyEvent.KEYCODE_MEDIA_PLAY -> 415
        KeyEvent.KEYCODE_MEDIA_PAUSE -> 19
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> 179
        KeyEvent.KEYCODE_MEDIA_STOP -> 413
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> 417
        KeyEvent.KEYCODE_MEDIA_REWIND -> 412
        else -> 0
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val k = webosKey(e.keyCode)
        if (k != 0) {
            when (e.action) {
                KeyEvent.ACTION_DOWN -> js("window.__ekKey&&__ekKey($k,'keydown',${e.repeatCount > 0})")
                KeyEvent.ACTION_UP -> js("window.__ekKey&&__ekKey($k,'keyup',false)")
            }
            return true
        }
        if (!web.hasFocus()) web.requestFocus()
        return super.dispatchKeyEvent(e)
    }

    /* ---------- life cycle ---------- */

    override fun onStart() {
        super.onStart()
        if (stopped) {
            stopped = false
            js("window.__ekVis&&__ekVis(false)")
        }
    }

    override fun onStop() {
        stopped = true
        video.pause()
        js("window.__ekVis&&__ekVis(true)")
        super.onStop()
    }

    override fun onDestroy() {
        video.release()
        service.shutdown()
        pool.shutdownNow()
        try { web.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }

    /* the YouTube app for luna://com.webos.applicationManager/launch {params: {contentTarget: 'v=ID&t=Ns'}} */
    private fun launchYouTube(p: JSONObject): JSONObject {
        val target = p.optJSONObject("params")?.optString("contentTarget") ?: ""
        val q = HashMap<String, String>()
        for (kv in target.split('&')) { val i = kv.indexOf('='); if (i > 0) q[kv.substring(0, i)] = kv.substring(i + 1) }
        val v = q["v"] ?: throw IllegalArgumentException("no video")
        val t = (q["t"] ?: "").replace(Regex("\\D"), "")
        val uri = Uri.parse("https://www.youtube.com/watch?v=" + Uri.encode(v) + if (t.isNotEmpty()) "&t=$t" else "")
        val installed = listOf("com.google.android.youtube.tv", "com.google.android.youtube").firstOrNull {
            try { packageManager.getPackageInfo(it, 0); true } catch (_: Exception) { false }
        }
        val i = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (installed != null) i.setPackage(installed)
        runOnUiThread {
            try { startActivity(i) } catch (_: Exception) {
                try { startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
            }
        }
        return JSONObject().put("returnValue", true)
    }

    /* window.EkraniNative, used by android.js */
    inner class Native {
        @JavascriptInterface
        fun call(id: Int, uri: String, params: String) {
            pool.execute {
                val res = try {
                    val p = JSONObject(params.ifEmpty { "{}" })
                    when {
                        uri.startsWith("luna://com.ekrani.iptv.service/") -> service.call(uri.substringAfterLast('/'), p)
                        uri == "luna://com.webos.applicationManager/launch" -> launchYouTube(p)
                        else -> throw IllegalArgumentException("unsupported: $uri")
                    }
                } catch (e: Service.ServiceError) {
                    e.extra.put("returnValue", false).put("errorText", e.message)
                } catch (e: Throwable) {
                    Log.w("Ekrani", "service $uri failed", e)
                    val msg = e.message
                    JSONObject().put("returnValue", false).put("errorText",
                        if (msg.isNullOrEmpty()) e.javaClass.simpleName else if (e is java.net.UnknownHostException) "host not found: $msg" else msg)
                }
                results[id] = res.toString()
                js("window.__ekReply&&__ekReply($id)")
            }
        }

        /* the answer is fetched by the page itself: large bodies do not go through evaluateJavascript */
        @JavascriptInterface
        fun result(id: Int): String = results.remove(id) ?: "{\"returnValue\":false,\"errorText\":\"no result\"}"

        @JavascriptInterface
        fun video(json: String) {
            val c = try { JSONObject(json) } catch (_: Exception) { return }
            runOnUiThread { if (!isDestroyed) video.cmd(c) }
        }

        @JavascriptInterface
        fun exit() { runOnUiThread { finish() } }

        @JavascriptInterface
        fun versionCode(): Int = BuildConfigVersion.code(this@MainActivity).toInt()

        @JavascriptInterface
        fun versionName(): String = BuildConfigVersion.name(this@MainActivity)

        @JavascriptInterface
        fun installApk(url: String) { updater.install(url) }

        @JavascriptInterface
        fun isTv(): Boolean = packageManager.hasSystemFeature("android.software.leanback")
    }
}
