package com.ekrani.iptv

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject

/* ExoPlayer in place of the page's <video>: the web app talks to it through the NativeVideo object of
   android.js (same properties and events as a video element). The picture is a native view under the
   transparent WebView; android.js leaves a hole in the page where the video layer is. */
@UnstableApi
class VideoController(private val act: MainActivity, private val view: PlayerView) : Player.Listener {
    private var player: ExoPlayer? = null
    private var url = ""
    private var triedHls = false
    private var metaSent = false
    private var wasReady = false
    private var gen = 0               // the page's source number: events of an earlier source are ignored there
    private val main = Handler(Looper.getMainLooper())
    private val window = Timeline.Window()

    private val ticker = object : Runnable {
        override fun run() {
            val p = player
            if (p != null && p.isPlaying) emit("timeupdate")
            main.postDelayed(this, 250)
        }
    }

    init {
        view.useController = false
        view.isFocusable = false
        view.descendantFocusability = android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS
        view.setShutterBackgroundColor(android.graphics.Color.BLACK)
        view.setKeepContentOnPlayerReset(false)
        view.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        view.visibility = View.INVISIBLE
        main.post(ticker)
    }

    private fun ensure(): ExoPlayer {
        player?.let { return it }
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(Http.UA)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(act, http))
        val renderers = DefaultRenderersFactory(act).setEnableDecoderFallback(true)
        val load = DefaultLoadControl.Builder().setBufferDurationsMs(15000, 50000, 1500, 3000).build()
        val p = ExoPlayer.Builder(act, renderers)
            .setMediaSourceFactory(sources)
            .setLoadControl(load)
            .build()
        p.addListener(this)
        view.player = p
        player = p
        return p
    }

    /* commands from android.js */
    fun cmd(c: JSONObject) {
        if (c.has("g")) gen = c.optInt("g")
        when (c.optString("op")) {
            "open" -> open(c.optString("url"), false)
            "stop" -> stop()
            "play" -> {
                val p = player ?: return
                if (p.playbackState == Player.STATE_IDLE && p.mediaItemCount > 0) p.prepare()
                if (p.playbackState == Player.STATE_ENDED) p.seekToDefaultPosition()
                p.playWhenReady = true
            }
            "pause" -> { player?.playWhenReady = false; emit("pause") }
            "seek" -> seek(c.optDouble("t", 0.0))
            "fit" -> view.resizeMode = when (c.optString("v")) {
                "cover" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
            "audio" -> selectTrack(C.TRACK_TYPE_AUDIO, c.optInt("i", -1))
            "text" -> selectTrack(C.TRACK_TYPE_TEXT, c.optInt("i", -1))
            "place" -> place(c.optString("mode"), c.optInt("x"), c.optInt("y"), c.optInt("w"), c.optInt("h"))
        }
    }

    private fun open(u: String, asHls: Boolean) {
        val p = ensure()
        url = u
        triedHls = asHls
        metaSent = false
        wasReady = false
        val item = MediaItem.Builder().setUri(Uri.parse(u))
        if (asHls) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        p.playWhenReady = false          // like a video element: plays after play()
        p.setMediaItem(item.build())
        p.prepare()
        emit("loadstart")
    }

    private fun stop() {
        url = ""
        val p = player ?: return
        p.playWhenReady = false
        p.stop()
        p.clearMediaItems()
        keepOn(false)
    }

    /* times are seconds from the start of the stream's first period, like a browser's currentTime */
    private fun windowStart(p: ExoPlayer): Long {
        val tl = p.currentTimeline
        if (tl.isEmpty) return 0
        tl.getWindow(p.currentMediaItemIndex, window)
        return window.positionInFirstPeriodMs.coerceAtLeast(0)
    }

    private fun seek(t: Double) {
        val p = player ?: return
        p.seekTo(((t * 1000).toLong() - windowStart(p)).coerceAtLeast(0))
        emit("seeking")
    }

    private fun groups(type: Int): List<Tracks.Group> =
        (player?.currentTracks?.groups ?: emptyList()).filter { it.type == type && it.length > 0 }

    private fun selectTrack(type: Int, i: Int) {
        val p = player ?: return
        val g = groups(type)
        val b = p.trackSelectionParameters.buildUpon()
        if (i < 0 || i >= g.size) {
            if (type == C.TRACK_TYPE_TEXT) b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            b.setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(g[i].mediaTrackGroup, 0))
        }
        p.trackSelectionParameters = b.build()
    }

    private fun place(mode: String, x: Int, y: Int, w: Int, h: Int) {
        val lp = view.layoutParams as FrameLayout.LayoutParams
        when (mode) {
            "full" -> {
                lp.width = FrameLayout.LayoutParams.MATCH_PARENT; lp.height = FrameLayout.LayoutParams.MATCH_PARENT
                lp.leftMargin = 0; lp.topMargin = 0
            }
            "preview" -> {
                lp.width = maxOf(1, w); lp.height = maxOf(1, h)
                lp.leftMargin = x; lp.topMargin = y
            }
        }
        view.layoutParams = lp
        view.visibility = if (mode == "hidden") View.INVISIBLE else View.VISIBLE
    }

    private fun keepOn(on: Boolean) {
        if (on) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun state(): JSONObject {
        val o = JSONObject().put("g", gen)
        val p = player
        if (p == null || url.isEmpty()) {
            return o.put("t", 0).put("d", -2).put("p", true).put("rs", 0).put("vh", 0).put("vw", 0)
                .put("ss", 0).put("se", 0).put("at", JSONArray()).put("tt", JSONArray())
        }
        val ws = windowStart(p)
        val tl = p.currentTimeline
        var dynamic = false
        var winDur = C.TIME_UNSET
        if (!tl.isEmpty) {
            tl.getWindow(p.currentMediaItemIndex, window)
            dynamic = window.isDynamic
            winDur = window.durationMs
        }
        val dur = p.duration
        o.put("t", (ws + p.currentPosition) / 1000.0)
        // -1 = Infinity (live), -2 = NaN (not known yet)
        o.put("d", if (dynamic) -1.0 else if (dur == C.TIME_UNSET) -2.0 else dur / 1000.0)
        o.put("ss", ws / 1000.0)
        o.put("se", (ws + (if (winDur != C.TIME_UNSET) winDur else if (dur != C.TIME_UNSET) dur else p.bufferedPosition)) / 1000.0)
        o.put("p", !p.playWhenReady)
        o.put("rs", when (p.playbackState) {
            Player.STATE_READY, Player.STATE_ENDED -> 4
            Player.STATE_BUFFERING -> if (metaSent) 2 else 0
            else -> 0
        })
        o.put("vh", p.videoSize.height).put("vw", p.videoSize.width)
        o.put("ended", p.playbackState == Player.STATE_ENDED)
        o.put("at", trackList(C.TRACK_TYPE_AUDIO))
        o.put("tt", trackList(C.TRACK_TYPE_TEXT))
        p.playerError?.let { o.put("err", it.errorCode).put("errMsg", it.errorCodeName) }
        return o
    }

    private fun trackList(type: Int): JSONArray {
        val a = JSONArray()
        for (g in groups(type)) {
            val f = g.getTrackFormat(0)
            a.put(JSONArray().put(f.label ?: "").put(f.language ?: "").put(g.isSelected))
        }
        return a
    }

    private fun emit(ev: String) {
        act.js("window.__ekVideo&&__ekVideo('$ev'," + state().toString() + ")")
    }

    /* ---------- player events ---------- */

    override fun onPlaybackStateChanged(state: Int) {
        when (state) {
            Player.STATE_BUFFERING -> if (wasReady) emit("waiting")
            Player.STATE_READY -> {
                if (!metaSent) {
                    metaSent = true
                    emit("loadedmetadata")
                    emit("loadeddata")
                }
                wasReady = true
                emit("canplay")
            }
            Player.STATE_ENDED -> { keepOn(false); emit("ended") }
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        keepOn(isPlaying)
        if (isPlaying) emit("playing")
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) { emit("resize") }

    override fun onTracksChanged(tracks: Tracks) { emit("tracks") }

    override fun onPlayerError(error: PlaybackException) {
        // a stream without .m3u8 in its address that is HLS anyway: try once more as HLS
        if (!triedHls && url.isNotEmpty() && (error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ||
                error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)) {
            val keep = player?.playWhenReady ?: true
            open(url, true)
            player?.playWhenReady = keep
            return
        }
        keepOn(false)
        emit("error")
    }

    /* app to the background: stop the picture right away (the page may be throttled) */
    fun pause() { player?.playWhenReady = false }

    fun release() {
        main.removeCallbacks(ticker)
        player?.release()
        player = null
        view.player = null
    }
}
