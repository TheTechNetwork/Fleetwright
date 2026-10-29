package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

/**
 * PushCrypto.kt against the envelope the coordinator's own code sealed.
 *
 * test/fixtures/parity/push-envelope.json is one notification sealed by
 * `envelopeFor` in src/fleet/push.js: an answerable prompt, with the category
 * sealed beside the digits. test/push-envelope-parity.test.js opens it with
 * that code. This opens the same bytes. PushCryptoTests.swift does the same.
 */
class PushCryptoTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/push-envelope.json")
            ?: error("parity/push-envelope.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    private val recipient: JSONObject get() = fixture.getJSONObject("recipient")
    private val plain: JSONObject get() = fixture.getJSONObject("plaintext")
    private val pushKey: ByteArray get() = PushCrypto.b64d(recipient.getString("pushKey"))

    private fun pair(): KeyPair =
        PushCrypto.keyPairFromJwk(recipient.getString("d"), recipient.getString("x"), recipient.getString("y"))

    private fun opened(): (String) -> PushCrypto.Opened = { PushCrypto.open(pair().private, pushKey, it) }

    @Test
    fun opensWhatTheCoordinatorSealed() {
        val pair = pair()
        assertEquals(recipient.getString("pushKey"), PushCrypto.encode(pair.public))
        val opened = PushCrypto.open(pair.private, pushKey, fixture.getString("envelope"))
        assertEquals(plain.getString("title"), opened.title)
        assertEquals(plain.getString("body"), opened.body)
        val data = plain.getJSONObject("data")
        val keys = data.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            assertEquals(data.getString(key), opened.data[key])
        }
        assertEquals(data.length(), opened.data.size)
    }

    @Test
    fun aFlippedBitDoesNotOpen() {
        val bytes = PushCrypto.b64d(fixture.getString("envelope"))
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte()
        assertThrows(Exception::class.java) {
            PushCrypto.open(pair().private, pushKey, PushCrypto.b64e(bytes))
        }
    }

    @Test
    fun aSealedMessageIsRoutedOnWhatWasInsideIt() {
        val category = plain.getJSONObject("data").getString("category")
        val fields = PushReveal.fields(mapOf("e" to fixture.getString("envelope"), "category" to category), opened())
        assertFalse(fields.containsKey("e"))
        // What a tap and a press read: where to go, the answer, its age.
        for (key in listOf("event", "name", "hostId", "promptId", "answers", "sentAt")) {
            assertEquals(key, plain.getJSONObject("data").getString(key), fields[key])
        }
        assertEquals(category, fields["category"])
        assertEquals(plain.getString("title"), fields["title"])
        assertEquals(plain.getString("body"), fields["body"])
    }

    /**
     * The sealed category decides the buttons, and a clear one that disagrees
     * with it leaves none: the message is then posted without them.
     */
    @Test
    fun theSealedCategoryDecidesTheButtons() {
        val envelope = fixture.getString("envelope")
        val sealed = plain.getJSONObject("data").getString("category")

        val changed = PushReveal.fields(mapOf("e" to envelope, "category" to "fleet.prompt.trust"), opened())
        assertNull("a changed clear category kept its buttons", changed["category"])
        assertEquals(plain.getString("body"), changed["body"])

        val dropped = PushReveal.fields(mapOf("e" to envelope), opened())
        assertEquals(sealed, dropped["category"])

        // A sealed "nothing to answer" is not overruled by a category added on the way.
        assertEquals("", PushReveal.category(sealed = "", clear = sealed))
        // A coordinator from before the category was sealed: the clear one, as always.
        val older = PushReveal.fields(mapOf("e" to envelope, "category" to sealed)) {
            PushCrypto.Opened("t", "b", mapOf("name" to "cc-brave-otter"))
        }
        assertEquals(sealed, older["category"])
    }

    @Test
    fun aSealThatDoesNotOpenIsTheFallbackSentenceAndNothingElse() {
        val fields = PushReveal.fields(mapOf("e" to "not-an-envelope", "kind" to "xosetup", "category" to "fleet.prompt.permission")) {
            throw IllegalArgumentException("tag")
        }
        assertEquals(PushReveal.FALLBACK_TITLE, fields["title"])
        assertEquals(PushReveal.FALLBACK_BODY, fields["body"])
        assertNull(fields["kind"])
        assertNull(fields["category"])
        assertNull(fields["e"])
    }

    @Test
    fun anUnsealedMessageIsLeftAsItArrived() {
        val outer = mapOf("kind" to "xosetup", "job" to "job-1")
        assertEquals(outer, PushReveal.fields(outer) { error("nothing was sealed") })
    }

    /**
     * The register-time self-test, with a key in memory: what registration
     * runs against the Keystore key before it sends it (PushKey).
     */
    @Test
    fun theSelfTestOpensItsOwnSealAndSaysWhenItCannot() {
        val pair = pair()
        assertTrue(PushCrypto.opensItsOwnSeal(pair.private, pushKey, null))

        // The seal is the coordinator's scheme: the key opens what it seals.
        val opened = PushCrypto.open(pair.private, pushKey, PushCrypto.seal(pushKey, "a", "b"))
        assertEquals("a", opened.title)
        assertEquals("b", opened.body)

        // A key that does not match the one sealed to cannot open it.
        val other = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        assertFalse(PushCrypto.opensItsOwnSeal(other.private, pushKey, null))
        // A platform with no such provider cannot either, and says so as false.
        assertFalse(PushCrypto.opensItsOwnSeal(pair.private, pushKey, "NoSuchKeystore"))
    }
}
