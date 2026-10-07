package network.thetech.fleetwright

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.SequenceInputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Talking to Xen Orchestra from this phone: its JSON-RPC, over a WebSocket at
 * `/api/`, over TLS held to one certificate. docs/manage.md, "Talking". The
 * same design as XOLink.swift.
 *
 * THE SAME CONVERSATION src/fleet/host/xo-ws.js HAS from a machine, written
 * the same way: an RFC 6455 handshake and its frames on a TLS socket, and
 * JSON-RPC 2.0 on top. Not a library: the app's whole network layer is
 * HttpURLConnection on purpose (Fleet.kt), the protocol here is two hundred
 * lines that xo-ws.js already proved against a real Xen Orchestra, and a
 * dependency would be carried for the life of the app to save them. Text
 * frames only, because that is all Xen Orchestra speaks on /api/.
 *
 * THE PIN IS CHECKED IN THE HANDSHAKE, BEFORE A BYTE IS SENT. A Xen Orchestra
 * built from sources serves a self-signed certificate, so the ordinary check
 * (a chain to a public root) fails on every real pool. What replaces it is
 * stronger: the SHA-256 of the exact certificate the person accepted when the
 * pool was set up, which setup sealed back to this phone with the token.
 * [PinTrust] refuses any other inside `startHandshake`, and the upgrade
 * request (the first thing written) is only written after it returns.
 *
 * NOTIFICATIONS ARRIVE IN ORDER on [notices], which the screen reads on the
 * main thread: an object that arrived and then went must not go and then
 * arrive. NOTHING HERE LOGS A MESSAGE: the first one sent carries the token.
 */
internal class XoLink private constructor(private val socket: SSLSocket, private val input: InputStream, private val rest: ByteArray) {

    class Failure(message: String, val kind: Kind) : Exception(message) {
        enum class Kind { WRONG_CERTIFICATE, REFUSED, CLOSED, SLOW }
    }

    private val output = socket.getOutputStream()
    private val writeLock = Any()
    private val nextId = AtomicInteger(1)
    private val waiting = ConcurrentHashMap<Int, CompletableDeferred<Any?>>()

    @Volatile private var ended = false

    /** Xen Orchestra's notifications, method and params, in the order they arrived. */
    val notices = Channel<Pair<String, Any?>>(Channel.UNLIMITED)

    /** Why it ended: once, whichever way. */
    val end = CompletableDeferred<String>()

