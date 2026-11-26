package network.thetech.fleetwright

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/*
 * Signing an engine in on the machine it runs on, from this phone
 * (docs/engines.md, "Signing in on the machine"). EngineSignIn.swift is the
 * same thing on iOS, in the same words, and
 * test/engines-in-apps.test.js holds the two to each other.
 *
 * WHAT HAPPENS. A custodian asks one machine to sign Codex, or OpenCode on
 * GitHub Copilot, in for a member. The engine there makes a short code, the
 * person enters it at OpenAI or GitHub in any browser, and the engine keeps
 * its sign-in on that machine. Nothing is pasted and nothing secret crosses
 * the fleet.
 *
 * THE CODE IS SHOWN ONLY AFTER THREE CHECKS, IN ORDER, and so is who is
 * signed in. The answer comes through the fleet, so it is sealed to a key
 * this phone made for that one request, and the fleet carries what it cannot
 * read. Sealing says nothing about who wrote it, because the key it is
 * sealed to is public. What only the machine can do is sign the answer with
 * the key a custodian approved for this member's credentials. So: open it,
 * hold its key to the member's approved machines, check the signature over
 * this phone's own request, and only then read anything out.
 * `EngineSignin.verified` is those steps and the only way to the code, its
 * page or the account. When one fails, none of the three is drawn, and the
 * screen says which in one sentence that stays.
 *
 * NOTHING THE FLEET COULD HAVE WRITTEN IS DRAWN HERE. A refusal's sentence
 * and an engine's reason arrive outside the seal, and a fleet that lies can
 * put a code of its own in either, to be read beside the real one. So a
 * refusal is this phone's own sentence, chosen by the refusal's code
 * ([EngineSigninWords.refusal]), and how an attempt ended, why it failed and
 * when its code runs out are read from inside the checked answer when the
 * machine put them there. A machine from before it did gets this phone's
 * fixed sentences, chosen by the word beside the answer, with no reason and
 * no countdown. That word never makes a code or a sign-in.
 *
 * NOTHING HERE IS KEPT. The code and its page live in this screen's state
 * and go with it: not held for sending later, not logged, not in a
 * notification, not in the screen's saved state. Copy and Open the sign-in
 * page are the two ways out.
 */

/**
 * Who is signed in to an engine on a machine, by that machine's own checked
 * word. [email] and [plan] are null where the engine names none, which is
 * always so for OpenCode: it keeps a token and no name.
 */
internal data class EngineSignedIn(val since: Long, val email: String?, val plan: String?)

/**
 * What a machine said of an engine's sign-in, read out of an answer only
 * after every check passed. [code] and [page] are there together while a
 * code is out, and both null otherwise.
 *
 * [state], [detail] and [expiresAt] are the machine's own word for how the
 * attempt stands, the engine's reason when it failed, and when the code runs
 * out, from inside what it signed. All three are null from a machine from
 * before it signed them, which is told from one that did by [state].
 */
internal data class EngineSigninSaid(
    val code: String?,
    val page: String?,
    val signedIn: EngineSignedIn?,
    val state: String? = null,
    val detail: String? = null,
    val expiresAt: Long? = null,
)

/** One answer, after the checks: what it said, or which check it failed. */
internal sealed class EngineSigninCheck {
    data class Verified(val said: EngineSigninSaid) : EngineSigninCheck()

    /** Nothing sealed came with it, or it did not open with this request's key. */
    object Unopened : EngineSigninCheck()

    /**
     * The key it carries is not a machine approved for the whole of this
     * member's credentials, under the name of the machine that was asked.
     */
    object Unapproved : EngineSigninCheck()

    /** That key did not sign this answer to this request. */
    object Unsigned : EngineSigninCheck()
}

/**
 * Where an engine can be signed in for one member, and what to say where it
 * cannot. [offered] is the machines to offer, by name. [missing] is one
 * sentence for a member with nowhere to sign in, or nothing when there is
 * nothing certain to say.
 */
internal data class EngineSigninPlaces(val offered: List<String> = emptyList(), val missing: String = "")

/**
 * What the screen shows of one machine. Everything about a code or an
 * account in it came through [EngineSignin.verified]. [expiresAt] is when
 * the code runs out, in milliseconds, from the machine's checked answer, and
 * null when it did not say or said a time a code's life cannot come to
 * against this phone's clock. THE MINUTES LEFT ARE NOT KEPT: a count worked
 * out when the answer came went on being drawn while the machine could not
 * be asked, past the code's end. They are counted from this each time they
 * are drawn ([EngineSignin.at]). [fixedLife] is a machine that did not say
 * at all, one from before it signed that: then the sentence says how long a
 * code lasts and no more. [says] is where the
 * last attempt stands, or a refusal as it came. [cancel] is an answer about
 * a code that is out failing a check: the code is not shown, and Cancel
 * still is, so the machine does not go on asking the provider for the rest
 * of the code's life.
 */
internal data class EngineSigninShown(
    val signedIn: EngineSignedIn? = null,
    val code: String? = null,
    val page: String? = null,
    val expiresAt: Long? = null,
    val fixedLife: Boolean = false,
    /**
     * The machine said it cannot tell yet how the last sign-in ended
     * (`cannot_tell`). Nothing that was checked is taken away for that, and
     * the machine goes on being asked, code or no code, until it can.
     */
    val unsure: Boolean = false,
    val says: String = "",
    val bad: Boolean = false,
    val cancel: Boolean = false,
)

/** The sentences, in one place. The same on iOS, word for word. */
internal object EngineSigninWords {
    const val OFFER = "Sign in on a machine"
    const val WHICH = "Which machine?"
    const val OPEN_PAGE = "Open the sign-in page"
    const val COPY = "Copy code"
    const val COPIED = "Copied"
    const val CANCEL = "Cancel"
    const val SIGN_OUT = "Sign out"
    const val THE_CODE = "the code"
    const val WHO_IS_SIGNED_IN = "who is signed in"

    /**
     * Under Sign in on a machine where a machine is signed in already: the
     * same button changes the account, and nothing said so.
     */
    const val REPLACES = "Signing in on a machine that is signed in replaces that sign-in."

