package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.ZoneId
import java.util.Base64
import java.util.Locale

/**
 * The check that decides whether a Xen Orchestra sign-in is sealed at all,
 * run rather than read.
 *
 * WHY A JUNIT TEST. test/xosetup-android-in-apps.test.js holds the words and
 * the order of the screen equal with iOS, which is answerable by reading the
 * Kotlin. Whether a 64-byte r||s signature from WebCrypto is accepted by
 * java.security, which wants DER, is a question about arithmetic, and the one
 * way to lose it quietly is a conversion that refuses every real signature or
 * accepts a mangled one. So: a key made here signs the documented input, the
 * DER is unpacked back to raw as a host would send it, and the phone must say
 * yes to that and no to every nearby wrong thing.
 *
 * The certificate is here for a smaller version of the same reason: whether a
 * half-filled `certificate` lands on the side that asks, what a date says in
 * a locale, and when `trust` is sent are run, not read, because the one way
 * to lose them quietly is a parse that turns a JSON null into the word
 * "null" or a missing `problems` into "trusted".
 */
class XoSetupTest {

    private val address = "xo.lan:443"
    private val job = "a1b2c3d4e5f6"
    private val key = "A".repeat(87)
    private val pin = "b".repeat(64)

    private fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    /** DER SEQUENCE { INTEGER r, INTEGER s } back to the raw r||s WebCrypto emits. */
    private fun rawFromDer(der: ByteArray): ByteArray {
        var i = 2
        fun integer(): ByteArray {
            require(der[i] == 2.toByte())
            val len = der[i + 1].toInt() and 0xff
            val body = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            return fixed32(BigInteger(1, body))
        }
        return integer() + integer()
    }

    private val pair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    private val hostKey: JSONObject = (pair.public as ECPublicKey).w.let { w ->
        JSONObject().put("kty", "EC").put("crv", "P-256").put("x", b64(fixed32(w.affineX))).put("y", b64(fixed32(w.affineY)))
    }

