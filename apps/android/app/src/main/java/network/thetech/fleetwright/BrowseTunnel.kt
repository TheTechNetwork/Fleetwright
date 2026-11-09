package network.thetech.fleetwright

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * A web view's connections, leaving from one of your machines: this phone's
 * half. docs/browse.md; the fleet's half is src/fleet/coordinator/browse.js
 * and src/fleet/host/browse.js. The same as iOS (BrowseTunnel.swift).
 *
 * AN HTTP PROXY ON THIS PHONE'S LOOPBACK, joined to one socket to the fleet
 * (GET /api/browse). The web view is pointed at it (ProxyController, in
 * BrowsePage.kt). Each connection the web view makes becomes a STREAM: the
 * machine makes that TCP connection, and the bytes go both ways as frames.
 *
 * THE PHONE STILL HOLDS THE TLS. For an https page the web view sends
 * `CONNECT host:443`, and once the machine has connected it opens TLS through
 * the stream itself, to the page's own name. What the machine and the fleet
 * carry is TLS records.
 *
 * A PLAIN-HTTP REQUEST comes as `GET http://host/path`, which is how Chromium
 * asks a proxy for one. The stream goes to that host, the first line is
 * rewritten to `GET /path`, the `Proxy-` headers are dropped, and the server is
 * asked to close after one answer, so the next request opens the next stream.
 *
 * ONLY THE WEB VIEW MAY USE IT. Any app on an Android phone can connect to
 * its loopback, and this proxy spends this person's credential on a machine's
 * address, so it answers only a request carrying the name and password made
 * for this screen, which the web view is given (onReceivedHttpAuthRequest)
 * and nothing else is.
 */
internal class BrowseTunnel(private val host: String, private val session: String?) {
    /** What the machine opens for this person besides the session; null where its own rules do not apply to them. */
    data class Opens(val web: Boolean, val hosts: List<String>)

    @Volatile var onEnd: ((String) -> Unit)? = null
    /** The machine would not open a connection, and why: shown when a page does not load. */
    @Volatile var onRefused: ((String) -> Unit)? = null

    val proxyUser = "fleetwright"
    val proxyPassword: String = ByteArray(24).also { SecureRandom().nextBytes(it) }
        .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    private val expectedAuth = "Basic " + Base64.getEncoder().encodeToString("$proxyUser:$proxyPassword".toByteArray())

    private var ws: WebSocket? = null
    private var server: ServerSocket? = null
    @Volatile private var finished = false
    private val ready = CompletableDeferred<Opens?>()
    private val opened = CompletableDeferred<Unit>()
    private val next = AtomicInteger(1)
    private val streams = ConcurrentHashMap<Int, Conn>()