    /**
     * No answer at all: the request did not reach the fleet, or what came
     * back was not an answer. Nobody refused anything.
     */
    const val NOT_REACHED = "Your fleet did not answer. Check the connection, then try again."

    /** What the block is headed, by engine. */
    fun title(engine: String): String = if (engine == "opencode") "OpenCode on GitHub Copilot" else engineName(engine)

    /** Where the code is entered. */
    fun provider(engine: String): String = if (engine == "opencode") "GitHub" else "OpenAI"

    fun offerOf(engine: String): String = "Sign $engine in on a machine"
    fun on(box: String): String = "Sign in on $box"
    fun asking(box: String): String = "Asking $box…"
    fun codeFor(box: String): String = "Code to sign in on $box"
    fun cancelOn(box: String): String = "Cancel the sign-in on $box"
    fun signOutOf(engine: String, box: String): String = "Sign $engine out on $box"
    fun signOutAsk(engine: String, box: String): String = "Sign $engine out on $box?"

    /**
     * A code read one character at a time, for TalkBack: "W X Y Z dash 1 2 3
     * 4". Read as a word, a code is a noise.
     */
    fun spoken(code: String): String = code.map { if (it == '-') "dash" else it.toString() }.joinToString(" ")

    /**
     * What TalkBack is told when a code arrives: which machine it is for,
     * then the code, a character at a time. The button under the reader's
     * finger goes when the code comes, up to most of a minute after it was
     * pressed, and nothing said so.
     */
    fun codeArrived(box: String, code: String): String = "${codeFor(box)}: ${spoken(code)}"

    /**
     * While a code is out: what is being waited for, and how long the code
     * still lasts when the machine's checked answer said when it runs out.
     * [fixedLife] is a machine that did not say: then how long any code
     * lasts, which is known, and no count of what is left, which is not.
     */
    fun waiting(provider: String, minutes: Int?, fixedLife: Boolean = false): String {
        val said = "Waiting for this code to be approved at $provider."
        return when {
            minutes == null || minutes <= 0 -> if (fixedLife) said + " A code lasts 15 minutes." else said
            minutes == 1 -> said + " It lasts 1 more minute."
            else -> said + " It lasts $minutes more minutes."
        }
    }

    /**
     * A code whose time is over by this phone's clock, with no checked answer
     * since to say how the attempt ended. ONLY WHAT IS KNOWN IS SAID: the
     * time has passed. Whether it was approved before that is the machine's
     * to say and it has not, so "ran out before it was approved" would be a
     * guess here (C-5). The machine goes on being asked, and what it answers
     * takes this sentence's place.
     */
    fun ranOut(box: String): String =
        "This code has run out, so it is not shown. $box has not said whether it was approved in time, and is asked again in a moment, by itself. Start again for a new code."

    /**
     * "Signed in on ops-box as debbie@example.com, on the plus plan, since 25
     * Nov 2026, 10:02." Without "as" where the engine names no account.
     */
    fun signedIn(box: String, who: EngineSignedIn): String {
        var said = "Signed in on $box"
        val email = who.email
        if (!email.isNullOrEmpty()) {
            said += " as $email"
            val plan = who.plan
            if (!plan.isNullOrEmpty()) said += ", on the $plan plan"
        }
        val since = taskTime(who.since)
        if (since != null) said += ", since $since"
        return "$said."
    }

    /**
     * The most of an engine's own reason that is drawn. The machine keeps it
     * to one line of 200 characters, and this holds it to that.
     */
    const val DETAIL_MOST = 200

    /**
     * How an attempt that is over ended, by the machine's word for it. A
     * state with nothing to say, and one this build has never met, say
     * nothing: no sentence here claims more than the machine did.
     *
     * [standing] IS A SIGN-IN THE CHECKED ANSWER SAYS IS THERE. Then the
     * attempt that ended was a newer one, and the sentence says so and that
     * the sign-in stands: "Codex did not sign in" under "Signed in on
     * ops-box" reads as its opposite. Signed out, or no longer working,
     * beside a sign-in the machine signed for says nothing.
     */
    fun ended(state: String, engine: String, box: String, detail: String?, standing: Boolean = false): String {
        val why = detail.orEmpty().trim().take(DETAIL_MOST)
        if (standing) {
            return when (state) {
                "expired" -> "A newer code ran out before it was approved. The sign-in above stands."
                "failed" ->
                    if (why.isEmpty()) "A newer attempt did not sign in. The sign-in above stands."
                    else "The sign-in above stands. A newer attempt did not sign in: $why"
                "cancelled" -> "A newer attempt was cancelled. The sign-in above stands."
                "lost" -> "$box restarted while a newer attempt was waiting, so that attempt is gone. The sign-in above stands."
                else -> ""
            }
        }
        return when (state) {
            "expired" -> "The code ran out before it was approved. Start again for a new one."
            "failed" -> if (why.isEmpty()) "$engine did not sign in." else "$engine did not sign in: $why"
            "cancelled" -> "Cancelled."
            "lost" -> "$box restarted while it was waiting, so that attempt is gone. Start again."
            "signed_out" -> "Signed out on $box."
            "ended" -> "${engine}’s sign-in on $box no longer works. Sign it in again."
            else -> ""
        }
    }

    /** Whether that ending is a fault to draw as one. */
    fun endedBadly(state: String): Boolean = state in listOf("expired", "failed", "lost", "ended")

    /**
     * What to do about an answer that failed a check. Said after what is not
     * shown, because a sentence that only says an answer could not be checked
     * leaves a person to guess whether to wait, try again or worry.
     */
    fun then(codeOut: Boolean): String = if (codeOut) "Cancel it, and tell whoever runs this fleet." else "Tell whoever runs this fleet."

    fun unopened(box: String, codeOut: Boolean): String =
        "${box}’s answer could not be opened, so ${if (codeOut) THE_CODE else WHO_IS_SIGNED_IN} is not shown. ${then(codeOut)}"

