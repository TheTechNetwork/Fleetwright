package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * XoSaved.Entry: what a kept acceptance stands for, run rather than read. The
 * sheet skips the certificate box when `accepts` says yes, so a rule that
 * drifted here would be a certificate nobody looked at, sent a password. The
 * same cases as XOSavedTests.swift. The Keystore key and the prompt need a
 * device and are held by test/xo-saved-in-apps.test.js.
 */
class XoSavedTest {
    private val pin = "ab".repeat(32)

    private fun probe(cert: String?, tls: Boolean) =
        Fleet.Probe("box", reachable = true, xo = true, tls = tls, cert = cert, version = null)

    @Test
    fun acceptsTheSameCertificateOnly() {
        val kept = XoSaved.Entry(null, null, acceptedPin = pin, acceptedPlain = false)
        assertTrue(kept.accepts(probe(pin, tls = true)))
        assertFalse(kept.accepts(probe("cd".repeat(32), tls = true)))
        // An address that now answers without HTTPS is a different answer.
        assertFalse(kept.accepts(probe(null, tls = false)))
    }

    @Test
    fun plainHttpIsAcceptedOnlyForPlainHttp() {
        val kept = XoSaved.Entry(null, null, acceptedPin = null, acceptedPlain = true)
        assertTrue(kept.accepts(probe(null, tls = false)))
        assertFalse(kept.accepts(probe(pin, tls = true)))
    }

    @Test
    fun noAcceptanceAcceptsNothing() {
        val kept = XoSaved.Entry("a@b", "p", acceptedPin = null, acceptedPlain = false)
        assertFalse(kept.accepts(probe(pin, tls = true)))
        assertFalse(kept.accepts(probe(null, tls = false)))
    }

    @Test
    fun roundTripsThroughJson() {
        val kept = XoSaved.Entry("a@b", "p", acceptedPin = pin, acceptedPlain = false)
        assertEquals(kept, XoSaved.Entry.fromJson(kept.toJson()))
        val plain = XoSaved.Entry(null, null, acceptedPin = null, acceptedPlain = true)
        assertEquals(plain, XoSaved.Entry.fromJson(plain.toJson()))
    }
}
