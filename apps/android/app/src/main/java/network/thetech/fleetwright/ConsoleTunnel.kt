package network.thetech.fleetwright

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * A VM's console for this phone away from the pool, through one of your
 * machines that holds the pool. docs/manage.md, "The console"; the fleet's
 * half is src/fleet/coordinator/tunnels.js and src/fleet/host/console-tunnel.js.
 *
 * THE PHONE STILL OPENS TLS ITSELF, held to the pool's pin, exactly as on the
 * pool's own network (XoLink.handshake): the machine makes one plain TCP
 * connection to the pool and pumps bytes, so what crosses it and the fleet is
 * TLS records, the token and the screen inside them.
 *
 * HOW THE CONSOLE'S TLS RIDES IT: [open] answers a socket connected to a
 * listener on this phone's loopback, whose other end is joined to the fleet's
 * socket (GET /api/xoconsole/tunnel). XoLink layers TLS on that socket with the
 * pool's own host name, so the server name and the Host the upgrade names are
 * the pool's. The listener takes one connection, its own, and then closes.
 */
internal class ConsoleTunnel(private val address: String) {
    /** What the fleet or the machine said when it ended, for the screen. */
    @Volatile var onEnd: ((String) -> Unit)? = null

    private var ws: WebSocket? = null
    private var near: Socket? = null
    private var out: OutputStream? = null
    @Volatile private var finished = false
    private val ready = CompletableDeferred<String>()
    private val opened = CompletableDeferred<Unit>()

    /**
     * Open it and wait until the machine has reached the pool. Answers the
     * socket for XoLink to open TLS on, and the machine carrying it.
     */
    suspend fun open(settings: Settings): Pair<Socket, String> {
        val base = settings.coordinatorUrl.trimEnd('/')
        // NOT OVER CLEARTEXT: the upgrade carries this device's credential.
        val uri = java.net.URI("$base/api/xoconsole/tunnel")
        if (!uri.scheme.equals("https", ignoreCase = true) && uri.host !in PhoneRelay.LOCAL) {
            throw IllegalStateException("Refusing to send your credential over plain http. Use https:// for ${uri.host}.")
        }
        val request = Request.Builder()
            .url("$base/api/xoconsole/tunnel?address=${URLEncoder.encode(address, "UTF-8")}")
            .header("authorization", "Bearer ${settings.credential}")
            .apply { if (settings.viewAsMember) header("x-fleetwright-view", "member") }
            .build()
        ws = CLIENT.newWebSocket(request, Listener())
        val hostId = withTimeout(30_000) { ready.await() }
        withTimeout(30_000) { opened.await() }
        return withContext(Dispatchers.IO) {
            val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
            try {
                val mine = Socket(InetAddress.getLoopbackAddress(), server.localPort)
                val theirs = server.accept()
                near = theirs
                out = theirs.getOutputStream()
                pump(theirs)
                mine to hostId
            } finally {
                server.close()
            }
        }
    }

    fun close() = finish(null)

    /** Bytes the console's TLS wrote, to the fleet in pieces it carries (48 KiB at most). */
    private fun pump(socket: Socket) {
        Thread {
            val buf = ByteArray(48 * 1024)
            try {
                val input = socket.getInputStream()
                while (!finished) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) send(JSONObject().put("op", "data").put("data", Base64.getEncoder().encodeToString(buf.copyOf(n))))
                }
            } catch (_: Exception) { /* closed */ }
            finish(null)
        }.apply { isDaemon = true; name = "console-tunnel" }.start()
    }

    private fun send(frame: JSONObject) {
        ws?.send(frame.toString())
    }

    private fun finish(why: String?) {
        if (finished) return
        finished = true
        if (why == null) runCatching { send(JSONObject().put("op", "end")) }
        runCatching { near?.close() }
        runCatching { ws?.close(1000, null) }
        val text = why ?: CLOSED
        ready.completeExceptionally(IllegalStateException(text))
        opened.completeExceptionally(IllegalStateException(text))
        if (why != null) onEnd?.invoke(text)
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (frame.optString("op")) {
                "ready" -> ready.complete(frame.optString("hostId"))
                "open" -> opened.complete(Unit)
                "data" -> {
                    val bytes = runCatching { Base64.getDecoder().decode(frame.optString("data")) }.getOrNull() ?: return
                    runCatching { out?.write(bytes); out?.flush() }
                }
                "closed" -> finish(frame.optString("text").ifBlank { CLOSED })
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            finish(LOST)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            finish(CLOSED)
        }
    }

    private companion object {
        val CLIENT: OkHttpClient by lazy { OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build() }

        /**
         * WHAT THE BANNER SAYS when it ends, in two verdicts: the connection
         * was lost, or the console closed. Which socket, which machine and
         * which side ended it is this file's business, not the person's; the
         * Open again button under the banner is the action. The same words as
         * iOS (ConsoleTunnel.swift) and as Manage.Words.consoleEnded.
         */
        const val LOST = "Lost the connection."
        const val CLOSED = "The console closed."
    }
}