    fun unapproved(member: String?, codeOut: Boolean): String {
        val what = if (codeOut) THE_CODE else WHO_IS_SIGNED_IN
        return if (member == null) "This answer did not come from a machine approved for your credentials, so $what is not shown. ${then(codeOut)}"
        else "This answer did not come from a machine approved for ${member}’s credentials, so $what is not shown. ${then(codeOut)}"
    }

    fun unsigned(box: String, codeOut: Boolean): String =
        "${box}’s answer could not be checked, so ${if (codeOut) THE_CODE else WHO_IS_SIGNED_IN} is not shown. ${then(codeOut)}"

    /**
     * A code came with a page that is not the provider's own. The machine
     * signed for it, so the machine is what to look at.
     */
    fun foreignPage(box: String, provider: String): String =
        "$box gave a sign-in page that is not ${provider}’s, so the code is not shown. ${then(true)}"

    private val PRINTABLE_CODE = Regex("^[a-z]+(_[a-z]+)*$")

    /**
     * A refusal's code as it may be printed: lower-case words joined by
     * underscores, at most 40 characters, which is what every code the fleet
     * and its machines send is. Anything else is not printed at all, because
     * the code comes from outside the seal like the sentence does.
     */
    fun printable(code: String): Boolean = code.length <= 40 && PRINTABLE_CODE.matches(code)

    /**
     * WHAT A REFUSAL SAYS, IN THIS PHONE'S OWN WORDS, BY ITS CODE. The
     * fleet's sentence is never drawn here (the header says why), so each
     * code a sign-in can be refused with has its sentence here, and each says
     * what to do next. A code this build has not met names the machine and
     * the code and nothing else from the answer. The same table as iOS, held
     * equal by test/engines-in-apps.test.js, which also holds it to every
     * code the machine's own code refuses with.
     *
     * [provider] is whose page that engine's code is entered on, for the one
     * refusal that is about a page that was not theirs.
     *
     * [codeOut] IS A CHECKED CODE ON SCREEN AS THE ANSWER CAME. Then a code
     * this build has not met is not printed at all. It is the fleet's to
     * write, and forty letters and underscores are enough to spell a code of
     * its own under the real one: "(enter_wdjb_mjht_instead)".
     */
    fun refusal(code: String, box: String, engine: String, provider: String, member: String?, codeOut: Boolean = false): String {
        val whose = if (member == null) "your" else "${member}’s"
        val whom = member ?: "you"
        val named = member ?: "your own member"
        return when (code) {
            "not_approved" -> "$box is not approved for $whose credentials, or has not heard yet that it is. If it was approved a moment ago, try again shortly. Otherwise approve it first."
            "approval_unknown" -> "$box has not heard from the vault which credentials it is approved for. It asks every ten minutes. Try again in a few minutes."
            "custody_unknown" -> "Your fleet has not heard yet who may sign an engine in for $whom. Try again in a few minutes."
            "not_custodian" -> "The vault does not list you as somebody who may sign an engine in for $whom. A custodian adds you from $whose Credentials."
            "not_signed_in" -> "Signing an engine in needs you signed in to this fleet. Sign in again under You."
            "no_member" -> "The vault does not hold this member yet. File it from Organization, under Custody, then try again."
            "member_unchecked" -> "$box has no list from the vault of who may act for a member, so it signs no engine in. Try again in a few minutes."
            "signature_required" -> "$box takes this only when this phone signed it, and this phone’s key is not listed yet. Sign in to GitHub under Runners, then try again."
            "host_outdated", "hub_outdated", "unknown_verb" -> "$box is too old to sign an engine in. Update fleetwright on $box."
            "no_engine" -> "$box does not run $engine. Sign it in on a machine that does."
            "host_unavailable" -> "$box is not connected, or does not act for you. Try again when it is back, or use another machine."
            "host_timeout", "hub_timeout" -> "$box did not answer in time. Try again."
            // `hub_error`, `hub_unauthorised` and `internal` are the box's
            // own faults, passed on as they are: fleetwright there answered
            // wrongly, turned its own sidecar away, or fell over on the
            // request. None is a refusal, and each read "refused that
            // (hub_error)." So they say what an unreachable one says, which
            // is what to do about all four.
            "hub_unreachable", "hub_error", "hub_unauthorised", "internal" -> "fleetwright on $box is not answering. Try again, and if it goes on, whoever runs $box restarts it."
            "answer_unsigned" -> "$box could not sign its answer, so nothing of it is shown. Try again, or cancel the sign-in."
            "bad_params" -> "$box did not take the request as this app sent it. Update this app and fleetwright on $box."
            "no_image" -> "$box has not fetched its session image yet. Start a session there first, then sign in."
            "no_podman" -> "$box has no podman to run a sign-in in. Whoever runs $box installs it."
            "no_egress" -> "$box could not set up internet access for this sign-in. Whoever runs $box looks at its internet access settings."
            "device_code_off" -> "$engine says signing in with a code is not turned on for this account or its workspace. Turn it on there, or paste a sign-in instead."
            "signin_failed" -> "$engine ended on $box before it gave a code. Start again."
            "no_code" -> "$engine gave no code on $box in time, and nothing is waiting. Start again."
            "busy" -> "$engine is being signed out on $box right now. Try again in a moment."
            "signout_failed" -> "$engine was not signed out on $box, and what $box knows of the sign-in is unchanged. Try again."
            "state_unreadable" -> "$box cannot read its own record of sign-ins, so it cannot say where this one stands or begin another, until whoever runs $box looks at it."
            "state_unwritable" -> "$box could not write its own record of sign-ins, so it began nothing. Whoever runs $box looks at its disk. Then start again."
            "unreadable_code" -> "$box could not read the page and code $engine gave it, and nothing is waiting. That is a fault in fleetwright on $box: update it and start again, or paste a sign-in instead."
            "wrong_page" -> "$engine on $box named a sign-in page that is not ${provider}’s own, so $box stopped it and gave nobody the code. Nothing is waiting. Whoever runs $box looks at it before anybody starts again."
            "cannot_tell" -> "It is not known yet whether $engine is signed in on $box: $box did not hear how the last sign-in ended. It is asked again in a moment, by itself."
            "id_reused" -> "$box refused a repeated request. Try again."
            "in_flight" -> "The same request is still on its way to $box. Wait for its answer."
            "member_not_delegated" -> "$box takes this only under a delegation that names $named. Allow one under You, Delegations, with that member turned on."
            else -> if (!codeOut && printable(code)) "$box refused that ($code)." else "$box refused that."
        }
    }

