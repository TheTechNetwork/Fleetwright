package network.thetech.fleetwright

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * PhoneRelay, run rather than read: where this phone connects, and what it
 * says when it cannot see a certificate. The frames and the words are held by
 * test/relay-in-apps.test.js; a relay end to end by test/relay-end-to-end.test.js.
 */
class XoRelayTest {
    /**
     * ONE ADDRESS, split the way the machine splits it (splitAddress in
     * xo-ws.js), so the phone connects where the machine's TLS is checked for.
     */
    @Test
    fun theTargetIsTheTypedAddressAndNothingElse() {
        assertEquals(PhoneRelay.Target("xo.lan", 443), PhoneRelay.Target.of("xo.lan"))
        assertEquals(PhoneRelay.Target("xo.lan", 8443), PhoneRelay.Target.of("xo.lan:8443"))
        assertEquals(PhoneRelay.Target("192.168.1.20", 443), PhoneRelay.Target.of("192.168.1.20"))
        assertEquals(PhoneRelay.Target("fd00::20", 8443), PhoneRelay.Target.of("[fd00::20]:8443"))
        assertEquals(PhoneRelay.Target("fd00::20", 443), PhoneRelay.Target.of("[fd00::20]"))
        assertNull(PhoneRelay.Target.of("xo.lan:https"))
        assertNull(PhoneRelay.Target.of("xo.lan:70000"))
        assertNull(PhoneRelay.Target.of(""))
        // SNI for a name, never for an address.
        assertEquals("xo.lan", PhoneRelay.Target.of("xo.lan:8443")?.name)
        assertNull(PhoneRelay.Target.of("192.168.1.20")?.name)
        assertNull(PhoneRelay.Target.of("[fd00::20]")?.name)
    }

    /**
     * CANNOT TELL IS NULL (C-5): something that answers without TLS gives no
     * certificate, and the sheet then goes no further rather than take the
     * machine's word for one.
     */
    @Test
    fun noTlsIsNoPin() {
        val server = ServerSocket(0)
        thread(isDaemon = true) {
            runCatching {
                server.accept().use { s ->
                    s.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n".toByteArray())
                }
            }
        }
        try {
            assertNull(runBlocking { PhoneRelay.ownLook("127.0.0.1:${server.localPort}") })
        } finally {
            server.close()
        }
    }
}
