package network.thetech.fleetwright

import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DeviceSigning.kt against the bytes a box checks.
 *
 * test/fixtures/parity/intent-signing.json holds intents and the signing input
 * src/fleet/protocol/intent-signature.js builds for each;
 * test/intent-signing-parity.test.js keeps the file what that function makes.
 * Here the phone builds the same strings from the same intents, which is the
 * only way to know a box will take what this phone signs: its cases are where a
 * JSON encoder that is not JavaScript's writes different bytes.
 * IntentSigningTests.swift does the same on iOS.
 */
class IntentSigningTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/intent-signing.json")
            ?: error("parity/intent-signing.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    @Test
    fun buildsTheBytesTheBoxChecks() {
        val cases = fixture.getJSONArray("cases")
        assertTrue("the fixture lost its cases", cases.length() >= 8)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val intent = c.getJSONObject("intent")
            val p = intent.getJSONObject("params")
            val made = IntentSigning.input(
                actor = intent.getString("actor"),
                id = intent.getString("id"),
                issuedAt = intent.getLong("issuedAt"),
                params = p.keys().asSequence().associateWith { p.get(it) },
                verb = intent.getString("verb"),
                host = c.getString("host"),
            )
            assertEquals(c.getString("why"), c.getString("input"), made)
        }
    }

    @Test
    fun namesItsKeyAsTheMinterFilesIt() {
        val key = fixture.getJSONObject("key")
        val jwk = key.getJSONObject("jwk")
        assertEquals(key.getString("kid"), IntentSigning.kid(jwk.getString("x"), jwk.getString("y")))
    }

    /**
     * The signature is r || s in base64url, the form crypto.js `verify` takes,
     * and it verifies under the key's own public half. java.security signs in
     * DER, and a DER signature would be refused by every box.
     */
    @Test
    fun signsInTheFormABoxVerifies() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = pair.public as ECPublicKey
        val key = DeviceKey.of(pair.private, pub, hardware = false)
        val message = IntentSigning.input("nina@example.test", "app-0001", 1, mapOf("name" to "build"), "start", "ops-box")
        val sig = key.sign(message)
        assertEquals(86, sig.length)
        assertTrue(sig.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        val raw = java.util.Base64.getUrlDecoder().decode(sig)
        assertTrue(verify(pub, raw, message))
        assertFalse(verify(pub, raw, "$message "))
        // And the JWK it lists is that key's, as 32-byte coordinates.
        assertEquals(pub.w.affineX, BigInteger(1, java.util.Base64.getUrlDecoder().decode(key.x)))
        assertEquals(pub.w.affineY, BigInteger(1, java.util.Base64.getUrlDecoder().decode(key.y)))
        assertEquals(32, java.util.Base64.getUrlDecoder().decode(key.x).size)
    }

    /** A DER signature whose r or s has its top bit set carries a leading zero, which r || s must not. */
    @Test
    fun turnsEveryShapeOfDerIntoSixtyFourBytes() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        repeat(64) { n ->
            val der = Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private)
                update("message $n".toByteArray())
                sign()
            }
            val raw = IntentSigning.derToRaw(der)
            assertEquals(64, raw.size)
            assertTrue(verify(pair.public as ECPublicKey, raw, "message $n"))
        }
    }

    /** r || s back to DER, to check it with java.security. */
    private fun verify(pub: ECPublicKey, raw: ByteArray, message: String): Boolean {
        fun integer(half: ByteArray): ByteArray {
            val v = BigInteger(1, half).toByteArray()
            return byteArrayOf(0x02, v.size.toByte()) + v
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        val der = byteArrayOf(0x30, body.size.toByte()) + body
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(message.toByteArray(Charsets.UTF_8))
            verify(der)
        }
    }
}