    fun noMachine(engine: String): String = "No machine that can take a session now runs $engine."

    fun notApproved(box: String, engine: String, member: String?): String =
        if (member == null) "$box runs $engine and is not approved for your credentials. Approve it from its page, then sign in."
        else "$box runs $engine and is not approved for ${member}’s credentials. Approve it below, then sign in."

    fun tooOld(box: String, engine: String): String = "$box runs $engine and is too old to sign it in. Update fleetwright on $box."

    /**
     * What signing out costs, said before it is done, and only what is
     * known: the machine forgets this sign-in, so a session that starts there
     * afterwards cannot use the engine. Whether one that is running stops is
     * not known, and is not said. With a pasted sign-in kept, the next
     * session runs on that, which is said in place of "cannot".
     */
    fun signOutCost(member: String?, engine: String, box: String, pasted: Boolean): String = when {
        pasted -> "$box forgets this sign-in. A pasted sign-in is still kept, and the next session there runs on that."
        member == null -> "$box forgets this sign-in, and your new sessions there cannot use $engine until it is signed in again. Signing in again takes a new code."
        else -> "$box forgets this sign-in, and new sessions as $member there cannot use $engine until it is signed in again. Signing in again takes a new code."
    }
}

internal object EngineSignin {
    /** The protocol a machine speaks once it can sign an engine in. */
    const val PROTOCOL_NEEDED = 22

    /** How often a waiting sign-in is asked after, in milliseconds. */
    const val POLL_EVERY_MS = 4_000L

    /**
     * How long to leave a machine that was approved a moment ago before
     * asking it once more: it hears of an approval about two seconds on.
     */
    const val APPROVAL_SETTLES_MS = 3_000L

    /**
     * How often this phone's clock is read while a machine is waited on, in
     * milliseconds, for the minutes a code still lasts.
     */
    const val CLOCK_EVERY_MS = 5_000L

    /**
     * How long past its end a code is left on screen, in milliseconds, for
     * the machine to say itself that it ran out: two asks and the time one
     * takes. Without it the phone's sentence came first each time a code ran
     * out, then the code again for one ask where the machine's clock was a
     * second behind, then the machine's sentence.
     */
    const val END_SLACK_MS = 10_000L

    /**
     * The engine a machine can sign in for one of the vault's two pasted
     * items, or null for any other item: `codex` is Codex's own, and
     * `copilot` is OpenCode's.
     */
    fun engineOfItem(item: String): String? = when (item) {
        "codex" -> "codex"
        "copilot" -> "opencode"
        else -> null
    }

    /**
     * What one sealed answer says, or which check it failed.
     *
     * THE ORDER IS THE WHOLE OF IT, and no step is skipped. Opening comes
     * first because there is nothing to check until it is open. The key
     * comes before the signature because a signature that holds under a key
     * nobody approved proves nothing. Reading anything out comes last.
     *
     * [sealed] is what the answer carried, or null when it carried none.
     * [key] is the key this phone made for that request. [grants] are the
     * member's approved machines, from a vault list this phone fetched
     * itself, never from the answer or the fleet's listing. [host], [id],
     * [member] and [engine] are this phone's own request: the signature is
     * checked over these and not over what the answer claims they were,
     * which is what ties it to this request.
     */
    fun verified(
        sealed: JSONObject?,
        key: Seal.OneUseKey,
        grants: List<PhoneVault.Grant>,
        host: String,
        id: String,
        member: String,
        engine: String,
    ): EngineSigninCheck {
        // 1. OPEN IT, with the key made for this request and under this
        // purpose's own name. No sealed part at all is a failure too:
        // something on the way took it out.
        if (sealed == null) return EngineSigninCheck.Unopened
        val opened = runCatching { Seal.open(key, Seal.ENGINE_SIGNIN_AAD, sealed) }.getOrNull() ?: return EngineSigninCheck.Unopened

        // 2. THE KEY IT CARRIES IS A MACHINE APPROVED FOR THIS MEMBER: for
        // the whole of the member's credentials, under the name of the
        // machine that was asked. The key's id is worked out here from the
        // key itself and must be the one the answer names.
        val hostKey = opened.optJSONObject("hostKey") ?: return EngineSigninCheck.Unapproved
        if (hostKey.optString("kty") != "EC" || hostKey.optString("crv") != "P-256") return EngineSigninCheck.Unapproved
        val keyId = PhoneVault.keyHash(hostKey)
        if (opened.optString("host") != keyId) return EngineSigninCheck.Unapproved
        if (PhoneVault.approval(grants, host, hostKey) != PhoneVault.Approval.APPROVED) return EngineSigninCheck.Unapproved

        // 3. THAT KEY SIGNED THIS ANSWER TO THIS REQUEST: everything that
        // was opened but the key and the signature, with the request's own
        // id, member and engine in place of whatever the answer says they
        // were, in the bytes every signature here is made over.
        val signature = if (opened.isNull("signature")) "" else opened.optString("signature")
        opened.remove("hostKey")
        opened.remove("signature")
        opened.put("host", keyId)
        opened.put("id", id)
        opened.put("member", member)
        opened.put("engine", engine)
        val input = IntentSigning.signingInput("engine-signin-answer", opened).toByteArray(Charsets.UTF_8)
        if (!XoSetup.verifyKeySig(hostKey, signature, input)) return EngineSigninCheck.Unsigned

        // 4. ONLY NOW IS ANYTHING READ OUT TO BE SHOWN. `since` is a number
        // or the sign-in is not said: a word that happened to be digits was
        // read as a time, and any other word as a sign-in with none.
        val code = if (opened.isNull("code")) null else opened.optString("code").takeIf { it.isNotEmpty() }
        val page = if (opened.isNull("url")) null else opened.optString("url").takeIf { it.isNotEmpty() }
        val out = code != null && page != null
        val there = opened.optJSONObject("signedIn")
        val since = wholeNumber(there?.opt("since"))
        val signedIn = if (there == null || since == null) {
            null
        } else {
            val who = there.optJSONObject("who")
            EngineSignedIn(
                since = since,
                email = if (who == null || who.isNull("email")) null else who.optString("email").takeIf { it.isNotEmpty() },
                plan = if (who == null || who.isNull("plan")) null else who.optString("plan").takeIf { it.isNotEmpty() },
            )
        }
        // HOW IT STANDS, WHY IT FAILED AND WHEN THE CODE RUNS OUT, where the
        // machine signed for them. A reason is read only beside a state, and
        // an end only beside a code.
        val state = (opened.opt("state") as? String)?.takeIf { it.isNotEmpty() }
        val detail = if (state == null) null else (opened.opt("detail") as? String)?.takeIf { it.isNotEmpty() }
        val expiresAt = if (out) wholeNumber(opened.opt("expiresAt")) else null
        return EngineSigninCheck.Verified(EngineSigninSaid(if (out) code else null, if (out) page else null, signedIn, state, detail, expiresAt))
    }

