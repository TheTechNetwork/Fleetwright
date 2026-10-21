package network.thetech.fleetwright

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * A running VM's screen, in the app. docs/manage.md, "The console". Asked
 * for: "we should be able to connect to vm console". The same as iOS
 * (VMConsoleView.swift).
 *
 * THE PHONE HOLDS THE SOCKET, THE PAGE DRAWS IT. [XoConsole] opens Xen
 * Orchestra's console WebSocket with the pool's token and pin, the way the
 * pool page connects; the bundled page (assets/vnc.html, built from
 * src/vnc/page.js) runs noVNC on the bytes it is handed. The token never
 * enters the web view, the page may fetch nothing (its content security
 * policy), and the web view goes nowhere else: no navigation, no files.
 *
 * OFFERED ONLY WHILE THIS PHONE WATCHES THE POOL ITSELF (ComponentPage): a
 * page read through one of your machines has no socket to the pool here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConsolePage(settings: Settings, address: String, vm: String, name: String, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val console = remember(vm) { ConsoleBridge(settings, address, vm, name, scope) }
    DisposableEffect(console) { onDispose { console.stop() } }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Design.Palette.bg.now,
            topBar = {
                TopAppBar(
                    title = { Text(name) },
                    actions = { TextButton(onClick = onDismiss) { Text("Done") } },
                )
            },
            bottomBar = {
                BottomAppBar(containerColor = Design.Palette.card.now) {
                    TextButton(onClick = { console.keyboard() }, enabled = console.connected, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(Manage.Words.keyboard)
                    }
                    Row(Modifier.weight(1f)) {}
                    TextButton(onClick = { console.ctrlAltDel() }, enabled = console.connected, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(Manage.Words.ctrlAltDel)
                    }
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                console.line?.let { line ->
                    Column(
                        Modifier.fillMaxWidth().background(Design.Palette.card.now).padding(Design.Space.inside),
                        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(line, style = Design.Style.label, color = if (console.troubled) Design.Palette.bad.now else Design.Palette.inkDim.now)
                        if (console.retry) {
                            TextButton(onClick = { console.restart() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(Manage.Words.openAgain) }
                        }
                    }
                }
                AndroidView(
                    factory = { context -> console.makeWeb(context) },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/** The console's state, and the bridge between the socket and the page. */
internal class ConsoleBridge(
    private val settings: Settings,
    private val address: String,
    private val vm: String,
    private val name: String,
    private val scope: CoroutineScope,
) {
    /** What the console is doing, said above it; null once the screen shows. */
    var line by mutableStateOf<String?>(Manage.Words.consoleOpening(name))
        private set
    var troubled by mutableStateOf(false)
        private set
    var retry by mutableStateOf(false)
        private set
    var connected by mutableStateOf(false)
        private set

    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var socket: XoConsole? = null
    private var pageReady = false

    @SuppressLint("SetJavaScriptEnabled")
    fun makeWeb(context: Context): WebView = WebView(context).also { w ->
        w.settings.javaScriptEnabled = true
        w.settings.allowFileAccess = false
        w.settings.allowContentAccess = false
        w.settings.domStorageEnabled = false
        w.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Nowhere else: the page is the only thing this web view shows.
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        w.addJavascriptInterface(Page(), "FleetwrightBridge")
        web = w
        load()
    }

    /** The page, from the assets, under BASE (scripts/build-vnc.mjs). */
    private fun load() {
        val w = web ?: return
        val html = w.context.assets.open("vnc.html").use { it.readBytes().toString(Charsets.UTF_8) }
        w.loadDataWithBaseURL(BASE, html, "text/html", "utf-8", null)
    }

    fun restart() {
        socket?.close()
        socket = null
        connected = false
        pageReady = false
        show(Manage.Words.consoleOpening(name))
        load()
    }

    fun stop() {
        socket?.close()
        socket = null
        web?.destroy()
        web = null
    }

    /** The keyboard, to the page's own typing field. */
    fun keyboard() {
        val w = web ?: return
        w.requestFocus()
        call("fwConsole.keyboard()")
        val ime = w.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        ime.showSoftInput(w, InputMethodManager.SHOW_IMPLICIT)
    }

    fun ctrlAltDel() = call("fwConsole.ctrlAltDel()")

    /** What the page said, on the main thread. */
    private fun fromPage(m: JSONObject) {
        when (m.optString("t")) {
            "send" -> socket?.send(android.util.Base64.decode(m.optString("b"), android.util.Base64.DEFAULT))
            "close" -> {
                socket?.close()
                socket = null
            }
            "state" -> when (m.optString("s")) {
                "ready" -> {
                    pageReady = true
                    open()
                }
                "connected" -> {
                    connected = true
                    show(null)
                }
                "ended" -> ended(Manage.Words.consoleEnded)
                "refused" -> ended(Manage.Words.consoleRefused(m.optString("why").ifBlank { "it gave no reason" }))
            }
        }
    }

    private fun open() {
        if (!pageReady || socket != null) return
        // The record the pool page connects with: the token, and the pin it
        // is only ever sent behind.
        val record = settings.secret(XoHandoff.tokenName(address))?.let { Manage.record(it, address) }
        val pin = record?.pin
        if (record == null || record.plain || pin == null) {
            ended(Manage.Words.consoleShut)
            return
        }
        scope.launch {
            val opened = try {
                XoConsole.open(address, pin, record.token, vm)
            } catch (e: XoLink.Failure) {
                if (e.kind == XoLink.Failure.Kind.WRONG_CERTIFICATE) show(Manage.Words.wrongCertificate(address), troubled = true, retry = false)
                else ended(Manage.Words.consoleShut)
                return@launch
            } catch (e: Exception) {
                ended(Manage.Words.consoleShut)
                return@launch
            }
            if (web == null) {
                opened.close()
                return@launch
            }
            // IN ORDER, through the main looper: VNC is a stream, and a frame
            // handed over out of turn corrupts every one after it.
            opened.onData = { bytes ->
                val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                main.post { call("fwConsole.data('$b64')") }
            }
            opened.onEnd = { why -> main.post { socketEnded(why) } }
            socket = opened
            call("fwConsole.opened()")
            opened.start()
        }
    }

    private fun socketEnded(why: String) {
        socket = null
        call("fwConsole.closed(${quoted(why)})")
        // Closed before the screen came: Xen Orchestra refusing the token's
        // user, most likely, which it does by closing.
        ended(if (connected) Manage.Words.consoleEnded else Manage.Words.consoleShut)
    }

    private fun ended(said: String) {
        if (line != null && retry) return
        connected = false
        show(said, troubled = true, retry = true)
    }

    private fun show(said: String?, troubled: Boolean = false, retry: Boolean = false) {
        line = said
        this.troubled = troubled
        this.retry = retry
    }

    private fun call(js: String) {
        web?.evaluateJavascript(js, null)
    }

    /** What the page calls, on a binder thread: handed to the main thread. */
    private inner class Page {
        @JavascriptInterface
        fun post(json: String) {
            val m = runCatching { JSONObject(json) }.getOrNull() ?: return
            main.post { fromPage(m) }
        }
    }

    companion object {
        /** The address the page is loaded under: https, so it is a secure context, and resolving nowhere. BASE in scripts/build-vnc.mjs. */
        const val BASE = "https://console.fleetwright.invalid/"

        /** A string as a JavaScript literal. */
        fun quoted(s: String): String = JSONArray().put(s).toString().let { it.substring(1, it.length - 1) }
    }
}
