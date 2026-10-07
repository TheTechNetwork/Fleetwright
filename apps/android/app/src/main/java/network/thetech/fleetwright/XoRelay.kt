package network.thetech.fleetwright

import android.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/**
 * A relay through this phone, for a pool no machine in the fleet can reach.
 * docs/hypervisors.md, "Through the phone"; the iPhone's is PhoneRelay in
 * XORelay.swift, and the words here are its words.
 *
 * WHAT THIS PHONE DOES: it is a length of wire. The coordinator joins a
 * WebSocket from here (GET /api/xosetup/relay) to frames on one machine's
 * socket; for each connection that machine asks for, this phone opens a
 * plain TCP connection to the address the person typed, on its own network,
 * and pumps bytes both ways. The machine opens TLS over those bytes itself
 * and holds it to the pin (src/fleet/host/xo-relay.js), so what crosses this
 * phone is TLS records with the sign-in inside them, which it cannot read
 * and does not try to.
 *
 * ONE ADDRESS, FIXED HERE. No frame names where to connect: the target is
 * parsed once from what was typed, and every connection goes to it, so
 * neither the machine nor the coordinator can point this phone at anything
 * else on the network it is on.
 *
 * AND ITS OWN LOOK AT THE CERTIFICATE ([ownLook]). Through a relay the
 * coordinator is on the path the probe takes, so it could answer the
 * machine's handshake with a certificate of its own and have the person
 * accept it. This phone is on the pool's network itself: it reads the
 * certificate at the address directly, and the sheet goes on only when the
 * machine saw that same one through the relay.
 *
 * OkHttp for the fleet's side, because HttpURLConnection has no WebSocket; a
 * plain java.net.Socket per connection on the IO dispatcher for the
 * address's side, because a relay connection is raw bytes. Each connection
 * writes from one coroutine reading one channel, so bytes keep the order the
 * frames arrived in.
 *
 * THE SHEET HAS TO STAY OPEN. A relay is held by the screen that opened it,
 * and closed when that screen goes (a rotation included), which the sheet
 * says while the setup runs.
 */
internal class PhoneRelay private constructor(val address: String, private val target: Target) {
    /** What the fleet said when it opened the relay. */
    data class Ready(val relay: String, val hostId: String)

    /** Where this phone connects: the typed address as a host and a port, the way the machine splits it, 443 when none. */
    data class Target(val host: String, val port: Int) {
        /** The name a certificate is for, sent as SNI; null for an IP address. */
        val name: String? get() = if (host.contains(':') || IPV4.matches(host)) null else host