    /**
     * The one page each engine's code is entered on: Codex's own device page
     * at OpenAI (codex-rs/login, `{issuer}/codex/device`), and GitHub's,
     * which is where OpenCode's Copilot sign-in sends a person. Null for an
     * engine no machine signs in.
     *
     * A CODE IS DRAWN ONLY BESIDE THAT PAGE. The three checks say the
     * machine signed the answer. They do not say the page is the provider's:
     * a machine that was made to sign another page would send somebody to
     * enter a real code somewhere that is not OpenAI or GitHub. So after the
     * checks the page is held to this, letter for letter, and with any other
     * the code is not drawn and neither is its button.
     */
    fun pageOf(engine: String): String? = when (engine) {
        "codex" -> "https://auth.openai.com/codex/device"
        "opencode" -> "https://github.com/login/device"
        else -> null
    }

    /**
     * A whole number out of an opened answer, or null for anything else: a
     * word, a fraction, a true or a false.
     */
    fun wholeNumber(value: Any?): Long? {
        val number = value as? Number ?: return null
        return if (number.toDouble() % 1.0 == 0.0) number.toLong() else null
    }

    /**
     * How many minutes a code still lasts, from when the machine's checked
     * answer says it runs out and this phone's own clock. Null when it did
     * not say, when the time has passed, and when it comes to more than the
     * fifteen minutes a code lasts: a number that cannot be right is not said.
     */
    fun minutesLeft(expiresAt: Long?, now: Long): Int? {
        if (expiresAt == null) return null
        val left = kotlin.math.ceil((expiresAt - now) / 60_000.0)
        return if (left >= 1.0 && left <= 15.0) left.toInt() else null
    }

    /**
     * What is drawn of a machine at one moment of this phone's clock.
     *
     * A CODE PAST ITS END IS NOT DRAWN AS ONE TO ENTER (C-5). While the
     * machine answers, it says itself that a code ran out, within one ask.
     * While it cannot be asked, what was checked stays, and the code stayed
     * with it for as long as that went on, under a count of minutes that no
     * longer moved. So once the end the machine signed has passed, with
     * [END_SLACK_MS] for the machine to say so first, the code and its page
     * are not drawn, and one sentence says what this phone knows: the time
     * is over, and the machine has not said how it ended. Who is signed in
     * stays, since that was checked.
     *
     * NOTHING KEPT IS CHANGED. The code is still what the asking goes by, so
     * the machine is asked until it answers, and its checked answer then
     * takes this sentence's place.
     */
    fun at(one: EngineSigninShown, box: String, now: Long): EngineSigninShown {
        val ends = one.expiresAt
        if (one.code == null || ends == null || now < ends + END_SLACK_MS) return one
        return one.copy(code = null, page = null, expiresAt = null, says = EngineSigninWords.ranOut(box), bad = true)
    }

    /**
     * Where [engine] can be signed in for a member, from what the machines
     * report and what the member's vault approves (C-2).
     *
     * A MACHINE IS OFFERED ONLY WHEN IT WOULD TAKE THE REQUEST: it takes
     * sessions now, which only a connected machine does, it is not a
     * temporary one, it says it runs the engine, it is new enough to know
     * how, and its key is approved for the whole of this member's
     * credentials under its own name. The last is the check the answer is
     * held to afterwards, made here first with the key the fleet lists, so
     * no start is sent to a machine whose answer could not be shown.
     *
     * WITH NOWHERE TO OFFER, ONE SENTENCE SAYS WHAT IS MISSING, and never a
     * button that would be refused. With no machines heard from at all it
     * says nothing: that is not known to be "none" (C-5).
     */
    fun places(
        engine: String,
        hosts: List<Fleet.FleetHost>,
        keys: List<Fleet.Host>,
        grants: List<PhoneVault.Grant>,
        member: String?,
    ): EngineSigninPlaces {
        if (hosts.isEmpty()) return EngineSigninPlaces()
        val name = engineName(engine)
        val running = hosts.filter { host ->
            host.takesSessions == true && !host.ephemeral && host.engines.orEmpty().contains(engine)
        }
        if (running.isEmpty()) return EngineSigninPlaces(missing = EngineSigninWords.noMachine(name))
        val offered = mutableListOf<String>()
        val unapproved = mutableListOf<String>()
        val old = mutableListOf<String>()
        for (host in running) {
            if ((host.protocol ?: 0) < PROTOCOL_NEEDED) {
                old.add(host.hostId)
                continue
            }
            val key = keys.firstOrNull { it.hostId == host.hostId }?.publicJwk ?: continue
            if (PhoneVault.approval(grants, host.hostId, key) == PhoneVault.Approval.APPROVED) {
                offered.add(host.hostId)
            } else {
                unapproved.add(host.hostId)
            }
        }
        if (offered.isNotEmpty()) return EngineSigninPlaces(offered = offered.sorted())
        val box = unapproved.sorted().firstOrNull()
        if (box != null) return EngineSigninPlaces(missing = EngineSigninWords.notApproved(box, name, member))
        val behind = old.sorted().firstOrNull()
        if (behind != null) return EngineSigninPlaces(missing = EngineSigninWords.tooOld(behind, name))
        return EngineSigninPlaces()
    }

