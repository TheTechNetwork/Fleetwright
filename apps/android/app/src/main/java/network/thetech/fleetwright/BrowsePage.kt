package network.thetech.fleetwright

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import java.util.concurrent.Executor

/**
 * The words of a page through a machine, in one place. The same sentences as
 * iOS's BrowseWords (BrowseView.swift); test/browse-in-apps.test.js holds the
 * two to each other.
 */
internal object BrowseWords {
    const val OPEN_PORT = "Open a port"
    const val BROWSE = "Browse"
    const val PAGES_HEAD = "Pages through this machine"
    const val PORT_TITLE = "Open a port"
    const val PORT_FIELD = "Port"
    const val PORT_HINT = "What the session is serving on, such as 3000 or 5173."
    const val PORT_OPEN = "Open"
    const val ADDRESS_FIELD = "Address"
    const val GO = "Go"
    const val BACK = "Back"
    const val FORWARD = "Forward"
    const val RELOAD = "Reload"
    const val OPEN_AGAIN = "Open again"
    const val NOT_SECURE = "Not secure: this page is readable on its way through the machine."
    const val LOST = "Lost the connection."
    const val CLOSED = "The page closed."
    const val COULD_NOT_CONNECT = "Couldn't connect."
    const val LISTED_HEAD = "This machine opens"
    const val WEB = "The web, on ports 80 and 443"
    const val NO_PROXY = "This phone's web view cannot be pointed through a machine. Update Android System WebView and open it again."

    fun opening(host: String) = "Opening through $host…"
    fun through(host: String) = "Through $host"
    fun session(name: String, host: String) = "$name on $host"

    /** What a machine opens, in one line, for its page. */
    fun opensLine(web: Boolean, hosts: List<String>): String {
        val count = if (hosts.size == 1) "1 address" else "${hosts.size} addresses"
        return when {
            web && hosts.isEmpty() -> "Opens the web on ports 80 and 443."
            web -> "Opens the web on ports 80 and 443, and $count on its network."
            else -> "Opens $count on its network."
        }
    }

    /**
     * An address as typed, made a URL: `localhost`, an address and a name
     * the machine lists go as plain HTTP, which is what they usually serve;
     * anything else is asked for over HTTPS.
     */
    fun url(typed: String, listed: List<String>): String? {
        val text = typed.trim()
        if (text.isEmpty()) return null
        if (text.contains("://")) return text
        val hostPart = text.substringBefore('/')
        val bare = hostPart.substringBefore(':').lowercase()
        val plain = bare == "localhost" || bare.all { it.isDigit() || it == '.' } || listed.any { it.lowercase().startsWith(bare) }
        return (if (plain) "http://" else "https://") + text
    }

    /** A listed entry that can be opened as it is: a name or an address, with its port if it has one. A range is said, not opened. */
    fun openable(entry: String): String? = if (entry.contains('/')) null else "http://$entry"
}

