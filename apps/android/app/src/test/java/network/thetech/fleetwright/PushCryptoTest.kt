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

    /**
     * A key that fails its self-test is dropped only when it was made in the
     * same call. One from an earlier launch is the key the coordinator seals
     * to, and keystore2 reports a daemon that did not answer as the same
     * InvalidKeyException a refusal is: that key is kept, and the
     * registration sends the last key sent.
     */
    @Test
    fun aKeyAlreadySentIsKeptWhenItsSelfTestFails() {
        assertEquals(PushKeyRule.SelfTest.TRY_AGAIN, PushKeyRule.afterSelfTest(opened = false, madeThisCall = false))
        assertEquals(PushKeyRule.SelfTest.DROP, PushKeyRule.afterSelfTest(opened = false, madeThisCall = true))
        assertEquals(PushKeyRule.SelfTest.SEND, PushKeyRule.afterSelfTest(opened = true, madeThisCall = false))
    }

    /**
     * A key the keystore keeps refusing is replaced, so a phone does not stop
     * registering for good; and only after three failures in a row with the
     * first a day or more before. The same cases as PushCryptoTests.swift.
     */
    @Test
    fun aKeyIsReplacedOnlyAfterThreeFailuresOverADay() {
        val t0 = 1_700_000_000_000L
        val day = PushKeyRule.SPAN_MS
        val fail = { before: PushKeyRule.Failures?, at: Long -> PushKeyRule.failed(before, at) }

        // Three in two minutes is one bad moment.
        val quick = fail(fail(fail(null, t0), t0 + 60_000), t0 + 120_000)
        assertFalse(PushKeyRule.startOver(quick, t0 + 120_000))
        // The first is kept, so the next one a day on is enough.
        assertTrue(PushKeyRule.startOver(fail(quick, t0 + day), t0 + day))

        // A day apart, but only two.
        assertFalse(PushKeyRule.startOver(fail(fail(null, t0), t0 + day), t0 + day))
        // Three, the last a day after the first.
        assertTrue(PushKeyRule.startOver(fail(fail(fail(null, t0), t0 + 3_600_000), t0 + day), t0 + day))

        // A clock that went backwards starts the count again.
        assertEquals(PushKeyRule.Failures(1, t0 - 1), fail(quick, t0 - 1))
    }

    /**
     * A phone that has sent a key never registers without one: a key error
     * sends the last key sent, before the threshold and when the replacement
     * after it fails. Only a phone that has never sent one registers keyless,
     * and at once. A second failure in the same launch does not count again.
     * The same cases as PushCryptoTests.swift.
     */
    @Test
    fun aKeyErrorSendsTheLastKeySentAndNeverNone() {
        val t0 = 1_700_000_000_000L
        val day = PushKeyRule.SPAN_MS
        val broken: () -> String? = { throw java.security.KeyStoreException("keystore did not answer") }
        var replaced = 0
        val replaceFails: () -> String? = { replaced++; null }
        fun choose(failures: PushKeyRule.Failures?, sent: String?, now: Long, read: () -> String?, replace: () -> String? = replaceFails, counted: Boolean = false) =
            PushKeyRule.choose(failures, sent, now, counted, read, replace)

        // An error with a key already sent: that key goes, and the error counts.
        val first = choose(null, "K1", t0, broken)
        assertEquals("K1", first.pushKey)
        assertEquals(PushKeyRule.Failures(1, t0), first.failures)
        assertFalse(first.replaced)

        // Never sent one: keyless at once, with nothing to lose.
        val fresh = choose(null, null, t0, broken)
        assertNull(fresh.pushKey)
        assertEquals(1, fresh.failures?.count)

        // A key this phone cannot make (a fresh one that failed its self-test
        // and was dropped) is not a reason to stop sending the one it sent.
        assertEquals("K1", choose(null, "K1", t0, { null }).pushKey)

        // Past the threshold the key is replaced; when that fails too, the
        // last key sent still goes, and the count starts again.
        val due = PushKeyRule.Failures(2, t0)
        val after = choose(due, "K1", t0 + day, broken)
        assertEquals(1, replaced)
        assertTrue(after.replaced)
        assertEquals("K1", after.pushKey)
        assertNull(after.failures)

        // A replacement that works sends the new key.
        assertEquals("K2", choose(due, "K1", t0 + day, broken, { "K2" }).pushKey)

        // A second failure in the same launch is the same bad moment.
        val again = choose(due, "K1", t0 + day, broken, counted = true)
        assertEquals(due, again.failures)
        assertFalse(again.replaced)

        // A key that reads clears the count and is what goes.
        val fine = choose(due, "K1", t0, { "K2" })
        assertEquals("K2", fine.pushKey)
        assertNull(fine.failures)
        assertNull(fine.failure)
        assertEquals(1, replaced)
    }
}
