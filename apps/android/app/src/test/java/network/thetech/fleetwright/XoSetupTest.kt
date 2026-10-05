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
import java.util.Base64

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
    }

    @Test
    fun theSignInIsSealedToTheJobsKeyUnderItsAad() {
        val to = Seal.newKey()
        val sealed = XoSetup.sealSignIn(to.publicKey, job, address, "admin@example.com", "hunter2")
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
    fun aPinIsGroupedForReading() {
        assertEquals(
            "00112233 44556677 8899aabb ccddeeff 00112233 44556677 8899aabb ccddeeff",
            XoSetup.groupedPin("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
        )
    }
}