/**
 * A web view whose connections leave from one of your machines.
 * docs/browse.md. Asked for: "Web view that proxies any web page through one
 * of our hosts?", then "All 3 combined": a session's own ports, the names a
 * machine's owner listed, and the public web where its owner turned it on.
 * The same as iOS (BrowseView.swift).
 *
 * THE PROXY IS SET FOR THIS SCREEN AND TAKEN OFF WHEN IT CLOSES. Android
 * points every web view in the app at it (ProxyController), and no other web
 * view in the app reaches the network; cookies, storage and the cache are
 * cleared when it closes, so nothing outlives the screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BrowsePage(settings: Settings, host: String, session: String?, start: String? = null, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val page = remember(host, session) { BrowseBridge(settings, host, session, start, scope) }
    DisposableEffect(page) { onDispose { page.stop() } }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Design.Palette.bg.now,
            topBar = {
                TopAppBar(
                    title = { Text(session?.let { BrowseWords.session(it, host) } ?: BrowseWords.through(host)) },
                    actions = { TextButton(onClick = onDismiss) { Text("Done") } },
                )
            },
            bottomBar = {
                BottomAppBar(containerColor = Design.Palette.card.now) {
                    TextButton(onClick = { page.back() }, enabled = page.canGoBack, modifier = Modifier.heightIn(min = 48.dp)) { Text(BrowseWords.BACK) }
                    TextButton(onClick = { page.forward() }, enabled = page.canGoForward, modifier = Modifier.heightIn(min = 48.dp)) { Text(BrowseWords.FORWARD) }
                    Row(Modifier.weight(1f)) {}
                    TextButton(onClick = { page.reload() }, enabled = page.showsPage, modifier = Modifier.heightIn(min = 48.dp)) { Text(BrowseWords.RELOAD) }
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                Column(
                    Modifier.fillMaxWidth().background(Design.Palette.card.now)
                        .padding(horizontal = Design.Space.inside, vertical = Design.Space.insideTight),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        OutlinedTextField(
                            value = page.typed,
                            onValueChange = { page.typed = it },
                            label = { Text(BrowseWords.ADDRESS_FIELD) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                            keyboardActions = KeyboardActions(onGo = { page.go() }),
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = { page.go() },
                            enabled = page.connected && page.typed.isNotBlank(),
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(BrowseWords.GO) }
                    }
                    if (page.insecure) {
                        Text(BrowseWords.NOT_SECURE, style = Design.Style.micro, color = Design.Palette.attention.now)
                    }
                }
                page.line?.let { line ->
                    Column(
                        Modifier.fillMaxWidth().background(Design.Palette.card.now).padding(Design.Space.inside),
                        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(line, style = Design.Style.label, color = if (page.troubled) Design.Palette.bad.now else Design.Palette.inkDim.now)
                        if (page.retry) {
                            TextButton(onClick = { page.restart() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(BrowseWords.OPEN_AGAIN) }
                        }
                    }
                }
                Box(Modifier.fillMaxSize()) {
                    if (page.connected) {
                        // A NEW WEB VIEW FOR A NEW PROXY: keyed on it, so Open
                        // again does not keep pages that came through a socket
                        // that is gone.
                        androidx.compose.runtime.key(page.generation) {
                            AndroidView(
                                factory = { context -> page.makeWeb(context) },
                                modifier = Modifier.fillMaxSize().alpha(if (page.showsPage) 1f else 0f),
                            )
                        }
                    }
                    val opens = page.opens
                    if (page.connected && !page.showsPage && opens != null && (opens.web || opens.hosts.isNotEmpty())) {
                        LazyColumn(
                            Modifier.fillMaxSize().padding(Design.Space.inside),
                            verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            item { Text(BrowseWords.LISTED_HEAD, style = Design.Style.label, color = Design.Palette.inkDim.now) }
                            if (opens.web) item { Text(BrowseWords.WEB, style = Design.Style.body, color = Design.Palette.ink.now) }
                            items(opens.hosts) { entry ->
                                val url = BrowseWords.openable(entry)
                                if (url != null) {
                                    TextButton(onClick = { page.load(url) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(entry) }
                                } else {
                                    Text(entry, style = Design.Style.label, color = Design.Palette.inkDim.now)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The socket, the proxy, the web view and the page's state. */