    /**
     * One JSON-RPC call, answered with its result (a JSONObject, a JSONArray,
     * a string, a number, a boolean or JSONObject.NULL), or thrown with Xen
     * Orchestra's own words for a refusal.
     */
    suspend fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 60_000): Any? {
        if (ended) throw Failure("the connection to Xen Orchestra is closed", Failure.Kind.CLOSED)
        val id = nextId.getAndIncrement()
        val waiter = CompletableDeferred<Any?>()
        waiting[id] = waiter
        val body = JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString()
        try {
            withContext(Dispatchers.IO) { send(frame(0x1, body.toByteArray(Charsets.UTF_8))) }
        } catch (e: Exception) {
            waiting.remove(id)
            throw Failure(e.message ?: "the connection to Xen Orchestra is closed", Failure.Kind.CLOSED)
        }
        return try {
            withTimeout(timeoutMs) { waiter.await() }
        } catch (e: TimeoutCancellationException) {
            waiting.remove(id)
            throw Failure("Xen Orchestra did not answer $method in time", Failure.Kind.SLOW)
        }
    }

    /** Asked to end. */
    fun close() {
        if (ended) return
        runCatching { send(frame(0x8, ByteArray(0))) }
        finish("closed here")
    }

    private fun send(bytes: ByteArray) {
        synchronized(writeLock) {
            output.write(bytes)
            output.flush()
        }
    }

    private fun startReading() {
        thread(name = "xo-link", isDaemon = true) {
            val why = runCatching { readLoop() }.exceptionOrNull()?.message
            finish(why ?: "Xen Orchestra closed the connection")
        }
    }

    private fun readLoop() {
        val data = DataInputStream(BufferedInputStream(SequenceInputStream(ByteArrayInputStream(rest), input)))
        val fragments = ByteArrayOutputStream()
        while (!ended) {
            val f = readFrame(data) ?: return
            when (f.opcode) {
                0x9 -> send(frame(0xA, f.payload))
                0x8 -> return
                0xA -> {}
                0x1, 0x0 -> {
                    fragments.write(f.payload)
                    if (fragments.size() > MAX_MESSAGE_BYTES) {
                        throw Failure("Xen Orchestra sent a message larger than this client accepts", Failure.Kind.CLOSED)
                    }
                    if (f.fin) {
                        val text = fragments.toString("UTF-8")
                        fragments.reset()
                        take(text)
                    }
                }
                else -> throw Failure("Xen Orchestra sent a frame this client does not speak (${f.opcode})", Failure.Kind.CLOSED)
            }
        }
    }

    /** An answer to a call, by its id; or, with no id, a notification. */
    private fun take(text: String) {
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
        val id = msg.opt("id")
        if (id is Number) {
            val waiter = waiting.remove(id.toInt()) ?: return
            val error = msg.optJSONObject("error")
            if (error != null) {
                // Xen Orchestra's own words, bounded, and never the params:
                // the first call carries the token.
                val why = (error.opt("message") as? String)?.take(300) ?: "an error"
                waiter.completeExceptionally(Failure(why, Failure.Kind.REFUSED))
            } else {
                waiter.complete(msg.opt("result"))
            }
        } else {
            val method = msg.opt("method") as? String ?: return
            notices.trySend(method to msg.opt("params"))
        }
    }

    private fun finish(why: String) {
        synchronized(this) {
            if (ended && end.isCompleted) return
            ended = true
        }
        runCatching { socket.close() }
        val failure = Failure(why, Failure.Kind.CLOSED)
        for (id in waiting.keys.toList()) waiting.remove(id)?.completeExceptionally(failure)
        notices.close()
        end.complete(why)
    }

    /** One frame as it came off the wire. */
    class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    /**
     * Accepts the pinned certificate and no other, whoever signed it: a
     * stronger statement than "some public authority vouched for a name", and
     * the only one a self-signed server can make. Throws for anything else,
     * which ends the handshake before the upgrade request is written.
     */
    private class PinTrust(private val pin: String) : X509TrustManager {
        @Volatile var mismatch = false

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("this client asks no certificate of anyone")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("the server sent no certificate")
            if (Manage.fingerprint(leaf.encoded) != pin) {
                mismatch = true
                throw CertificateException("not the certificate pinned at setup")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    companion object {
        /** What RFC 6455 appends to the key before hashing it, to prove an upgrade was understood. */
        private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        /** Bigger than any answer a pool gives, small enough that a hostile server cannot fill memory: xo-ws.js's bound. */
        const val MAX_MESSAGE_BYTES = 16 * 1024 * 1024

        /**
         * Connect, check the pin in the handshake, and upgrade to the API's
         * WebSocket. Throws a [Failure] of kind WRONG_CERTIFICATE for a server
         * that answered with any other certificate, having sent it nothing.
         */
        suspend fun open(address: String, pin: String, timeoutMs: Int = 15_000): XoLink = withContext(Dispatchers.IO) {
            val (host, port) = splitAddress(address)
            val trust = PinTrust(pin.lowercase())
            val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
            val raw = Socket()
            try {
                raw.connect(InetSocketAddress(host, port), timeoutMs)
                raw.soTimeout = timeoutMs
                val ssl = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
                try {
                    ssl.startHandshake()
                } catch (e: Exception) {
                    if (trust.mismatch) throw Failure("the certificate was not the pinned one", Failure.Kind.WRONG_CERTIFICATE)
                    throw e
                }
                val rest = upgrade(ssl, host, port)
                // From here a read waits on Xen Orchestra, which may say
                // nothing for a long while and is not wrong to.
                ssl.soTimeout = 0
                XoLink(ssl, ssl.inputStream, rest).also { it.startReading() }
            } catch (e: Exception) {
                runCatching { raw.close() }
                throw e
            }
        }

        /** The HTTP upgrade, answered with whatever arrived after its headers. */
        private fun upgrade(ssl: SSLSocket, host: String, port: Int): ByteArray {
            val key = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
            val hostHeader = if (host.contains(':')) "[$host]:$port" else "$host:$port"
            val out = ssl.outputStream
            out.write(
                ("GET /api/ HTTP/1.1\r\nHost: $hostHeader\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray(Charsets.ISO_8859_1),
            )
            out.flush()
            val input = ssl.inputStream
            val head = ByteArrayOutputStream()
            val buf = ByteArray(4096)
            var end = -1
            while (end < 0) {
                val n = input.read(buf)
                if (n < 0) throw Failure("Xen Orchestra closed the connection before accepting the API upgrade", Failure.Kind.CLOSED)
                head.write(buf, 0, n)
                end = headerEnd(head.toByteArray())
                if (end < 0 && head.size() > 16 * 1024) {
                    throw Failure("Xen Orchestra answered the upgrade with something that is not HTTP", Failure.Kind.CLOSED)
                }
            }
            val all = head.toByteArray()
            val lines = String(all, 0, end, Charsets.ISO_8859_1).split("\r\n")
            val status = Regex("^HTTP/1\\.1 (\\d{3})").find(lines.firstOrNull() ?: "")?.groupValues?.get(1)
            val headers = lines.drop(1).mapNotNull { l ->
                val i = l.indexOf(':')
                if (i < 0) null else l.substring(0, i).trim().lowercase() to l.substring(i + 1).trim()
            }.toMap()
            if (status != "101" || headers["sec-websocket-accept"] != accept(key)) {
                throw Failure("Xen Orchestra refused the API connection (${status ?: "no status"})", Failure.Kind.REFUSED)
            }
            return all.copyOfRange(end + 4, all.size)
        }

        /** Where the headers end: the index of the blank line, or -1. */
        fun headerEnd(bytes: ByteArray): Int {
            for (i in 0..bytes.size - 4) {
                if (bytes[i] == 13.toByte() && bytes[i + 1] == 10.toByte() && bytes[i + 2] == 13.toByte() && bytes[i + 3] == 10.toByte()) return i
            }
            return -1
        }

        /** What a server that understood the upgrade answers for a key (RFC 6455, 4.2.2). */
        fun accept(key: String): String =
            Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.ISO_8859_1)))

        /**
         * An address as setup records it (`name`, `name:port`, `[v6]` or
         * `[v6]:port`) as a host and a port, 443 when none is given: xo-ws.js's
         * splitAddress.
         */
        fun splitAddress(address: String): Pair<String, Int> {
            Regex("^\\[([^\\]]+)\\](?::(\\d+))?$").find(address)?.let { m ->
                return m.groupValues[1] to (m.groupValues[2].toIntOrNull() ?: 443)
            }
            val i = address.lastIndexOf(':')
            if (i > 0) return address.substring(0, i) to (address.substring(i + 1).toIntOrNull() ?: 443)
            return address to 443
        }

        /**
         * One frame as a client sends it: always masked, because RFC 6455
         * requires a client to and a server must refuse one that is not.
         */
        fun frame(opcode: Int, payload: ByteArray, mask: Boolean = true): ByteArray {
            val len = payload.size
            val out = ByteArrayOutputStream()
            out.write(0x80 or opcode)
            val maskBit = if (mask) 0x80 else 0
            when {
                len < 126 -> out.write(maskBit or len)
                len < 65536 -> {
                    out.write(maskBit or 126)
                    out.write((len shr 8) and 0xff)
                    out.write(len and 0xff)
                }
                else -> {
                    out.write(maskBit or 127)
                    for (shift in 56 downTo 0 step 8) out.write(((len.toLong() shr shift) and 0xff).toInt())
                }
            }
            if (!mask) {
                out.write(payload)
                return out.toByteArray()
            }
            val key = ByteArray(4).also { SecureRandom().nextBytes(it) }
            out.write(key)
            out.write(ByteArray(len) { i -> (payload[i].toInt() xor key[i and 3].toInt()).toByte() })
            return out.toByteArray()
        }

        /** One frame off a stream, masked or not; null at the end of it. */
        fun readFrame(input: DataInputStream): Frame? {
            val b0 = input.read()
            if (b0 < 0) return null
            val b1 = input.readUnsignedByte()
            val fin = (b0 and 0x80) != 0
            val opcode = b0 and 0x0f
            val masked = (b1 and 0x80) != 0
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readUnsignedShort().toLong() else if (len == 127L) len = input.readLong()
            if (len < 0 || len > MAX_MESSAGE_BYTES) {
                throw Failure("Xen Orchestra sent a message larger than this client accepts", Failure.Kind.CLOSED)
            }
            val key = if (masked) ByteArray(4).also { input.readFully(it) } else null
            val payload = ByteArray(len.toInt())
            input.readFully(payload)
            if (key != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor key[i and 3].toInt()).toByte()
            return Frame(fin, opcode, payload)
        }
    }
}
