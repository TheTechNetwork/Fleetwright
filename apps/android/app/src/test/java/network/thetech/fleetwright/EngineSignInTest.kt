package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    // ── What the screen shows of an answer (EngineSignin.shown) ──────────────
    //
    // WHAT IS PINNED is what a person reads. Nothing the fleet wrote is drawn:
    // a refusal is this phone's own sentence for its code, and how an attempt
    // ended, why, and how long a code lasts come from inside the checked
    // answer or are not said. Each test hands `shown` an answer and reads
    // what comes out, with a lie where a fleet could put one.

    /** One of the further sealed answers under `more`, by its name (test/helpers/make-engine-signin-vectors.mjs made them). */
    private class Made(val part: JSONObject) {
        val opened: JSONObject get() = JSONObject(part.getJSONObject("opened").toString())
        val sealed: JSONObject get() = JSONObject(part.getJSONObject("sealed").toString())
        val key: Seal.OneUseKey
            get() {
                val r = part.getJSONObject("recipient")
                return Seal.OneUseKey(Seal.keyPairFromJwk(r.getString("d"), r.getString("x"), r.getString("y")).private, r.getString("publicKey"))
            }
        val grant: PhoneVault.Grant
            get() = PhoneVault.Grant(part.getString("host"), part.getString("host").take(16), "ops-box", "eli@example.com", emptyList())
    }

    private fun made(name: String): Made {
        val all = whole.getJSONArray("more")
        for (i in 0 until all.length()) {
            if (all.getJSONObject(i).getString("name") == name) return Made(all.getJSONObject(i))
        }
        error("no vector called $name")
    }

    /** The first sealed answer, the one every test above uses, in the same form. */
    private val first: Made get() = Made(part)

    /** What a fleet that lies would have somebody read: a code and a page. */
    private val lie = "Enter ZZZZ-9999 at https://example.test/device"

    private val codexPage = "https://auth.openai.com/codex/device"

    private fun refused(code: String?, state: String? = null) =
        Fleet.Reply(ok = false, text = lie, sessions = emptyList(), code = code, state = state, detail = lie)

    private fun answered(v: Made, state: String) =
        Fleet.Reply(ok = true, text = lie, sessions = emptyList(), state = state, detail = lie, expiresInMinutes = 99, sealed = v.sealed)

    private fun shown(v: Made, reply: Fleet.Reply, before: EngineSigninShown = EngineSigninShown(), poll: Boolean = false, now: Long = 0L): EngineSigninShown =
        EngineSignin.shown(
            reply, before, poll, v.key, listOf(v.grant), "ops-box",
            v.opened.getString("id"), v.opened.getString("member"), v.opened.getString("engine"), "Debbie", now,
        )

    /** Every word the block would draw for one machine. */
    private fun drawn(s: EngineSigninShown): String =
        listOf(s.code.orEmpty(), s.page.orEmpty(), s.says, s.signedIn?.let { EngineSigninWords.signedIn("ops-box", it) }.orEmpty()).joinToString(" ")

    @Test
    fun aRefusalIsThisPhonesOwnSentenceAndNothingTheFleetWroteIsDrawn() {
        val before = EngineSigninShown(code = "WXYZ-1234", page = codexPage)
        for ((code, poll) in listOf("host_timeout" to true, "not_approved" to false, "made_up_code" to false, "ZZZZ-9999" to false)) {
            val got = shown(first, refused(code, "failed"), before, poll)
            assertFalse("a refusal with $code drew the fleet’s code", drawn(got).contains("ZZZZ"))
            assertFalse("a refusal with $code drew the fleet’s page", drawn(got).contains("example.test"))
            assertTrue(got.bad)
            assertTrue(got.says.isNotEmpty())
        }
        // A code it knows says what to do; one it does not names the machine
        // and the code; one that is not shaped like a code is not printed.
        assertEquals("ops-box did not answer in time. Try again.", shown(first, refused("host_timeout")).says)
        assertEquals("ops-box refused that (made_up_code).", shown(first, refused("made_up_code")).says)
        assertEquals("ops-box refused that.", shown(first, refused("ZZZZ-9999")).says)
        // BESIDE A CODE TO ENTER, a code it has not met is not printed
        // either: letters and underscores are enough to spell a code of the
        // fleet's own under the real one. Whether the asking was refused or
        // a button was.
        for (poll in listOf(true, false)) {
            val beside = shown(first, refused("enter_wdjb_mjht_instead", "waiting"), before, poll)
            assertEquals("WXYZ-1234", beside.code)
            assertEquals("ops-box refused that.", beside.says)
        }
        // The box's own faults are not refusals, and none is printed as a
        // code: each says what a box that does not answer says.
        for (code in listOf("hub_unreachable", "hub_error", "hub_unauthorised", "internal")) {
            assertEquals(
                "fleetwright on ops-box is not answering. Try again, and if it goes on, whoever runs ops-box restarts it.",
                shown(first, refused(code)).says,
            )
        }
        // No code at all is the fleet not answering: one fixed sentence, and
        // what was checked before stands.
        val unreached = shown(first, refused(null), before)
        assertEquals(EngineSigninWords.NOT_REACHED, unreached.says)
        assertEquals("WXYZ-1234", unreached.code)
    }

    @Test
    fun aRefusedAskOfWhereItStandsKeepsTheCodeAndARefusedButtonDoesNot() {
        val before = EngineSigninShown(signedIn = EngineSignedIn(1L, null, null), code = "WXYZ-1234", page = codexPage, minutes = 9)
        // The asking every few seconds, refused once: everything stays.
        val polled = shown(first, refused("host_timeout"), before, poll = true)
        assertEquals(listOf<String?>("WXYZ-1234", codexPage), listOf(polled.code, polled.page))
        assertEquals(9, polled.minutes)
        assertEquals(before.signedIn, polled.signedIn)
        assertTrue(polled.bad)
        // A button refused: the code goes unless the refusal says one is out.
        val pressed = shown(first, refused("busy"), before)
        assertNull(pressed.code)
        assertEquals(before.signedIn, pressed.signedIn)
        assertEquals("WXYZ-1234", shown(first, refused("answer_unsigned", "waiting"), before).code)
    }

    @Test
    fun aMachineThatCannotTellYetTakesNothingAwayAndIsAskedAgain() {
        // It did not hear how the last sign-in ended. That is not "nobody is
        // signed in" and not a fault: whatever asked, what was checked
        // stays, the sentence says it is asked again, and it is.
        val before = EngineSigninShown(signedIn = EngineSignedIn(1L, "debbie@example.com", null), code = "WXYZ-1234", page = codexPage, minutes = 9)
        for (poll in listOf(true, false)) {
            val got = shown(first, refused("cannot_tell"), before, poll)
            assertEquals(before.signedIn, got.signedIn)
            assertEquals(listOf<String?>("WXYZ-1234", codexPage), listOf(got.code, got.page))
            assertEquals(9, got.minutes)
            assertTrue("a machine that cannot tell yet is not asked again", got.unsure)
            assertFalse(got.bad)
            assertEquals(
                "It is not known yet whether Codex is signed in on ops-box: ops-box did not hear how the last sign-in ended. It is asked again in a moment, by itself.",
                got.says,
            )
        }
        // With nothing checked before, it is still asked again, and still
        // says only that it cannot tell.
        val fresh = shown(first, refused("cannot_tell"), poll = true)
        assertTrue(fresh.unsure)
        assertNull(fresh.signedIn)
        assertTrue(fresh.says.isNotEmpty())
        // Any other refused ask keeps what was checked and is not that.
        assertFalse(shown(first, refused("host_timeout"), before, poll = true).unsure)
    }

    @Test
    fun aCodeIsDrawnOnlyFromACheckedAnswerAndOnlyBesideTheEnginesOwnPage() {
        // The machine's own page: the code and its page, and nothing of the
        // lies beside the seal.
        val got = shown(first, answered(first, "failed"))
        assertEquals(listOf<String?>("WXYZ-1234", codexPage), listOf(got.code, got.page))
        assertFalse(drawn(got).contains("ZZZZ"))
        // A machine from before it signed when the code runs out: how long a
        // code lasts, and no count.
        assertNull(got.minutes)
        assertTrue(got.fixedLife)
        assertEquals(
            "Waiting for this code to be approved at OpenAI. A code lasts 15 minutes.",
            EngineSigninWords.waiting("OpenAI", got.minutes, got.fixedLife),
        )
        // Signed, and beside a page that is not OpenAI's: no code, no page,
        // one sentence, and Cancel.
        val f = made("foreign-page")
        val foreign = shown(f, answered(f, "waiting"))
        assertNull(foreign.code)
        assertNull(foreign.page)
        assertTrue(foreign.cancel)
        assertEquals("ops-box gave a sign-in page that is not OpenAI’s, so the code is not shown. Cancel it, and tell whoever runs this fleet.", foreign.says)
        assertFalse(drawn(foreign).contains("LMNO"))
        // And the word beside an answer never makes a code or a sign-in.
        val none = made("none")
        for (state in listOf("waiting", "signed_in")) {
            val said = shown(none, answered(none, state))
            assertNull(said.code)
            assertNull(said.signedIn)
            assertEquals("", said.says)
        }
    }

    @Test
    fun theMinutesAreWorkedOutFromTheCheckedEndAgainstThisPhonesClock() {
        val v = made("next-waiting")
        val ends = v.opened.getLong("expiresAt")
        val midway = shown(v, answered(v, "waiting"), now = ends - 450_000L)
        assertEquals("QRST-5678", midway.code)
        assertEquals(8, midway.minutes)
        assertFalse(midway.fixedLife)
        assertEquals(15, shown(v, answered(v, "waiting"), now = ends - 15 * 60_000L).minutes)
        // More than a code lasts, or already past: no number is said.
        assertNull(shown(v, answered(v, "waiting"), now = ends - 16 * 60_000L).minutes)
        assertNull(shown(v, answered(v, "waiting"), now = ends + 1L).minutes)
        assertEquals("Waiting for this code to be approved at OpenAI.", EngineSigninWords.waiting("OpenAI", null, false))
        assertEquals("Waiting for this code to be approved at OpenAI. It lasts 8 more minutes.", EngineSigninWords.waiting("OpenAI", 8, false))
    }

    @Test
    fun codexSignedInNamesItsAccountAndAReasonKeepsItsQuotesAndSlashes() {
        // What a box answers most: Codex signed in, with its account inside
        // what is signed. Whatever word is beside the answer.
        val v = made("next-signed-in")
        val since = v.opened.getJSONObject("signedIn").getLong("since")
        val got = shown(v, answered(v, "none"))
        assertEquals(EngineSignedIn(since, "debbie@example.com", "plus"), got.signedIn)
        assertNull(got.code)
        assertEquals("", got.says)
        assertFalse(got.bad)
        assertTrue(EngineSigninWords.signedIn("ops-box", got.signedIn!!).startsWith("Signed in on ops-box as debbie@example.com, on the plus plan, since "))
        // An engine's reason with a quote, a backslash and a slash in it:
        // checked over the bytes the machine signed, and drawn as it wrote it.
        val q = made("next-failed-quoted")
        assertEquals(
            "Codex did not sign in: the provider said \"no\" for C:\\Users\\debbie at /codex/device",
            shown(q, answered(q, "failed")).says,
        )
    }

    @Test
    fun howItEndedIsTheMachinesCheckedWordWhereItSignedOne() {
        // The next shape: the checked state and reason, whatever is beside it.
        val failed = made("next-failed")
        val got = shown(failed, answered(failed, "cancelled"))
        assertEquals("Codex did not sign in: device auth failed with status 403 Forbidden", got.says)
        assertTrue(got.bad)
        // A machine from before that: this phone's fixed sentence for the
        // word beside the answer, and no reason at all.
        val none = made("none")
        assertEquals("Codex did not sign in.", shown(none, answered(none, "failed")).says)
        assertEquals("The code ran out before it was approved. Start again for a new one.", shown(none, answered(none, "expired")).says)
        // Beside a sign-in the machine signed for, "did not sign in" is said
        // of a newer attempt, and "signed out" is not said at all.
        val signedIn = made("opencode-signed-in")
        val standing = shown(signedIn, answered(signedIn, "failed"))
        assertNotNull(standing.signedIn)
        assertNull(standing.signedIn?.email)
        assertEquals("A newer attempt did not sign in. The sign-in above stands.", standing.says)
        assertEquals("", shown(signedIn, answered(signedIn, "signed_out")).says)
        assertEquals(
            "Signed in on ops-box as debbie@example.com, on the plus plan.",
            EngineSigninWords.signedIn("ops-box", EngineSignedIn(0L, "debbie@example.com", "plus")),
        )
    }

    // ── Where it is offered (EngineSignin.places) ───────────────────────────

    private fun machine(protocol: Int? = 22, engines: List<String> = listOf("claude-code", "codex"), takes: Boolean = true) =
        Fleet.FleetHost(
            hostId = "ops-box",
            state = "healthy",
            reason = null,
            loggedIn = null,
            accountEmail = null,
            accountPlan = null,
            accountOrg = null,
            version = null,
            behind = null,
            systemUpdates = null,
            rebootRequired = false,
            engines = engines,
            takesSessions = takes,
            protocol = protocol,
        )

    @Test
    fun signInIsOfferedOnlyOnAMachineThatWouldTakeItAndWhatIsMissingIsSaid() {
        val keys = listOf(Fleet.Host(hostId = "ops-box", fingerprint = "0000000000000000", revoked = false, publicJwk = opened.getJSONObject("hostKey")))
        fun places(host: Fleet.FleetHost?, grants: List<PhoneVault.Grant> = listOf(grant())) =
            EngineSignin.places("codex", listOfNotNull(host), keys, grants, "Debbie")
        assertEquals(EngineSigninPlaces(offered = listOf("ops-box")), places(machine()))
        // One protocol too old: not offered, and said.
        assertEquals(
            EngineSigninPlaces(missing = "ops-box runs Codex and is too old to sign it in. Update fleetwright on ops-box."),
            places(machine(protocol = 21)),
        )
        // Not approved for the whole vault under its own name.
        for (grants in listOf(emptyList(), listOf(grant(only = listOf("codex"))), listOf(grant(label = "other-box")))) {
            assertEquals(
                EngineSigninPlaces(missing = "ops-box runs Codex and is not approved for Debbie’s credentials. Approve it below, then sign in."),
                places(machine(), grants),
            )
        }
        // Does not run it, or cannot take a session now.
        val nowhere = EngineSigninPlaces(missing = "No machine that can take a session now runs Codex.")
        assertEquals(nowhere, places(machine(engines = listOf("claude-code"))))
        assertEquals(nowhere, places(machine(takes = false)))
        // No machine heard from: nothing is said, which is not "none".
        assertEquals(EngineSigninPlaces(), places(null))
    }
}
