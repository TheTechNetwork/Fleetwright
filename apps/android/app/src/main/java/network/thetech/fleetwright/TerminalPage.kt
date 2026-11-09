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
import androidx.compose.foundation.shape.RoundedCornerShape
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

/** What the terminal says, in both apps' words (iOS's TerminalWords). */
internal object TerminalWords {
    const val OPEN = "Open a terminal"
    fun opening(machine: String) = "Connecting to $machine…"
    const val AWAY = "Connecting through one of your machines…"
    const val NEEDS_KEY = "This machine doesn’t have this phone’s key. Add it to your vault, and machines made after that take it."
    const val ADD_KEY = "Add this phone’s key"
    const val ADDING = "Adding…"
    const val ADDED = "Added. Machines made from now on take this phone’s key; this one was made before."
    fun ended(why: String) = "The terminal closed: $why."
    const val PHONE_HEADER = "This phone"
    const val PHONE_KEPT = "This phone’s key is in your vault."
    const val PHONE_FOOTER = "The terminal on a machine’s page signs in with a key made on this phone, which never leaves it; its public half goes in your vault beside the keys above. Machines made after you add it take it."
}

/**
 * A terminal on a machine of yours, in the app, over SSH as `fleetwright`
 * with this phone's own key. docs/hypervisors.md, "SSH in the app". The same
 * as iOS (SSHTerminalView.swift).
 *
 * THE PHONE HOLDS THE SSH, THE PAGE DRAWS IT: [SshTerminal] speaks SSH with
 * the key, and the bundled page (assets/term.html, built from
 * src/term/page.js) runs xterm.js on the bytes it is handed. The key never
 * enters the web view, the page may fetch nothing, and the web view goes
 * nowhere else.
 *
 * ON THE MACHINE'S NETWORK FIRST, THEN THROUGH ONE OF YOUR MACHINES
 * (ConsoleTunnel, naming the machine) when it does not answer from here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TerminalPage(settings: Settings, machine: String, address: String, ip: String, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val term = remember(machine) { TerminalBridge(settings, machine, address, ip, scope) }
    DisposableEffect(term) { onDispose { term.stop() } }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Design.Palette.bg.now,
            topBar = {
                TopAppBar(
                    title = { Text(machine) },
                    actions = { TextButton(onClick = onDismiss) { Text("Done") } },
                )
            },
            bottomBar = {
                BottomAppBar(containerColor = Design.Palette.card.now) {
                    TextButton(onClick = { term.keyboard() }, enabled = term.connected, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(Manage.Words.keyboard)
                    }
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                term.line?.let { line ->
                    Column(
                        Modifier.fillMaxWidth().background(Design.Palette.card.now).padding(Design.Space.inside),
                        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(line, style = Design.Style.label, color = if (term.troubled) Design.Palette.bad.now else Design.Palette.inkDim.now)
                        if (term.needsKey) {
                            TextButton(onClick = { term.addKey() }, enabled = !term.adding, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text(if (term.adding) TerminalWords.ADDING else TerminalWords.ADD_KEY)
                            }
                        } else if (term.retry) {
                            TextButton(onClick = { term.restart() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(Manage.Words.openAgain) }
                        }
                    }
                } ?: term.via?.let { via ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = Design.Space.inside, vertical = Design.Space.insideTight)) {
                        Text(
                            Manage.Words.consoleAwayVia(via),
                            style = Design.Style.micro,
                            color = Design.Palette.inkDim.now,
                            modifier = Modifier
                                .background(Design.Palette.card.now, RoundedCornerShape(Design.Radius.chip))
                                .padding(horizontal = Design.Space.insideTight, vertical = Design.Space.hair),
                        )
                    }
                }
                AndroidView(factory = { context -> term.makeWeb(context) }, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

/** The terminal's state, and the bridge between the SSH and the page. */
internal class TerminalBridge(
    private val settings: Settings,
    private val machine: String,
    private val address: String,
    private val ip: String,
    private val scope: CoroutineScope,
) {
    var line by mutableStateOf<String?>(TerminalWords.opening(machine))
        private set
    var via by mutableStateOf<String?>(null)
        private set
    var troubled by mutableStateOf(false)
        private set
    var retry by mutableStateOf(false)
        private set
    var needsKey by mutableStateOf(false)
        private set
    var adding by mutableStateOf(false)
        private set
    var connected by mutableStateOf(false)
        private set

    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var ssh: SshTerminal? = null
    private var tunnel: ConsoleTunnel? = null
    private var away = false
    private var pageReady = false
    private var cols = 80
    private var rows = 24

    @SuppressLint("SetJavaScriptEnabled")
    fun makeWeb(context: Context): WebView = WebView(context).also { w ->
        w.settings.javaScriptEnabled = true
        w.settings.allowFileAccess = false
        w.settings.allowContentAccess = false
        w.settings.domStorageEnabled = false
        w.setBackgroundColor(android.graphics.Color.BLACK)
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        w.addJavascriptInterface(Page(), "FleetwrightBridge")
        web = w
        load()
    }

    private fun load() {
        val w = web ?: return
        val html = w.context.assets.open("term.html").use { it.readBytes().toString(Charsets.UTF_8) }
        w.loadDataWithBaseURL(BASE, html, "text/html", "utf-8", null)
    }

    fun restart() {
        stop()
        away = false
        pageReady = false
        connected = false
        show(TerminalWords.opening(machine))
        load()
    }

    fun stop() {
        ssh?.close()
        ssh = null
        tunnel?.close()
        tunnel = null
    }

    fun keyboard() {
        val w = web ?: return
        w.requestFocus()
        call("fwTerm.focus()")
        val ime = w.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        ime.showSoftInput(w, InputMethodManager.SHOW_IMPLICIT)
    }

    fun addKey() {
        adding = true
        scope.launch {
            PhoneSshKey.add(settings).onSuccess {
                adding = false
                needsKey = false
                show(TerminalWords.ADDED, troubled = false, retry = true)
            }.onFailure {
                adding = false
                show(it.message ?: "that did not work", troubled = true, retry = false)
                needsKey = true
            }
        }
    }

    private fun fromPage(m: JSONObject) {
        when (m.optString("t")) {
            "state" -> if (m.optString("s") == "ready") {
                pageReady = true
                open()
            }
            "input" -> ssh?.let { s ->
                val bytes = android.util.Base64.decode(m.optString("d"), android.util.Base64.DEFAULT)
                Thread { s.send(bytes) }.start()
            }
            "size" -> {
                val c = m.optInt("cols")
                val r = m.optInt("rows")
                if (c > 0 && r > 0) {
                    cols = c
                    rows = r
                    ssh?.resize(c, r)
                }
            }
        }
    }

    private fun open() {
        if (!pageReady || ssh != null) return
        scope.launch {
            var host = ip
            var port = 22
            if (away) {
                show(TerminalWords.AWAY)
                val t = ConsoleTunnel(address, machine)
                tunnel = t
                t.onEnd = { why -> main.post { if (tunnel === t) ended(why, refusedKey = false) } }
                try {
                    val (p, carrier) = t.openPort(settings)
                    host = "127.0.0.1"
                    port = p
                    via = carrier
                } catch (e: Exception) {
                    if (tunnel === t) tunnel = null
                    show(e.message ?: "the tunnel did not open", troubled = true, retry = true)
                    return@launch
                }
            }
            val terminal = SshTerminal(settings, machine, host, port)
            terminal.onData = { bytes ->
                val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                main.post { call("fwTerm.data('$b64')") }
            }
            terminal.onEnd = { why, refused -> main.post { ended(why, refused) } }
            ssh = terminal
            try {
                terminal.open(cols, rows)
            } catch (e: SshTerminal.KeyRefused) {
                ssh = null
                ended(e.message ?: "", refusedKey = true)
                return@launch
            } catch (e: Exception) {
                ssh = null
                // NOT ANSWERED FROM HERE: once, through one of your machines.
                if (!away) {
                    away = true
                    open()
                } else {
                    ended(e.message ?: "it did not connect", refusedKey = false)
                }
                return@launch
            }
            connected = true
            show(null)
            call("fwTerm.opened()")
        }
    }

    private fun ended(why: String, refusedKey: Boolean) {
        ssh = null
        connected = false
        tunnel?.close()
        tunnel = null
        call("fwTerm.closed(${quoted(why)})")
        if (refusedKey) {
            needsKey = true
            show(TerminalWords.NEEDS_KEY, troubled = true, retry = false)
        } else {
            show(TerminalWords.ended(why), troubled = true, retry = true)
        }
    }

    private fun show(said: String?, troubled: Boolean = false, retry: Boolean = false) {
        line = said
        this.troubled = troubled
        this.retry = retry
    }

    private fun call(js: String) {
        web?.evaluateJavascript(js, null)
    }

    private inner class Page {
        @JavascriptInterface
        fun post(json: String) {
            val m = runCatching { JSONObject(json) }.getOrNull() ?: return
            main.post { fromPage(m) }
        }
    }

    companion object {
        /** The address the page is loaded under, as the console's is: https, resolving nowhere. */
        const val BASE = "https://terminal.fleetwright.invalid/"

        fun quoted(s: String): String = JSONArray().put(s).toString().let { it.substring(1, it.length - 1) }
    }
}