    private fun sign(input: ByteArray): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.private)
        update(input)
        b64(rawFromDer(sign()))
    }

    @Test
    fun theSigningInputIsTheDocumentedBytes() {
        assertEquals(
            "agent-fleet/v1/xosetup-key\n{\"address\":\"xo.lan:443\",\"job\":\"a1b2c3d4e5f6\",\"key\":\"${key}\",\"pin\":\"${pin}\"}",
            String(XoSetup.signingInput(address, job, key, pin), Charsets.UTF_8),
        )
        // Plain HTTP: no certificate, so the machine signs over an empty pin,
        // and the key stays in the JSON rather than being dropped.
        assertEquals(
            "agent-fleet/v1/xosetup-key\n{\"address\":\"xo.lan:443\",\"job\":\"a1b2c3d4e5f6\",\"key\":\"${key}\",\"pin\":\"\"}",
            String(XoSetup.signingInput(address, job, key, ""), Charsets.UTF_8),
        )
    }

    @Test
    fun aRawSignatureByTheHostKeyIsAccepted() {
        val input = XoSetup.signingInput(address, job, key, pin)
        // Many signatures, because r and s each have a leading zero or a set
        // top bit about one time in a few, and the DER wrapping has to get
        // every one of those right.
        repeat(40) {
            assertTrue(XoSetup.verifyKeySig(hostKey, sign(input), input))
        }
        // And over the empty pin of a plain-HTTP setup, which is a different
        // input from any fingerprint's: a signature for one is not for the other.
        val plain = XoSetup.signingInput(address, job, key, "")
        assertTrue(XoSetup.verifyKeySig(hostKey, sign(plain), plain))
        assertFalse(XoSetup.verifyKeySig(hostKey, sign(plain), input))
        assertFalse(XoSetup.verifyKeySig(hostKey, sign(input), plain))
    }

    @Test
    fun anythingElseIsRefused() {
        val input = XoSetup.signingInput(address, job, key, pin)
        val good = sign(input)
        // A different job, address, key or pin is a different input.
        assertFalse(XoSetup.verifyKeySig(hostKey, good, XoSetup.signingInput(address, "ffffffffffff", key, pin)))
        assertFalse(XoSetup.verifyKeySig(hostKey, good, XoSetup.signingInput("other.lan", job, key, pin)))
        assertFalse(XoSetup.verifyKeySig(hostKey, good, XoSetup.signingInput(address, job, "B".repeat(87), pin)))
        assertFalse(XoSetup.verifyKeySig(hostKey, good, XoSetup.signingInput(address, job, key, "c".repeat(64))))
        // A signature by some other key, however well formed.
        val other = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        val otherKey = (other.public as ECPublicKey).w.let { w ->
            JSONObject().put("kty", "EC").put("crv", "P-256").put("x", b64(fixed32(w.affineX))).put("y", b64(fixed32(w.affineY)))
        }
        assertFalse(XoSetup.verifyKeySig(otherKey, good, input))
        // And nothing malformed gets through as a yes.
        assertFalse(XoSetup.verifyKeySig(null, good, input))
        assertFalse(XoSetup.verifyKeySig(hostKey, null, input))
        assertFalse(XoSetup.verifyKeySig(hostKey, "", input))
        assertFalse(XoSetup.verifyKeySig(hostKey, good.dropLast(4), input))
        assertFalse(XoSetup.verifyKeySig(hostKey, "$good==", input))
        assertFalse(XoSetup.verifyKeySig(JSONObject(hostKey.toString()).put("crv", "P-384"), good, input))
    }

    @Test
    fun theInputRefusesAValueThatWouldNeedEscaping() {
        for (bad in listOf("xo.lan\"", "https://xo.lan", "xo lan", "")) {
            assertTrue(runCatching { XoSetup.signingInput(bad, job, key, pin) }.isFailure)
        }
        assertTrue(runCatching { XoSetup.signingInput(address, "A1B2C3D4E5F6", key, pin) }.isFailure)
        assertTrue(runCatching { XoSetup.signingInput(address, job, key, pin.uppercase()) }.isFailure)
        // A pin is a whole fingerprint or nothing: a part of one is neither.
        assertTrue(runCatching { XoSetup.signingInput(address, job, key, pin.take(63)) }.isFailure)
        assertTrue(runCatching { XoSetup.signingInput(address, job, key, " ") }.isFailure)
    }

    @Test
    fun whoCanRunItAndWhatEachProbeSays() {
        val https = Fleet.Probe("deb14", reachable = true, xo = true, tls = true, cert = pin, version = "5.100.0")
        val plain = https.copy(hostId = "rpi", tls = false, cert = null, version = null)
        val noCert = https.copy(hostId = "nuc", cert = null)
        val unreached = https.copy(hostId = "far", reachable = false)
        assertTrue(XoSetup.pinned(https))
        assertFalse(XoSetup.plain(https))
        assertTrue(XoSetup.plain(plain))
        assertFalse(XoSetup.pinned(plain))
        // Over TLS with no readable certificate is neither: nothing to pin to,
        // and not plain HTTP either.
        assertFalse(XoSetup.pinned(noCert))
        assertFalse(XoSetup.plain(noCert))
        assertFalse(XoSetup.pinned(unreached))
        assertFalse(XoSetup.plain(unreached))
        // What was found over plain HTTP, with `xo` kept three-valued: null is
        // cannot tell, and is never rounded to no.
        assertEquals("Reached Xen Orchestra over plain HTTP", XoSetup.describe(plain))
        assertEquals("Reached something over plain HTTP, and it does not look like Xen Orchestra", XoSetup.describe(plain.copy(xo = false)))
        assertEquals("Reached something over plain HTTP; cannot tell whether it is Xen Orchestra", XoSetup.describe(plain.copy(xo = null)))
        assertEquals("Reached it over HTTPS. Xen Orchestra 5.100.0", XoSetup.describe(https))
        assertEquals("Could not reach it", XoSetup.describe(unreached))
    }

    @Test
    fun theSignInIsSealedToTheJobsKeyUnderItsAad() {
        val to = Seal.newKey()
        val reply = Seal.newKey()
        val sealed = XoSetup.sealSignIn(to.publicKey, job, address, "admin@example.com", "hunter2", reply.publicKey)
        val parts = sealed.split(".")
        assertEquals(3, parts.size)
        val opened = Seal.open(
            to,
            "fleetwright-xosetup/v1:$job:$address",
            JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2]),
        )
        assertEquals(1, opened.getInt("v"))
        assertEquals("admin@example.com", opened.getJSONObject("xo").getString("email"))
        assertEquals("hunter2", opened.getJSONObject("xo").getString("password"))
        // The key the token comes back to travels inside the seal.
        assertEquals(reply.publicKey, opened.getString("reply"))
        // Another job's additional data does not open it.
        assertTrue(
            runCatching {
                Seal.open(to, "fleetwright-xosetup/v1:ffffffffffff:$address", JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2]))
            }.isFailure,
        )
    }

    @Test
    fun stepWordsAreTheStepsWordsAndANumberOtherwise() {
        assertEquals("Reaching Xen Orchestra", XoSetup.stepWords("connect", 0, 8))
        assertEquals("Handing over", XoSetup.stepWords("hand-off", 7, 8))
        assertEquals("Done", XoSetup.stepWords("done", 8, 8))
        // A key this app has never heard of: the number, one-based.
        assertEquals("Step 3 of 9", XoSetup.stepWords("new-step", 2, 9))
        assertEquals("Step 9 of 9", XoSetup.stepWords(null, 12, 9))
    }

    @Test
    fun aCertificateIsReadTolerantly() {
        assertEquals(null, XoSetup.certificate(null))
        val full = XoSetup.certificate(
            JSONObject(
                """{"trusted":false,"problems":["self-signed","name-mismatch","made-up"],"subject":"CN=xo.lan","issuer":"CN=xo.lan",""" +
                    """"notBefore":"2025-10-03T12:00:00.000Z","notAfter":"2026-10-03T12:00:00.000Z","names":["xo.lan","10.0.0.5"]}""",
            ),
        )!!
        assertFalse(full.trusted)
        // A problem this app has no words for is dropped; the order is the machine's.
        assertEquals(listOf("self-signed", "name-mismatch"), full.problems)
        assertEquals("CN=xo.lan", full.subject)
        assertEquals("2026-10-03T12:00:00.000Z", full.notAfter)
        assertEquals(listOf("xo.lan", "10.0.0.5"), full.names)
        // Trusted only when said so AND nothing is named wrong: the doubtful
        // case lands on the side that asks.
        assertTrue(XoSetup.certificate(JSONObject("""{"trusted":true,"problems":[]}"""))!!.trusted)
        assertFalse(XoSetup.certificate(JSONObject("""{"trusted":true,"problems":["expired"]}"""))!!.trusted)
        assertFalse(XoSetup.certificate(JSONObject("""{"problems":[]}"""))!!.trusted)
        // Missing, null and wrongly typed fields are absent, never the word "null".
        val bare = XoSetup.certificate(JSONObject("""{"trusted":"yes","subject":null,"issuer":"","names":"xo.lan"}"""))!!
        assertFalse(bare.trusted)
        assertEquals(null, bare.subject)
        assertEquals(null, bare.issuer)
        assertEquals(null, bare.notBefore)
        assertEquals(emptyList<String>(), bare.names)
        assertEquals(emptyList<String>(), bare.problems)
    }

    @Test
    fun whatIsWrongIsSaidInTheWordsBothPhonesUse() {
        val zone = ZoneId.of("UTC")
        val uk = Locale.UK
        val c = Fleet.Certificate(
            trusted = false,
            problems = listOf("self-signed", "untrusted-issuer", "expired", "not-yet-valid", "name-mismatch"),
            subject = "CN=xo",
            issuer = "CN=Example CA",
            notBefore = "2027-01-02T00:00:00.000Z",
            notAfter = "2026-03-04T00:00:00.000Z",
            names = emptyList(),
        )
        assertEquals(
            listOf(
                "Self-signed: nothing but the server itself vouches for it.",
                "Signed by an authority this machine does not trust.",
                "Expired on 4 Mar 2026.",
                "Not valid until 2 Jan 2027.",
                "Issued for a different name than xo.lan:443.",
            ),
            XoSetup.problemLines(c, address, zone, uk),
        )
        assertEquals(listOf("This machine could not read the certificate’s details."), XoSetup.problemLines(null, address, zone, uk))
        // Distrusted with no reason named is said as that, never as fine.
        assertEquals(listOf("Not trusted by that machine, which did not say why."), XoSetup.problemLines(c.copy(problems = emptyList()), address, zone, uk))
        // A date the machine wrote that does not parse is shown as written.
        assertEquals("Expired on sometime.", XoSetup.problemLines(c.copy(problems = listOf("expired"), notAfter = "sometime"), address, zone, uk).single())
        // A trusted one has nothing to say here, and one calm line elsewhere.
        val fine = c.copy(trusted = true, problems = emptyList())
        assertEquals(emptyList<String>(), XoSetup.problemLines(fine, address, zone, uk))
        assertEquals("Its certificate checks out: issued to CN=xo by CN=Example CA, valid until 4 Mar 2026.", XoSetup.trustedLine(fine, zone, uk))
        assertEquals("Its certificate checks out.", XoSetup.trustedLine(fine.copy(subject = null, issuer = null, notAfter = null), zone, uk))
    }

    @Test
    fun trustIsSentOnlyForAnAcknowledgedCertificateThatDidNotCheckOut() {
        val fine = Fleet.Certificate(true, emptyList(), null, null, null, null, emptyList())
        val bad = fine.copy(trusted = false, problems = listOf("self-signed"))
        assertEquals(null, XoSetup.trustFor(fine, acknowledged = true))
        assertEquals(null, XoSetup.trustFor(fine, acknowledged = false))
        assertEquals("accepted", XoSetup.trustFor(bad, acknowledged = true))
        assertEquals(null, XoSetup.trustFor(bad, acknowledged = false))
        // A certificate the machine could not read is one nobody vouched for.
        assertEquals("accepted", XoSetup.trustFor(null, acknowledged = true))
        assertEquals(null, XoSetup.trustFor(null, acknowledged = false))
    }

    @Test
    fun aPinIsGroupedForReading() {
        assertEquals(
            "00112233 44556677 8899aabb ccddeeff 00112233 44556677 8899aabb ccddeeff",
            XoSetup.groupedPin("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
        )
    }
}
