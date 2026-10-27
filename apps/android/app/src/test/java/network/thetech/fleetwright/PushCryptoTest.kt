package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * PushCrypto.kt against the envelope the coordinator's own code sealed.
 *
 * test/fixtures/parity/push-envelope.json is one notification sealed by
 * src/fleet/push-crypto.js. test/push-envelope-parity.test.js opens it with
 * that code. This opens the same bytes. PushCryptoTests.swift does the same.
 */
class PushCryptoTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/push-envelope.json")
            ?: error("parity/push-envelope.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    @Test
    fun opensWhatTheCoordinatorSealed() {
        val recipient = fixture.getJSONObject("recipient")
        val pair = PushCrypto.keyPairFromJwk(recipient.getString("d"), recipient.getString("x"), recipient.getString("y"))
        assertEquals(recipient.getString("pushKey"), PushCrypto.encode(pair.public))
        val opened = PushCrypto.open(pair.private, PushCrypto.b64d(recipient.getString("pushKey")), fixture.getString("envelope"))
        val plain = fixture.getJSONObject("plaintext")
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
        val recipient = fixture.getJSONObject("recipient")
        val pair = PushCrypto.keyPairFromJwk(recipient.getString("d"), recipient.getString("x"), recipient.getString("y"))
        val bytes = PushCrypto.b64d(fixture.getString("envelope"))
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte()
        assertThrows(Exception::class.java) {
            PushCrypto.open(pair.private, PushCrypto.b64d(recipient.getString("pushKey")), PushCrypto.b64e(bytes))
        }
    }

    @Test
    fun aSealedMessageIsRoutedOnWhatWasInsideIt() {
        val recipient = fixture.getJSONObject("recipient")
        val pair = PushCrypto.keyPairFromJwk(recipient.getString("d"), recipient.getString("x"), recipient.getString("y"))
        val outer = mapOf("e" to fixture.getString("envelope"), "category" to "fleet.prompt.allow")
        val fields = PushReveal.fields(outer) { envelope ->
            PushCrypto.open(pair.private, PushCrypto.b64d(recipient.getString("pushKey")), envelope)
        }
        assertFalse(fields.containsKey("e"))
        assertEquals("fleet.prompt.allow", fields["category"])
        assertEquals("xosetup", fields["kind"])
        assertEquals("p-01J8", fields["promptId"])
        assertEquals(fixture.getJSONObject("plaintext").getString("title"), fields["title"])
        assertEquals(fixture.getJSONObject("plaintext").getString("body"), fields["body"])
    }

    @Test
    fun aSealThatDoesNotOpenIsTheFallbackSentenceAndNothingElse() {
        val fields = PushReveal.fields(mapOf("e" to "not-an-envelope", "kind" to "xosetup", "category" to "fleet.prompt.allow")) {
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
}
