package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * EngineSignin.verified against an answer a machine's own code sealed and
 * signed.
 *
 * test/fixtures/parity/engine-signin-answer.json holds one answer to an
 * engine's sign-in as a phone is sent it: sealed to a key whose private half
 * is written there, carrying the machine's key and its signature. A seal and
 * an ECDSA signature come out different every time, so neither can be made
 * again here. What this shows is that the phone opens that answer, accepts
 * it, and refuses it once anything a person would be shown, or anything that
 * ties it to the request, is changed. EngineSignInTests.swift does the same
 * on iOS.
 *
 * WHAT IS PINNED is the order a code is reached by: opened with the request's
 * own key, then the key held to a grant for the whole vault under the machine
 * that was asked, then the signature over the request's own id, member and
 * engine. Each test fails one step and expects the answer for that step and
 * no code.
 */
class EngineSignInTest {

    private val whole: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/engine-signin-answer.json")
            ?: error("parity/engine-signin-answer.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    private val part: JSONObject get() = whole.getJSONObject("sealed")

    /** The answer as it opens: a copy of its own each time, because building the signed bytes takes it apart. */
    private val opened: JSONObject get() = JSONObject(part.getJSONObject("opened").toString())

    private val keyId: String get() = part.getString("host")

    private val key: Seal.OneUseKey by lazy {
        val r = part.getJSONObject("recipient")
        Seal.OneUseKey(Seal.keyPairFromJwk(r.getString("d"), r.getString("x"), r.getString("y")).private, r.getString("publicKey"))
    }

    /**
     * The grant a custodian made for the machine that answered: the whole
     * vault, under the name it was asked by.
     */
    private fun grant(label: String = "ops-box", only: List<String> = emptyList()) =
        PhoneVault.Grant(keyId, keyId.take(16), label, "eli@example.com", only)

    private fun check(
        sealed: JSONObject? = JSONObject(part.getJSONObject("sealed").toString()),
        with: Seal.OneUseKey = key,
        grants: List<PhoneVault.Grant> = listOf(grant()),
        host: String = "ops-box",
        id: String = opened.getString("id"),
        member: String = opened.getString("member"),
        engine: String = opened.getString("engine"),
    ): EngineSigninCheck = EngineSignin.verified(sealed, with, grants, host, id, member, engine)

    @Test
    fun anAnswerThatPassesEveryCheckGivesTheCodeItsPageAndWhoIsSignedIn() {
        val there = opened.getJSONObject("signedIn")
        val who = there.getJSONObject("who")
        val expected = EngineSigninSaid(
            code = opened.getString("code"),
            page = opened.getString("url"),
            signedIn = EngineSignedIn(there.getLong("since"), who.getString("email"), who.getString("plan")),
        )
        assertNotNull(expected.code)
        assertEquals(EngineSigninCheck.Verified(expected), check())
    }

    @Test
    fun anAnswerWithNothingSealedOrSealedToAnotherKeyIsNotOpened() {
        assertEquals(EngineSigninCheck.Unopened, check(sealed = null))
        assertEquals(EngineSigninCheck.Unopened, check(with = Seal.newKey()))
        // Bound to its purpose: a vault's answer is not a machine's.
        assertThrows(Exception::class.java) { Seal.open(key, Seal.VAULT_REPLY_AAD, part.getJSONObject("sealed")) }
        assertEquals(opened.getString("code"), Seal.open(key, Seal.ENGINE_SIGNIN_AAD, part.getJSONObject("sealed")).getString("code"))
    }

    @Test
    fun onlyAGrantForTheWholeVaultUnderTheMachineThatWasAskedCounts() {
        assertEquals(EngineSigninCheck.Unapproved, check(grants = emptyList()))
        assertEquals(EngineSigninCheck.Unapproved, check(grants = listOf(grant(only = listOf("codex")))))
        assertEquals(EngineSigninCheck.Unapproved, check(grants = listOf(grant(label = "other-box"))))
        // The right grant, and another machine was asked.
        assertEquals(EngineSigninCheck.Unapproved, check(host = "other-box"))
    }

    @Test
    fun theSignatureIsOverThisPhonesOwnRequest() {
        assertEquals(EngineSigninCheck.Unsigned, check(id = opened.getString("id") + "0"))
        assertEquals(EngineSigninCheck.Unsigned, check(member = "jason"))
        assertEquals(EngineSigninCheck.Unsigned, check(engine = "opencode"))
    }

    /**
     * The bytes the machine signed, built the way `verified` builds them, and
     * every change the vector lists refused under the machine's key.
     */
    @Test
    fun theSignedBytesAreTheMachinesAndEveryChangeBreaksThem() {
        val hostKey = opened.getJSONObject("hostKey")
        assertEquals(keyId, PhoneVault.keyHash(hostKey))
        val signature = opened.getString("signature")
        fun signed(): JSONObject = opened.apply {
            remove("hostKey")
            remove("signature")
        }
        val input = IntentSigning.signingInput("engine-signin-answer", signed())
        assertEquals(part.getString("signingInput"), input)
        assertTrue(XoSetup.verifyKeySig(hostKey, signature, input.toByteArray(Charsets.UTF_8)))
        val changed = part.getJSONArray("changed")
        assertTrue(changed.length() > 0)
        for (i in 0 until changed.length()) {
            val change = changed.getJSONObject(i)
            val field = change.getString("field")
            val other = signed().put(field, change.get("value"))
            val bytes = IntentSigning.signingInput("engine-signin-answer", other).toByteArray(Charsets.UTF_8)
            assertFalse("a changed $field still passed", XoSetup.verifyKeySig(hostKey, signature, bytes))
        }
    }

    /**
     * The answer an MCP client is sent, in the clear, has no `signedIn` key at
     * all: the same encoder writes its bytes too.
     */
    @Test
    fun theClearAnswersBytesAreTheMachinesToo() {
        val input = IntentSigning.signingInput(whole.getString("context"), whole.getJSONObject("payload"))
        assertEquals(whole.getString("signingInput"), input)
        assertTrue(XoSetup.verifyKeySig(whole.getJSONObject("hostKey"), whole.getString("signature"), input.toByteArray(Charsets.UTF_8)))
    }
}