    private class Conn(val socket: Socket, val tunnel: Boolean, val pending: ByteArray) {
        val out: OutputStream = socket.getOutputStream()
        @Volatile var joined = false
        /** Let go once the machine has answered for this stream, either way. */
        val answered = CountDownLatch(1)
        /**
         * WRITES GO ON THIS CONNECTION'S OWN THREAD, in order. They used to be
         * made on OkHttp's one reader thread, so a web view that stopped
         * reading one connection (a paused video) blocked that thread, and
         * with it every other connection on the page and the frame that
         * would have closed it.
         */
        val writer: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "browse-write").apply { isDaemon = true } }
        fun write(bytes: ByteArray) { out.write(bytes); out.flush() }
        fun shut() {
            writer.shutdown()
            runCatching { socket.close() }
        }
    }

    /** Open the socket and the proxy, and wait until the machine agrees. Answers the proxy's port and what it opens for you. */
    suspend fun open(settings: Settings): Pair<Int, Opens?> {
        val base = settings.coordinatorUrl.trimEnd('/')
        // NOT OVER CLEARTEXT: the upgrade carries this device's credential.
        val uri = URI("$base/api/browse")
        if (!uri.scheme.equals("https", ignoreCase = true) && uri.host !in PhoneRelay.LOCAL) {
            throw IllegalStateException("Refusing to send your credential over plain http. Use https:// for ${uri.host}.")
        }
        val query = "host=${URLEncoder.encode(host, "UTF-8")}" + (session?.let { "&session=${URLEncoder.encode(it, "UTF-8")}" } ?: "")
        val request = Request.Builder()
            .url("$base/api/browse?$query")
            .header("authorization", "Bearer ${settings.credential}")
            .apply { if (settings.viewAsMember) header("x-fleetwright-view", "member") }
            .build()
        ws = CLIENT.newWebSocket(request, Listener())
        val opens = withTimeout(30_000) { ready.await() }
        withTimeout(30_000) { opened.await() }
        // THE MACHINE AGREED: only now is there anywhere for a page's bytes
        // to go, so only now does the proxy listen, on loopback only.
        val s = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        server = s
        Thread {
            while (!finished) {
                val c = try { s.accept() } catch (_: Exception) { break }
                Thread { serve(c) }.apply { isDaemon = true; name = "browse-conn" }.start()
            }
        }.apply { isDaemon = true; name = "browse-proxy" }.start()
        return s.localPort to opens
    }

    fun close() = finish(null)

    // --- the proxy ------------------------------------------------------------

    private fun serve(socket: Socket) {
        try {
            val input = socket.getInputStream()
            val head = readHead(input) ?: return socket.close()
            val lines = String(head.first, Charsets.ISO_8859_1).split("\r\n")
            val first = lines.firstOrNull()?.split(" ")?.filter { it.isNotEmpty() } ?: emptyList()
            if (first.size != 3) return answer(socket, "400 Bad Request", "")
            val headers = lines.drop(1)
            // THE WEB VIEW'S NAME AND PASSWORD, or nothing: see the class's header.
            val auth = headers.firstOrNull { it.lowercase().startsWith("proxy-authorization:") }
                ?.substringAfter(':')?.trim()
            if (auth != expectedAuth) {
                socket.getOutputStream().write(
                    "HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"fleetwright\"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".toByteArray(),
                )
                socket.close()
                return
            }
            val target: Pair<String, Int>?
            val tunnel: Boolean
            val pending: ByteArray
            if (first[0].equals("CONNECT", ignoreCase = true)) {
                target = hostPort(first[1], 443)
                tunnel = true
                pending = head.second
            } else {
                val url = runCatching { URI(first[1]) }.getOrNull()
                if (url == null || !url.scheme.equals("http", ignoreCase = true) || url.host.isNullOrBlank()) return answer(socket, "400 Bad Request", "")
                target = url.host.removePrefix("[").removeSuffix("]") to (if (url.port > 0) url.port else 80)
                tunnel = false
                // ONE REQUEST, THEN CLOSED: the path alone on the first line,
                // no proxy headers, and the server asked to close when it answers.
                val path = (url.rawPath?.takeIf { it.isNotEmpty() } ?: "/") + (url.rawQuery?.let { "?$it" } ?: "")
                val kept = headers.filter {
                    val l = it.lowercase()
                    !l.startsWith("proxy-") && !l.startsWith("connection:") && !l.startsWith("keep-alive:")
                }
                val rewritten = (listOf("${first[0]} $path ${first[2]}") + kept + listOf("Connection: close", "", "")).joinToString("\r\n")
                pending = rewritten.toByteArray(Charsets.ISO_8859_1) + head.second
            }
            if (target == null || target.second !in 1..65535) return answer(socket, "400 Bad Request", "")
            val stream = next.getAndIncrement()
            val c = Conn(socket, tunnel, pending)
            streams[stream] = c
            send(JSONObject().put("op", "connect").put("stream", stream).put("host", target.first).put("port", target.second))
            // Bytes the web view writes are read once the machine has
            // connected: until then there is nowhere for them to go.
            c.answered.await(30, TimeUnit.SECONDS)
            // Refused (answered already), ended, or no answer in time.
            if (!c.joined || streams[stream] !== c) {
                if (streams.remove(stream, c)) send(JSONObject().put("op", "end").put("stream", stream))
                // A refusal's 502 is written on the connection's own thread;
                // closing after it, there, keeps it from being cut off.
                runCatching { c.writer.execute { c.shut() } }.onFailure { c.shut() }
                return
            }
            pump(stream, c, input)
        } catch (_: Exception) {
            runCatching { socket.close() }
        }
    }

    /** The request's head, up to its blank line, and whatever came after it. */
    private fun readHead(input: InputStream): Pair<ByteArray, ByteArray>? {
        val buf = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        while (buf.size() <= 16384) {
            val n = input.read(chunk)
            if (n < 0) return null
            buf.write(chunk, 0, n)
            val all = buf.toByteArray()
            val end = indexOf(all, "\r\n\r\n".toByteArray())
            if (end >= 0) return all.copyOfRange(0, end) to all.copyOfRange(end + 4, all.size)
        }
        return null
    }

    private fun indexOf(hay: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..hay.size - needle.size) {
            for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
            return i
        }
        return -1
    }

    /** Bytes the web view wrote, to the machine in pieces the fleet carries (48 KiB at most). */
    private fun pump(stream: Int, c: Conn, input: InputStream) {
        val buf = ByteArray(48 * 1024)
        try {
            while (!finished && streams[stream] === c) {
                val n = input.read(buf)
                if (n < 0) break
                if (n > 0) send(JSONObject().put("op", "data").put("stream", stream).put("data", Base64.getEncoder().encodeToString(buf.copyOf(n))))
            }
        } catch (_: Exception) { /* closed */ }
        if (streams.remove(stream, c)) send(JSONObject().put("op", "end").put("stream", stream))
        c.shut()
    }

    /** A short answer from the proxy itself, then closed. */
    private fun answer(socket: Socket, status: String, body: String) {
        runCatching {
            val bytes = body.toByteArray()
            socket.getOutputStream().write("HTTP/1.1 $status\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n".toByteArray() + bytes)
            socket.getOutputStream().flush()
        }
        runCatching { socket.close() }
    }

    private fun send(frame: JSONObject) {
        ws?.send(frame.toString())
    }

    private fun finish(why: String?) {
        if (finished) return
        finished = true
        if (why == null) runCatching { send(JSONObject().put("op", "close")) }
        for (c in streams.values) c.shut()
        streams.clear()
        runCatching { server?.close() }
        runCatching { ws?.close(1000, null) }
        val text = why ?: BrowseWords.CLOSED
        ready.completeExceptionally(IllegalStateException(text))
        opened.completeExceptionally(IllegalStateException(text))
        if (why != null) onEnd?.invoke(text)
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
            val stream = frame.optInt("stream", 0)
            when (frame.optString("op")) {
                "ready" -> ready.complete(frame.optJSONObject("opens")?.let { o ->
                    Opens(
                        web = o.optBoolean("web", false),
                        hosts = o.optJSONArray("hosts")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } } ?: emptyList(),
                    )
                })
                "open" -> opened.complete(Unit)
                "connected" -> {
                    val c = streams[stream] ?: return
                    if (c.tunnel) runCatching { c.writer.execute { runCatching { c.write("HTTP/1.1 200 Connection established\r\n\r\n".toByteArray()) } } }
                    if (c.pending.isNotEmpty()) {
                        var at = 0
                        while (at < c.pending.size) {
                            val end = minOf(at + 48 * 1024, c.pending.size)
                            send(JSONObject().put("op", "data").put("stream", stream).put("data", Base64.getEncoder().encodeToString(c.pending.copyOfRange(at, end))))
                            at = end
                        }
                    }
                    c.joined = true
                    c.answered.countDown()
                }
                "failed" -> {
                    val c = streams.remove(stream) ?: return
                    val why = frame.optString("text").ifBlank { BrowseWords.COULD_NOT_CONNECT }
                    onRefused?.invoke(why)
                    // The 502 first, on the connection's own thread, and only
                    // then is the waiting connection let go to close it.
                    runCatching {
                        c.writer.execute {
                            answer(c.socket, "502 Bad Gateway", why)
                            c.answered.countDown()
                        }
                    }.onFailure { c.answered.countDown() }
                }
                "data" -> {
                    val c = streams[stream] ?: return
                    val bytes = runCatching { Base64.getDecoder().decode(frame.optString("data")) }.getOrNull() ?: return
                    runCatching {
                        c.writer.execute {
                            // HANDED ON, THEN ACKNOWLEDGED: the machine reads no
                            // further ahead of this phone than its window
                            // (docs/browse.md, "How fast").
                            val ok = runCatching { c.write(bytes) }.isSuccess
                            if (ok && streams[stream] === c) {
                                send(JSONObject().put("op", "ack").put("stream", stream).put("bytes", bytes.size))
                            } else if (!ok && streams.remove(stream, c)) {
                                send(JSONObject().put("op", "end").put("stream", stream))
                                c.shut()
                            }
                        }
                    }
                }
                "end" -> {
                    val c = streams.remove(stream) ?: return
                    c.answered.countDown()
                    // After whatever is still queued for it has been written.
                    runCatching { c.writer.execute { c.shut() } }.onFailure { c.shut() }
                }
                "closed" -> finish(frame.optString("text").ifBlank { BrowseWords.CLOSED })
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            finish(BrowseWords.LOST)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            finish(BrowseWords.CLOSED)
        }
    }

    companion object {
        private val CLIENT: OkHttpClient by lazy { OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build() }

        /** `host:port`, `[v6]:port`, or a host alone on the default port. */
        fun hostPort(s: String, defaultPort: Int): Pair<String, Int>? {
            if (s.startsWith("[")) {
                val close = s.indexOf(']')
                if (close < 0) return null
                val h = s.substring(1, close)
                val after = s.substring(close + 1)
                if (after.isEmpty()) return h to defaultPort
                if (!after.startsWith(":")) return null
                return after.drop(1).toIntOrNull()?.let { h to it }
            }
            val colon = s.lastIndexOf(':')
            if (colon < 0) return s to defaultPort
            return s.substring(colon + 1).toIntOrNull()?.let { s.substring(0, colon) to it }
        }
    }
}