    /**
     * What the screen shows of a machine after one answer from it.
     *
     * NOTHING FROM OUTSIDE THE SEAL IS DRAWN: not the answer's sentence, not
     * the engine's reason beside it, not its count of minutes. Each could
     * carry a code a lying fleet wants entered.
     *
     * A NO WITH NO CODE BESIDE IT IS NOT A MACHINE'S REFUSAL: the fleet was
     * not reached, or did not answer as a fleet does. Everything that was
     * checked before stands, the code included, and one fixed sentence says
     * so.
     *
     * A REFUSAL is said in this phone's own words for its code. It carries
     * no code and no account, so what was checked before stands: who is
     * signed in, and the code while the refusal says one is still out.
     *
     * A REFUSED ASK OF WHERE IT STANDS ([poll]) IS THAT ASK FAILING, and
     * nothing about the sign-in. One machine not answering in time, once in
     * fifteen minutes of asking, took the code off the screen, ended the
     * asking and took Cancel with it, with the attempt still out. So
     * everything stays, the sentence says what happened, and the asking goes
     * on.
     *
     * AN ANSWER goes through [verified] before anything of it is used. One
     * that fails shows nothing of a code, a page or an account, old or new,
     * and says which check it failed and what to do. One that passes shows
     * the code when the checked part carries one beside the page that
     * engine's code is entered on ([pageOf]), and otherwise a sentence
     * for how the attempt ended: by the machine's own checked word and
     * reason where it signed them, and by the word beside the answer, with
     * no reason, from a machine that did not. That word is not signed, so it
     * picks among this phone's sentences and is never the reason a code or a
     * sign-in is drawn.
     *
     * [now] is this phone's clock in milliseconds. The end a machine signed
     * for its code is kept only where it can be right against it: at least a
     * minute off and at most the fifteen a code lasts. The machine has just
     * said, checked, that the code is out, so an end that has passed
     * already, or is further off than a code lasts, is two clocks
     * disagreeing, and then no count is said and nothing is taken off the
     * screen for the time.
     */
    fun shown(
        reply: Fleet.Reply,
        before: EngineSigninShown,
        poll: Boolean,
        key: Seal.OneUseKey,
        grants: List<PhoneVault.Grant>,
        host: String,
        id: String,
        member: String,
        engine: String,
        memberName: String?,
        now: Long = System.currentTimeMillis(),
    ): EngineSigninShown {
        val state = reply.state.orEmpty()
        if (!reply.ok) {
            val code = reply.code ?: return before.copy(says = EngineSigninWords.NOT_REACHED, bad = true)
            val says = EngineSigninWords.refusal(code, host, engineName(engine), EngineSigninWords.provider(engine), memberName, codeOut = before.code != null)
            // A MACHINE THAT CANNOT TELL YET has said nothing about the
            // sign-in: it did not hear how the last one ended, and looks
            // again when asked. So whatever asked, a button included,
            // everything that was checked stays, nobody is said to be signed
            // out, it is not drawn as a fault, and the asking goes on by
            // itself until the machine can say.
            val unsure = code == "cannot_tell"
            if (poll || unsure) return before.copy(says = says, bad = !unsure, unsure = unsure)
            val next = EngineSigninShown(signedIn = before.signedIn, says = says, bad = true)
            return if (state == "waiting") {
                next.copy(code = before.code, page = before.page, expiresAt = before.expiresAt, fixedLife = before.fixedLife, cancel = before.code == null)
            } else {
                next
            }
        }
        val codeOut = state == "waiting"
        return when (val check = verified(reply.sealed, key, grants, host, id, member, engine)) {
            EngineSigninCheck.Unopened ->
                EngineSigninShown(says = EngineSigninWords.unopened(host, codeOut), bad = true, cancel = codeOut)
            EngineSigninCheck.Unapproved ->
                EngineSigninShown(says = EngineSigninWords.unapproved(memberName, codeOut), bad = true, cancel = codeOut)
            EngineSigninCheck.Unsigned ->
                EngineSigninShown(says = EngineSigninWords.unsigned(host, codeOut), bad = true, cancel = codeOut)
            is EngineSigninCheck.Verified -> {
                val said = check.said
                if (said.code != null && said.page != null && said.page != pageOf(engine)) {
                    EngineSigninShown(
                        signedIn = said.signedIn,
                        says = EngineSigninWords.foreignPage(host, EngineSigninWords.provider(engine)),
                        bad = true,
                        cancel = true,
                    )
                } else if (said.code != null && said.page != null) {
                    EngineSigninShown(
                        signedIn = said.signedIn,
                        code = said.code,
                        page = said.page,
                        expiresAt = said.expiresAt.takeIf { minutesLeft(it, now) != null },
                        fixedLife = said.expiresAt == null,
                    )
                } else {
                    val ending = said.state ?: state
                    val says = EngineSigninWords.ended(ending, engineName(engine), host, said.detail, standing = said.signedIn != null)
                    EngineSigninShown(signedIn = said.signedIn, says = says, bad = says.isNotEmpty() && EngineSigninWords.endedBadly(ending))
                }
            }
        }
    }

    /**
     * The sign-in page as something to open, only when it is an https
     * address: the one page a code is entered on is never anything else.
     */
    fun pageUrl(page: String?): String? = page?.takeIf { it.startsWith("https://", ignoreCase = true) }
}

