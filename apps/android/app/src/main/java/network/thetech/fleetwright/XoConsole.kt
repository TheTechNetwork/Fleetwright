package network.thetech.fleetwright

import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.SequenceInputStream
import java.net.URLEncoder
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread

/**
 * One VM's screen from Xen Orchestra: VNC over a WebSocket at
 * `/api/consoles/<vm id>`, over TLS held to the pool's pinned certificate.
 * docs/manage.md, "The console". The same as iOS (XOConsole.swift).
 *
 * THE SAME PIN AS THE POOL PAGE, checked in the handshake before a byte is
 * written ([XoLink.handshake]), and the same token, sent the one way Xen
 * Orchestra reads it for a console: as the `token` cookie on the upgrade
 * request (setUpConsoleProxy in xo-server's index.mjs). Xen Orchestra then
 * checks that the token's user may operate that machine, and closes the
 * socket if not.
 *
 * BYTES IN, BYTES OUT. Nothing here speaks VNC; noVNC does, in the page
 * (src/vnc/page.js), and this carries its frames. Nothing is logged.
 */
internal class XoConsole private constructor(private val socket: SSLSocket, private val rest: ByteArray) {

    private val output = socket.getOutputStream()
    private val writeLock = Any()
    @Volatile private var ended = false

    /** A frame from Xen Orchestra, on the reading thread, in order. */
    @Volatile var onData: (ByteArray) -> Unit = {}
    /** It ended without being asked to, and why. */
    @Volatile var onEnd: (String) -> Unit = {}

    fun send(bytes: ByteArray) {
        if (ended) return
        runCatching {
            synchronized(writeLock) {
                output.write(XoLink.frame(0x2, bytes))
                output.flush()
            }
        }.onFailure { finish(it.message ?: "the connection closed", report = true) }
    }

    /** Asked to end: nothing is reported to [onEnd]. */
    fun close() {
        if (ended) return
        runCatching { synchronized(writeLock) { output.write(XoLink.frame(0x8, ByteArray(0))) } }
        finish("closed here", report = false)
    }

    /** Begin reading; frames go to [onData] once this is called. */
    fun start() {
        thread(name = "xo-console", isDaemon = true) {
            val why = runCatching { readLoop() }.exceptionOrNull()?.message
            finish(why ?: "Xen Orchestra closed the console", report = true)
        }
    }

    private fun readLoop() {
        val data = DataInputStream(BufferedInputStream(SequenceInputStream(ByteArrayInputStream(rest), socket.inputStream)))
        val fragments = ByteArrayOutputStream()
        while (!ended) {
            val f = XoLink.readFrame(data) ?: return
            when (f.opcode) {
                0x9 -> synchronized(writeLock) { output.write(XoLink.frame(0xA, f.payload)); output.flush() }
                0x8 -> return
                0xA -> {}
                0x0, 0x1, 0x2 -> {
                    fragments.write(f.payload)
                    if (fragments.size() > XoLink.MAX_MESSAGE_BYTES) throw IllegalStateException("Xen Orchestra sent a frame larger than this client accepts")
                    if (f.fin) {
                        val bytes = fragments.toByteArray()
                        fragments.reset()
                        onData(bytes)
                    }
                }
                else -> throw IllegalStateException("Xen Orchestra sent a frame this client does not speak (${f.opcode})")
            }
        }
    }

    private fun finish(why: String, report: Boolean) {
        synchronized(this) {
            if (ended) return
            ended = true
        }
        runCatching { socket.close() }
        if (report) onEnd(why)
    }

    companion object {
        /**
         * Open the console of [vm]. Throws an [XoLink.Failure] of kind
         * WRONG_CERTIFICATE for a server that answered with any other
         * certificate, having sent it nothing.
         */
        suspend fun open(address: String, pin: String, token: String, vm: String): XoConsole {
            val path = "/api/consoles/" + URLEncoder.encode(vm, "UTF-8").replace("+", "%20")
            val (ssl, rest) = XoLink.handshake(address, pin, path, "token=$token")
            return XoConsole(ssl, rest)
        }
    }
}