internal class BrowseBridge(
    private val settings: Settings,
    private val host: String,
    private val session: String?,
    start: String?,
    private val scope: CoroutineScope,
) {
    var typed by mutableStateOf(start ?: "")
    /** What the screen is doing, said above the page; null once a page shows. */
    var line by mutableStateOf<String?>(BrowseWords.opening(host))
        private set
    var troubled by mutableStateOf(false)
        private set
    var retry by mutableStateOf(false)
        private set
    var connected by mutableStateOf(false)
        private set
    var showsPage by mutableStateOf(false)
        private set
    var insecure by mutableStateOf(false)
        private set
    var canGoBack by mutableStateOf(false)
        private set
    var canGoForward by mutableStateOf(false)
        private set
    var opens by mutableStateOf<BrowseTunnel.Opens?>(null)
        private set
    /** Bumped for each new proxy: the web view is made again for it. */
    var generation by mutableStateOf(0)
        private set

    private val main = Handler(Looper.getMainLooper())
    private val onMain = Executor { main.post(it) }
    private var tunnel: BrowseTunnel? = null
    private var web: WebView? = null
    /** Applied to the app's web views: the page is loaded only after. */
    private var proxied = false
    private var pending: String? = null
    /** The last thing the machine refused, shown when a page does not load. */
    @Volatile private var refused: String? = null

    init {
        restart()
    }

    fun restart() {
        tunnel?.close()
        dropWeb()
        line = BrowseWords.opening(host)
        troubled = false
        retry = false
        connected = false
        showsPage = false
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            ended(BrowseWords.NO_PROXY)
            return
        }
        val t = BrowseTunnel(host, session)
        tunnel = t
        t.onEnd = { why -> main.post { if (tunnel === t) ended(why) } }
        t.onRefused = { why -> refused = why }
        scope.launch {
            try {
                val (port, o) = t.open(settings)
                if (tunnel !== t) return@launch
                opens = o
                // THE PROXY FOR THIS SCREEN, localhost included: Chromium
                // sends localhost and *.localhost straight to the phone's own
                // loopback unless the implicit rules are removed, and a
                // session's port is `localhost` on the machine.
                val config = ProxyConfig.Builder()
                    .addProxyRule("127.0.0.1:$port")
                    .removeImplicitRules()
                    .build()
                // SET BEFORE THE CALL: a screen closed while the override is
                // being applied still takes it off (stop()).
                proxied = true
                ProxyController.getInstance().setProxyOverride(config, onMain) {
                    if (tunnel !== t) return@setProxyOverride
                    generation += 1
                    connected = true
                    line = null
                    BrowseWords.url(typed, opens?.hosts ?: emptyList())?.let { load(it) }
                }
            } catch (e: Exception) {
                t.close()
                // A timeout's own message is Kotlin's, not a sentence.
                if (tunnel === t) ended(if (e is TimeoutCancellationException) BrowseWords.COULD_NOT_CONNECT else e.message ?: BrowseWords.COULD_NOT_CONNECT)
            }
        }
    }

    fun stop() {
        tunnel?.close()
        tunnel = null
        dropWeb()
        if (proxied) {
            proxied = false
            runCatching { ProxyController.getInstance().clearProxyOverride(onMain) {} }
        }
        // NOTHING OUTLIVES THE SCREEN: the pages' cookies and storage go
        // with it. Nothing else in the app keeps any.
        runCatching { CookieManager.getInstance().removeAllCookies(null) }
        runCatching { WebStorage.getInstance().deleteAllData() }
    }

    private fun dropWeb() {
        web?.let { w ->
            runCatching {
                w.stopLoading()
                w.clearCache(true)
                w.clearHistory()
                // Off its parent first: destroying an attached web view is a
                // complaint in the log and can outlive the screen.
                (w.parent as? ViewGroup)?.removeView(w)
                w.destroy()
            }
        }
        web = null
        canGoBack = false
        canGoForward = false
    }

    private fun ended(why: String) {
        connected = false
        showsPage = false
        line = why
        troubled = true
        retry = true
    }

    fun go() {
        BrowseWords.url(typed, opens?.hosts ?: emptyList())?.let { load(it) }
    }

    fun load(url: String) {
        typed = url
        refused = null
        val w = web
        if (w == null || !connected) {
            pending = url
            return
        }
        w.loadUrl(url)
    }

    fun back() { web?.takeIf { it.canGoBack() }?.goBack() }
    fun forward() { web?.takeIf { it.canGoForward() }?.goForward() }
    fun reload() { web?.reload() }

    @SuppressLint("SetJavaScriptEnabled")
    fun makeWeb(context: Context): WebView = WebView(context).also { w ->
        dropWeb()
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.allowFileAccess = false
        w.settings.allowContentAccess = false
        w.settings.setSupportMultipleWindows(false)
        val credential = tunnel?.let { it.proxyUser to it.proxyPassword }
        w.webViewClient = object : WebViewClient() {
            private var asked = 0

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                line = null
                troubled = false
                url?.let { typed = it; insecure = it.startsWith("http://", ignoreCase = true) }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                showsPage = true
                asked = 0
                url?.let { typed = it; insecure = it.startsWith("http://", ignoreCase = true) }
                canGoBack = view.canGoBack()
                canGoForward = view.canGoForward()
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                canGoBack = view.canGoBack()
                canGoForward = view.canGoForward()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                line = refused ?: error.description?.toString() ?: BrowseWords.COULD_NOT_CONNECT
                troubled = true
            }

            /**
             * THE PROXY'S NAME AND PASSWORD, for this screen's own proxy and
             * nothing else: a page's own sign-in prompt is cancelled rather
             * than answered with them. Asked a few times at most, so a
             * proxy that will not take them does not loop.
             */
            override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) {
                if (credential != null && realm == "fleetwright" && host?.startsWith("127.0.0.1") == true && asked < 8) {
                    asked += 1
                    handler.proceed(credential.first, credential.second)
                } else {
                    handler.cancel()
                }
            }
        }
        web = w
        pending?.let {
            pending = null
            w.loadUrl(it)
        }
    }
}

/** Which port of a running session to open. */
@Composable
internal fun BrowsePortDialog(session: String, host: String, onOpen: (String) -> Unit, onDismiss: () -> Unit) {
    var port by remember { mutableStateOf("") }
    val valid = port.trim().toIntOrNull()?.takeIf { it in 1..65535 }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(BrowseWords.session(session, host)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                OutlinedTextField(
                    value = port,
                    onValueChange = { port = it.filter(Char::isDigit).take(5) },
                    label = { Text(BrowseWords.PORT_FIELD) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { valid?.let { onOpen("http://localhost:$it/") } }),
                )
                Text(BrowseWords.PORT_HINT, style = Design.Style.label, color = Design.Palette.inkDim.now)
            }
        },
        confirmButton = {
            TextButton(onClick = { valid?.let { onOpen("http://localhost:$it/") } }, enabled = valid != null, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(BrowseWords.PORT_OPEN)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } },
    )
}