/**
 * One engine's sign-in on the member's machines, on that member's
 * Credentials: who is signed in where, Sign in on a machine, the code while
 * one is out, and Sign out.
 *
 * ASKED WHEN THE PAGE OPENS, of each machine it could be signed in on, so a
 * sign-in made earlier says who it is, and a code that is still out (from
 * this phone before it left the page, or from another custodian's) is shown
 * again. While a code is out the machine is asked every few seconds, and the
 * asking stops when this leaves the screen. LEAVING DOES NOT CANCEL: only
 * Cancel does.
 *
 * EVERY REQUEST IS ITS OWN: a new id and a new key each time, a poll
 * included, because the machine signs its answer over the id and seals it to
 * the key.
 *
 * [engine] is "codex", or "opencode" for GitHub Copilot. [member] is who it
 * is signed in for, by id: the one whose vault is on screen, or this
 * person's own member. [memberName] is that member's name, for a sentence,
 * or null for this person's own. [hosts] is what every machine reports of
 * itself, [keys] the machines in this fleet with the keys the fleet lists
 * for them, and [grants] the machines approved in this member's vault, as
 * this phone read them. [pasted] is whether the vault also keeps a pasted
 * sign-in for this engine.
 */
@Composable
internal fun EngineMachineSignIn(
    settings: Settings,
    engine: String,
    member: String,
    memberName: String?,
    hosts: List<Fleet.FleetHost>,
    keys: List<Fleet.Host>,
    grants: List<PhoneVault.Grant>,
    pasted: Boolean,
) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    // `remember`, never rememberSaveable: a code and its page must not be
    // written into the saved state of a screen.
    var shown by remember { mutableStateOf(mapOf<String, EngineSigninShown>()) }
    // Which request to each machine is the latest. An answer to an earlier
    // one is dropped: a slow "nothing here" must not take away the code a
    // later start brought.
    var turns by remember { mutableStateOf(mapOf<String, Int>()) }
    // The machine being asked for something other than where it stands.
    var busy by remember { mutableStateOf("") }
    var choosing by remember { mutableStateOf(false) }
    // The machine a Sign out is waiting on, until the dialog is answered.
    var signingOut by remember { mutableStateOf<String?>(null) }
    // The code Copy was last pressed for.
    var copiedCode by remember { mutableStateOf("") }
    // This phone's clock in milliseconds, read again every few seconds while
    // a machine is waited on. The minutes a code still lasts are counted
    // against it where they are drawn, and so is whether the code has run
    // out, whether or not the machine is answering.
    var clock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val places = EngineSignin.places(engine, hosts, keys, grants, memberName)
    // The machine that is asked every few seconds: one a code is out on, or
    // one that said it cannot tell yet how the last sign-in ended.
    val waitingOn = shown.keys.sorted().firstOrNull { shown[it]?.code != null || shown[it]?.unsure == true }
    // The machine a code is out on. While there is one, the next step is
    // that code, and a second start is not offered beside it. A code that
    // has run out on this phone's clock is not one: the sentence in its
    // place says to start again, so the button to do it with is there.
    val codeOutOn = shown.keys.sorted().firstOrNull { EngineSignin.at(shown[it] ?: EngineSigninShown(), it, clock).code != null }

    /**
     * Ask one machine one thing, and show what its answer may show.
     *
     * A START GOES ONLY TO A MACHINE THAT IS OFFERED, which is one whose
     * answer this phone could check. One that was approved a moment ago may
     * not have heard yet, and says so: it is asked once more, a few seconds
     * on, and never a third time.
     *
     * ASKING WHERE IT STANDS NEVER OUTRANKS A BUTTON. An answer is shown
     * only when no later request to that machine has started, which is right
     * for a slow "nothing here" against a later start. But the asking every
     * few seconds is a request too, and one that began while a Sign out was
     * still being done made this throw the Sign out's own answer away: the
     * screen went on saying Signed in over a machine that had signed out. So
     * while a button's request to a machine is out, that machine is not
     * asked where it stands, and once the button's answer is shown it is
     * asked once, which is also how a refused Cancel finds the code again.
     */
    suspend fun ask(action: String, host: String, again: Boolean = false) {
        if (action == "start" && host !in places.offered) return
        val quiet = action == "status"
        if (quiet && busy == host) return
        if (!quiet) busy = host
        val turn = (turns[host] ?: 0) + 1
        turns = turns + (host to turn)
        val id = "app-" + java.util.UUID.randomUUID().toString()
        val sealTo = Seal.newKey()
        val before = shown[host] ?: EngineSigninShown()
        val reply = Fleet(settings).engineSignIn(member, engine, action, host, sealTo.publicKey, id)
        if (action == "start" && !again && !reply.ok && reply.code == "not_approved") {
            delay(EngineSignin.APPROVAL_SETTLES_MS)
            ask(action, host, true)
            return
        }
        if (turns[host] == turn) {
            shown = shown + (host to EngineSignin.shown(reply, before, quiet, sealTo, grants, host, id, member, engine, memberName))
        }
        if (!quiet) {
            busy = ""
            ask("status", host)
        }
    }

    LaunchedEffect(places.offered) {
        for (host in places.offered) ask("status", host)
    }
    LaunchedEffect(waitingOn) {
        val host = waitingOn ?: return@LaunchedEffect
        while (true) {
            delay(EngineSignin.POLL_EVERY_MS)
            ask("status", host)
        }
    }
    // THE CLOCK IS READ BY ITSELF, not when an answer comes: the count went
    // stale exactly while no answer came.
    LaunchedEffect(waitingOn) {
        if (waitingOn == null) return@LaunchedEffect
        while (true) {
            clock = System.currentTimeMillis()
            delay(EngineSignin.CLOCK_EVERY_MS)
        }
    }

    // SIGN OUT ASKS FIRST, with what it costs, as Forget does.
    val leaving = signingOut
    if (leaving != null) {
        AlertDialog(
            onDismissRequest = { signingOut = null },
            title = { Text(EngineSigninWords.signOutAsk(engineName(engine), leaving)) },
            text = { Text(EngineSigninWords.signOutCost(memberName, engineName(engine), leaving, pasted)) },
            confirmButton = {
                TextButton(onClick = {
                    signingOut = null
                    scope.launch { ask("signout", leaving) }
                }) { Text(EngineSigninWords.SIGN_OUT) }
            },
            dismissButton = { TextButton(onClick = { signingOut = null }) { Text(EngineSigninWords.CANCEL) } },
        )
    }

    // Whether there is anything to say about this engine yet. With no machine
    // to offer, nothing missing that is certain, and nothing a machine has
    // said, the block is not drawn: a heading over nothing promises a
    // sign-in the page cannot give.
    val hasSomething = places.offered.isNotEmpty() || places.missing.isNotEmpty() ||
        shown.values.any { it.signedIn != null || it.code != null || it.says.isNotEmpty() || it.cancel }
    if (!hasSomething) return

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        Text(EngineSigninWords.title(engine), style = Design.Style.body, color = Design.Palette.ink.now)
        for (host in shown.keys.sorted()) {
            // What is drawn of it at this moment, not what is kept: a code
            // past its end is not drawn ([EngineSignin.at]).
            val one = EngineSignin.at(shown[host] ?: EngineSigninShown(), host, clock)
            key(host) {
                // A CHANGE OF STATE MOVES, and nothing else: a crossfade,
                // which is the one animation "Remove animations" keeps. A
                // code running out on this phone's clock is one.
                //
                // A MINUTE PASSING IS NOT A CHANGE OF STATE. Keyed on a count
                // of minutes, the block was taken away and made again each
                // time the count changed, and TalkBack's place on Copy code
                // or Cancel went with it. So what the crossfade watches
                // holds when the code runs out and no count, and the minutes
                // are counted from the clock where they are said.
                AnimatedContent(
                    targetState = one,
                    transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
                    label = "engine sign-in",
                ) { now ->
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                        val who = now.signedIn
                        if (who != null) {
                            SelectionContainer {
                                Text(EngineSigninWords.signedIn(host, who), style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                            }
                            TextButton(
                                enabled = busy.isEmpty(),
                                onClick = { signingOut = host },
                                modifier = Modifier.heightIn(min = 48.dp).semantics {
                                    contentDescription = EngineSigninWords.signOutOf(engineName(engine), host)
                                },
                                // Red only while it can be pressed: a colour
                                // given here outranks the button's own for
                                // disabled, and it then looked live.
                            ) { Text(EngineSigninWords.SIGN_OUT, color = if (busy.isEmpty()) Design.Palette.bad.now else Color.Unspecified) }
                        }
                        val code = now.code
                        if (code != null) {
                            // SAID ALOUD WHEN IT ARRIVES, once, for somebody
                            // who cannot see that the button they pressed
                            // became a code: which machine, then the code a
                            // character at a time.
                            Text(
                                EngineSigninWords.codeFor(host),
                                style = Design.Style.bodySmall,
                                color = Design.Palette.inkDim.now,
                                modifier = Modifier.semantics {
                                    liveRegion = LiveRegionMode.Polite
                                    contentDescription = EngineSigninWords.codeArrived(host, code)
                                },
                            )
                            // LARGE, AND FREE TO WRAP: at the largest font
                            // scale the code is wider than the row, and it
                            // breaks at its dash into its two groups, never
                            // clipped and never shrunk.
                            SelectionContainer {
                                Text(
                                    code,
                                    style = Design.Style.title.copy(fontFamily = FontFamily.Monospace, letterSpacing = 0.sp),
                                    color = Design.Palette.ink.now,
                                    modifier = Modifier.semantics { contentDescription = EngineSigninWords.spoken(code) },
                                )
                            }
                            val url = EngineSignin.pageUrl(now.page)
                            if (url != null) {
                                OutlinedButton(
                                    onClick = { runCatching { uri.openUri(url) } },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text(EngineSigninWords.OPEN_PAGE) }
                            }
                            OutlinedButton(
                                onClick = {
                                    context.getSystemService(android.content.ClipboardManager::class.java)
                                        ?.setPrimaryClip(android.content.ClipData.newPlainText("Sign-in code", code))
                                    copiedCode = code
                                },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text(if (copiedCode == code) EngineSigninWords.COPIED else EngineSigninWords.COPY) }
                            Text(
                                EngineSigninWords.waiting(EngineSigninWords.provider(engine), EngineSignin.minutesLeft(now.expiresAt, clock), now.fixedLife),
                                style = Design.Style.bodySmall,
                                color = Design.Palette.ink.now,
                            )
                        }
                        if (now.says.isNotEmpty()) {
                            SelectionContainer {
                                Text(
                                    now.says,
                                    style = Design.Style.bodySmall,
                                    color = if (now.bad) Design.Palette.bad.now else Design.Palette.ink.now,
                                )
                            }
                        }
                        if (now.code != null || now.cancel) {
                            TextButton(
                                enabled = busy.isEmpty(),
                                onClick = { scope.launch { ask("cancel", host) } },
                                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = EngineSigninWords.cancelOn(host) },
                            ) { Text(EngineSigninWords.CANCEL) }
                        }
                    }
                }
            }
        }
        // ONE THING AT A TIME: while a code is out, the next step is that
        // code, and a second start is not offered beside it.
        if (codeOutOn == null) {
            if (places.offered.isNotEmpty()) {
                OutlinedButton(
                    enabled = busy.isEmpty(),
                    onClick = {
                        if (places.offered.size == 1) {
                            scope.launch { ask("start", places.offered.first()) }
                        } else {
                            choosing = !choosing
                        }
                    },
                    modifier = Modifier.heightIn(min = 48.dp).semantics {
                        contentDescription = if (busy.isEmpty()) EngineSigninWords.offerOf(engineName(engine)) else EngineSigninWords.asking(busy)
                    },
                ) { Text(if (busy.isEmpty()) EngineSigninWords.OFFER else EngineSigninWords.asking(busy)) }
                // THE SAME BUTTON CHANGES THE ACCOUNT on a machine that is
                // signed in, and that is said where it is true.
                if (places.offered.any { shown[it]?.signedIn != null }) Hint(EngineSigninWords.REPLACES)
                if (choosing && places.offered.size > 1) {
                    Hint(EngineSigninWords.WHICH)
                    for (host in places.offered) {
                        TextButton(
                            enabled = busy.isEmpty(),
                            onClick = {
                                choosing = false
                                scope.launch { ask("start", host) }
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(EngineSigninWords.on(host)) }
                    }
                }
            } else if (places.missing.isNotEmpty()) {
                Hint(places.missing)
            }
        }
    }
}