        companion object {
            private val IPV4 = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")

            fun of(address: String): Target? {
                val v6 = Regex("^\\[([^\\]]+)](?::(\\d+))?$").find(address)
                if (v6 != null) {
                    val port = v6.groupValues[2].ifEmpty { "443" }.toIntOrNull() ?: return null
                    return Target(v6.groupValues[1], port).takeIf { port in 1..65535 }
                }
                val colon = address.lastIndexOf(':')
                if (colon > 0) {
                    val port = address.substring(colon + 1).toIntOrNull() ?: return null
                    return Target(address.substring(0, colon), port).takeIf { port in 1..65535 && it.host.isNotEmpty() }
                }
                return if (address.isEmpty()) null else Target(address, 443)
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val streams = ConcurrentHashMap<Int, Stream>()
    private val ready = CompletableDeferred<Ready>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var finished = false

    /** Called once when the relay closes for a reason this phone did not choose. */
    @Volatile var onClose: ((String) -> Unit)? = null

    /** One connection to the address, and the bytes waiting to be written to it, in order. */
    private class Stream(val writes: Channel<ByteArray>) {
        @Volatile var connection: Socket? = null
        @Volatile var reached = false
    }

    /**
     * Open the relay for one machine, or the one the fleet chooses, and wait
     * for the fleet to say it is ready or why it is not.
     */
    suspend fun open(settings: Settings, host: String?): Ready {
        val base = settings.coordinatorUrl.trimEnd('/')
        val uri = URI("$base/api/xosetup/relay")
        // NOT OVER CLEARTEXT, for the reason Fleet.send gives: the upgrade
        // carries this device's credential.
        if (!uri.scheme.equals("https", ignoreCase = true) && uri.host !in LOCAL) {
            throw IllegalStateException("Refusing to send your credential over plain http. Use https:// for ${uri.host}.")
        }
        val query = "address=" + java.net.URLEncoder.encode(address, "UTF-8") +
            (host?.let { "&host=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")
        val request = Request.Builder()
            .url("$base/api/xosetup/relay?$query")
            .header("authorization", "Bearer ${settings.credential}")
            .apply { if (settings.viewAsMember) header("x-fleetwright-view", "member") }
            .build()
        socket = CLIENT.newWebSocket(request, Listener())
        return ready.await()
    }

    /** Stop carrying it: every connection through this phone ends now. */
    fun close() {
        finish(null)
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            handle(text)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            finish("The connection to the fleet ended, so this phone is no longer carrying anything to Xen Orchestra.")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            finish("The connection to the fleet ended, so this phone is no longer carrying anything to Xen Orchestra.")
        }
    }

    private fun handle(text: String) {
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        val stream = if (frame.has("stream")) frame.optInt("stream", -1).takeIf { it > 0 } else null
        when (frame.optString("op")) {
            "ready" -> {
                val relay = frame.optString("relay")
                val hostId = frame.optString("hostId")
                if (relay.isNotBlank() && hostId.isNotBlank()) ready.complete(Ready(relay, hostId))
            }
            "closed" -> finish(frame.optString("text").ifBlank { "The fleet closed the relay." })
            "open" -> if (stream != null) connect(stream)
            "data" -> {
                val bytes = runCatching { Base64.decode(frame.optString("data"), Base64.NO_WRAP) }.getOrNull() ?: return
                if (stream != null) streams[stream]?.writes?.trySend(bytes)
            }
            "end" -> if (stream != null) streams.remove(stream)?.let { end(it) }
        }
    }

    private fun send(frame: JSONObject) {
        if (!finished) socket?.send(frame.toString())
    }

    private fun connect(stream: Int) {
        val s = Stream(Channel(Channel.UNLIMITED))
        streams[stream] = s
        scope.launch {
            val connection = Socket()
            s.connection = connection
            try {
                connection.connect(InetSocketAddress(target.host, target.port), 10_000)
            } catch (e: Exception) {
                if (streams.remove(stream) != null) {
                    send(JSONObject().put("op", "refused").put("stream", stream).put("text", "this phone could not reach $address: ${e.message ?: "no answer"}"))
                }
                runCatching { connection.close() }
                return@launch
            }
            s.reached = true
            send(JSONObject().put("op", "opened").put("stream", stream))
            // THE WRITER: frames from the machine, in the order they came.
            launch {
                runCatching {
                    val out = connection.getOutputStream()
                    for (bytes in s.writes) out.write(bytes)
                }
            }
            // THE READER: what Xen Orchestra sends, a frame at a time.
            val buffer = ByteArray(CHUNK)
            runCatching {
                val input = connection.getInputStream()
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    if (n > 0) send(JSONObject().put("op", "data").put("stream", stream).put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP)))
                }
            }
            if (streams.remove(stream) != null) send(JSONObject().put("op", "end").put("stream", stream))
            end(s)
        }
    }

    private fun end(s: Stream) {
        s.writes.close()
        runCatching { s.connection?.close() }
    }

    private fun finish(text: String?) {
        if (finished) return
        finished = true
        for (s in streams.values) end(s)
        streams.clear()
        runCatching { socket?.close(1000, "relay closed") }
        socket = null
        ready.completeExceptionally(IllegalStateException(text ?: "This phone stopped carrying the relay."))
        scope.cancel()
        if (text != null) onClose?.invoke(text)
    }

    companion object {
        /** The most one frame carries, the coordinator's bound (relays.js). */
        const val CHUNK = 48 * 1024

        private val LOCAL = setOf("localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2")

        /** One client for every relay: it holds the connection pool and the threads. */
        private val CLIENT: OkHttpClient by lazy {
            OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        }

        fun of(address: String): PhoneRelay? = Target.of(address)?.let { PhoneRelay(address, it) }

        /**
         * The certificate at the address as this phone sees it, over its own
         * network: its SHA-256 in lowercase hex, the way the machine writes a
         * pin. Null is cannot tell — nothing answered over TLS, or the phone
         * is not on a network that reaches it — and the sheet says so and goes
         * no further, rather than take the machine's word alone.
         *
         * NOTHING IS TRUSTED HERE. The trust manager reads the certificate the
         * server presents and refuses it, every time, so the handshake stops
         * there and nothing is ever sent to the server from this phone.
         */
        suspend fun ownLook(address: String): String? = withContext(Dispatchers.IO) {
            val target = Target.of(address) ?: return@withContext null
            val reader = Reader()
            withTimeoutOrNull(10_000) {
                runCatching {
                    val context = SSLContext.getInstance("TLS")
                    context.init(null, arrayOf<javax.net.ssl.TrustManager>(reader), null)
                    val raw = Socket()
                    raw.connect(InetSocketAddress(target.host, target.port), 10_000)
                    val ssl = context.socketFactory.createSocket(raw, target.name ?: target.host, target.port, true) as SSLSocket
                    ssl.soTimeout = 10_000
                    runCatching { ssl.startHandshake() }
                    runCatching { ssl.close() }
                }
            }
            reader.leaf?.let { der -> MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) } }
        }
    }

    /** Reads the server's certificate and refuses it: this phone only looks. */
    private class Reader : X509TrustManager {
        @Volatile var leaf: ByteArray? = null

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("this phone does not take client certificates")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            leaf = chain?.firstOrNull()?.encoded
            throw CertificateException("read, and not trusted: this phone only looks")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
