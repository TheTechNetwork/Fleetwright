package network.thetech.fleetwright

import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

/**
 * Connecting the credentials a session needs, from a phone.
 *
 * The reason this exists: a guest brings their own GitHub, Cloudflare and
 * Claude accounts and has no shell on any box. "SSH in and run claude login" is
 * not a smaller inconvenience for them — it is the whole feature missing.
 *
 * THE PROVIDER LIST IS NOT IN THIS FILE. It arrives from the host, with the
 * real URLs and the real scopes, so a provider added to the host's table shows
 * up here on the next refresh without a Play release. There is no
 * `when (provider)` anywhere in this screen, and that is the payoff for
 * connect/link/unlink being three verbs rather than one per vendor.
 *
 * Matches the iOS screen field for field. A credential flow that works on one
 * phone and not the other is the state docs/app-parity.md was written about.
 */
/**
 * @param host the box to ask, or null for the whole fleet. Null only with
 *   [linkedOnly]: a sign-in happens in a pane on ONE box, so the flows below
 *   always have one.
 * @param onlyClaude a machine's page: Claude on this box, and nothing else.
 * @param linkedOnly THE OLDER WAY, AS FACTS. Vault first: a credential is kept
 *   once in the vault, and a link made on a box is shown here as what it is,
 *   with Test and Forget and no second Connect beside the vault's. A link on a
 *   box wins there, which is why forgetting one is still offered.
 */
@Composable
fun CredentialsSheet(
    settings: Settings,
    host: String?,
    onDismiss: () -> Unit,
    onlyClaude: Boolean = false,
    linkedOnly: Boolean = false,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var connections by remember { mutableStateOf(Fleet.Connections()) }
    var pending by remember { mutableStateOf<Fleet.Connections.Available?>(null) }
    var secret by remember { mutableStateOf("") }
    var result by remember { mutableStateOf("") }
    // The last answer per provider, kept so the detail can be reopened without
    // asking the provider again.
    var checks by remember { mutableStateOf(mapOf<String, Fleet.Check>()) }
    // A Test that came back as words rather than a check, kept under the row
    // it answers. It used to land at the bottom of the sheet, below every row
    // and naming none of them.
    var tested by remember { mutableStateOf(mapOf<String, Pair<String, Boolean>>()) }
    // Which rows have Details open. Closed by default, opened by a Test: the
    // same disclosure iOS draws with a DisclosureGroup.
    var expanded by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }

    // Reloaded on host AND on every resume, which is how coming back from the
    // browser lands. The redirect says a flow finished; what is actually stored
    // is the host's to report, so this asks rather than believes — a custom
    // scheme is unverified and any app may claim it.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumes by remember { mutableStateOf(0) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) resumes++
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(host, resumes) {
        busy = true
        Fleet(settings).connections(host, offeringSignIn = true).connections?.let { connections = it }
        busy = false
    }

    // THE CALLBACK ITSELF, which is a different signal from "the app resumed".
    // Resuming happens for every reason a phone resumes an app; this happens
    // only when a provider redirected back to us, so it is the one that may
    // close the flow rather than merely refresh behind it.
    //
    // Still trusted for nothing beyond that. A custom scheme is unverified —
    // any app may claim it — so the `ok` in the query is not read here at all,
    // and the sentence below says what the app DID rather than what happened.
    // The row underneath is the host's answer and is the one that is right.
    LaunchedEffect(Unit) {
        WebAuth.returned.collect {
            // THE CODE CAME BACK TO THIS SCREEN, and this screen finishes it,
            // with this phone's credential: the coordinator's page no longer
            // connects anything itself (Fleet.finishSignIn says why), so its
            // answer is the sentence to show, success or refusal. A `d.` state
            // is this phone's own sign-in, which the screen that started it is
            // waiting for, not this one.
            val state = it.getQueryParameter("state")
            if ((it.host == "github" || it.host == "cloudflare") && state != null && !state.startsWith("d.")) {
                val code = it.getQueryParameter("code")
                val sealed = it.getQueryParameter("sealed")
                if (code == null && sealed == null) return@collect
                val came = pending
                pending = null
                secret = ""
                busy = true
                val reply = Fleet(settings).finishSignIn(it.host!!, state, code, sealed, host = host)
                Fleet(settings).connections(host, offeringSignIn = true).connections?.let { c -> connections = c }
                busy = false
                result = reply.text.ifBlank { if (reply.ok) "Connected with ${came?.label ?: "the provider"}." else "Nothing was connected." }
                return@collect
            }
            // A box's connect flow from a coordinator that still finishes on
            // its own page, which says only that it is done.
            if (it.host != "connected") return@collect
            // CAPTURED BEFORE IT IS CLEARED, because it is the only record of
            // which provider this callback belongs to — the flow is global and
            // the query is not trusted.
            val came = pending
            pending = null
            secret = ""
            busy = true
            Fleet(settings).connections(host, offeringSignIn = true).connections?.let { connections = it }
            busy = false
            // SAY WHAT THE HOST FOUND, now that it has been asked.
            //
            // This used to say only what the app had done, on the stated
            // principle that the row below is the one that is right. The
            // principle holds; the sentence did not. Rendered above a row
            // reading "not connected" it is two sentences that disagree, and
            // the reassuring one is on top and where a person looks after
            // tapping — so a failed connect read as a success.
            val name = came?.label ?: "the provider"
            result = when {
                came == null -> "Checked with the provider."
                connections.linked(came.provider) != null -> "Connected with $name."
                else -> "$name did not connect. Try again."
            }
        }
    }

    val title = when {
        onlyClaude -> "Claude on ${host ?: "this machine"}"
        linkedOnly -> "Linked on machines"
        else -> "Your credentials"
    }
    val shown = when {
        onlyClaude -> connections.catalogue.filter { it.isSignIn }
        linkedOnly -> connections.catalogue.filter { connections.linked(it.provider) != null }
        else -> connections.catalogue
    }
    FullScreen(title = title, onDismiss = onDismiss) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // ONE SENTENCE: the result, not the mechanism (docs/reviews/
                // copy-2026-11-06.md, 123 to 125). "Signing in to Claude is per
                // machine: that one is a login the box performs" was true and
                // is not any more. A machine has no Claude account — see
                // docs/one-account-per-person.md — and a sentence describing
                // one is how somebody spends an evening looking for a button
                // that should not exist. The same words as iOS.
                Text(
                    when {
                        linkedOnly -> "Older links. Sessions you start no longer use them."
                        onlyClaude -> "Sessions here run on your own Claude account."
                        else -> "Your sessions use these, on any machine. Nobody else's sessions do."
                    },
                    style = Design.Style.bodySmall,
                    color = Design.Palette.inkDim.now,
                )
                if (linkedOnly && connections.catalogue.isNotEmpty() && shown.isEmpty()) {
                    Hint("Nothing is linked on a machine.")
                }

                shown.forEach { provider ->
                    val linked = connections.linked(provider.provider)
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair / 2)) {
                        Text(provider.label, style = MaterialTheme.typography.titleSmall)
                        // ONE STATUS PER ROW. It used to stack up to five
                        // lines: the account, the usage, a reconnect paragraph
                        // and the missing scopes. The row now says the one
                        // thing that matters most (describeStatus), and the
                        // rest is one tap away under Details, the way the
                        // scope list already was.
                        val status = describeStatus(linked)
                        Text(status.first, style = MaterialTheme.typography.bodySmall, color = status.second.now)
                        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                            if (!linkedOnly && host != null) TextButton(
                                enabled = !busy,
                                onClick = {
                                    secret = ""
                                    result = ""
                                    // A TOKEN PROVIDER ALREADY PUBLISHED ITS
                                    // PAGE, so there is nothing to ask the box
                                    // for. Claude has no such page — its URL is
                                    // minted per attempt in a pane on that host
                                    // — so the box is asked, and the URL comes
                                    // back as a field rather than scraped out
                                    // of prose.
                                    if (!provider.isSignIn) {
                                        pending = provider
                                    } else {
                                        scope.launch {
                                            busy = true
                                            val reply = Fleet(settings).connect(host, provider.provider)
                                            reply.connections?.let { fresh ->
                                                connections = fresh
                                                pending = fresh.catalogue.firstOrNull { it.provider == provider.provider }
                                            }
                                            if (!reply.ok) result = reply.text
                                            busy = false
                                        }
                                    }
                                },
                            ) { Text(actionLabel(provider, linked)) }

                            // ON A MACHINE'S PAGE, Claude is that machine's;
                            // fleet-wide, a Claude sign-in has no one box to
                            // forget it from, so it is shown as a fact and
                            // forgotten from the machine it is on.
                            if (linked != null && (host != null || !provider.isSignIn)) {
                                // TEST, because "connected" is a fact about
                                // storage and not about the token — it can be
                                // revoked, expire, or have its permissions
                                // narrowed at the provider long after it was
                                // stored, and nothing here would know until a
                                // session failed four hours in.
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            val reply = Fleet(settings).verify(host, provider.provider)
                                            if (reply.check != null) {
                                                checks = checks + (provider.provider to reply.check)
                                                tested = tested - provider.provider
                                                expanded = expanded + provider.provider
                                            } else {
                                                checks = checks - provider.provider
                                                tested = tested + (provider.provider to (reply.text to reply.ok))
                                            }
                                            busy = false
                                        }
                                    },
                                ) { Text("Test") }
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            val reply = if (provider.isSignIn && host != null) Fleet(settings).unlink(host, provider.provider)
                                                else Fleet(settings).unlinkEverywhere(provider.provider)
                                            result = reply.text
                                            reply.connections?.let { connections = it }
                                            busy = false
                                        }
                                    },
                                ) { Text("Forget") }
                            }
                        }

                        // THE REST, once there is any: the account's usage,
                        // the scopes it is missing, how long a reconnect can
                        // wait, and what a Test found. Closed by default and
                        // opened by a Test: a list of scopes is the answer to
                        // a question, not something to read every time this
                        // screen opens.
                        val details = detailLines(provider, linked, checks[provider.provider])
                        if (details.isNotEmpty()) {
                            val open = provider.provider in expanded
                            TextButton(
                                onClick = { expanded = if (open) expanded - provider.provider else expanded + provider.provider },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text(if (open) "Hide details" else "Details") }
                            if (open) {
                                details.forEach { line ->
                                    Text(line.text, style = MaterialTheme.typography.bodySmall, color = line.tone.now)
                                }
                            }
                        }
                        tested[provider.provider]?.let { (text, ok) ->
                            Text(
                                text,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (ok) Design.Palette.inkDim.now else MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }

                pending?.let { p ->
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        // NUMBERED, because this flow leaves the app and comes
                        // back, and "tap the link, then paste" was two controls
                        // with no order between them. The person is in a browser
                        // on somebody else's website and has to know what they
                        // are coming back to do.
                        p.url?.let { url ->
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    // ONE TAP FOR A FLOW THAT COMES BACK. An
                                    // app authorization redirects to our own
                                    // scheme when it is done, so a Custom Tab
                                    // can close itself and the screen below
                                    // refreshes — no step 2, and no "Done"
                                    // button asking somebody to report an
                                    // event the app already received.
                                    //
                                    // The paste route keeps ACTION_VIEW and
                                    // its numbers. It does NOT come back:
                                    // there is a token to copy and no redirect
                                    // to wait for, so an in-app browser would
                                    // open a window that never closes itself.
                                    if (p.isAppFlow) WebAuth.open(context, url)
                                    else context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                },
                            ) {
                                Text(
                                    if (p.isAppFlow) "Connect ${p.label}"
                                    else if (p.isSignIn) "1. Open the sign-in page"
                                    else "1. Open ${p.label} and create the token",
                                )
                            }
                        }
                        Text(p.hint, style = MaterialTheme.typography.bodySmall)
                        // NO PASTE FIELD FOR AN APP FLOW, because there is
                        // nothing to copy. The provider sends the result back
                        // through the coordinator's page to this screen, which
                        // finishes it. A token field here would be asking for
                        // something that does not exist.
                        if (!p.isAppFlow) Text(
                            if (p.isSignIn) "2. Come back and paste the code"
                            else "2. Come back and paste the token",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        // THE FAILURE THE CLI ITSELF ASKS ABOUT. Its refusal
                        // reads "Invalid code. Please make sure the full code
                        // was copied" — a partial copy is the common way this
                        // goes wrong, and on a phone it is easy: the code is
                        // long, it wraps, and a selection drag stops early.
                        // Saying so before the round trip is cheaper than a
                        // refusal after it.
                        if (p.isSignIn) Text(
                            "Copy the whole thing, including anything after a #.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // The one field in this app that holds a live
                        // credential. Password transformation and no
                        // autocapitalisation: Android would otherwise offer to
                        // capitalise a token and keep it in the keyboard's
                        // learned-words cache.
                        if (!p.isAppFlow) OutlinedTextField(
                            value = secret,
                            onValueChange = { secret = it },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
                            label = { Text(if (p.isSignIn) "Code" else "Token") },
                            modifier = Modifier.fillMaxWidth(),
                            // ONE TAP INSTEAD OF A LONG PRESS, and it reads the
                            // clipboard only when tapped — nothing here sees
                            // what was copied unless somebody asks it to.
                            trailingIcon = {
                                TextButton(onClick = {
                                    val clip = context.getSystemService(ClipboardManager::class.java)
                                    val text = clip?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
                                    if (!text.isNullOrBlank()) secret = text.trim()
                                }) { Text("Paste") }
                            },
                        )
                        Text(
                            if (p.isSignIn) "Signing in on ${host ?: "that machine"}."
                            else "Checked with ${p.label} before saving.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                            if (!p.isAppFlow) TextButton(
                                enabled = secret.isNotBlank() && !busy,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        // Cleared the moment it leaves, whether
                                        // or not it worked: a failed paste is
                                        // still a live credential sitting
                                        // behind a screen somebody is about to
                                        // hand back to a colleague.
                                        val sending = secret.trim()
                                        secret = ""
                                        // A token goes fleet-wide; a Claude
                                        // code goes to the box whose pane is
                                        // waiting for it.
                                        val reply = if (p.isSignIn && host != null) Fleet(settings).link(host, p.provider, sending)
                                            else Fleet(settings).linkEverywhere(p.provider, sending)
                                        result = reply.text
                                        reply.connections?.let { connections = it }
                                        if (reply.ok) pending = null
                                        busy = false
                                    }
                                },
                            ) { Text("3. Connect ${p.label}") }
                            TextButton(onClick = {
                                pending = null
                                secret = ""
                            }) { Text("Cancel") }
                        }
                    }
                }

                if (result.isNotBlank()) Text(result, style = MaterialTheme.typography.bodySmall)
            }
    }
}

/**
 * What the button offers, which is not always "replace".
 *
 * Three states, because they are three different jobs:
 *
 *  - **Connect** — nothing stored yet.
 *  - **Update permissions** — a token that is merely SHORT does not need
 *    replacing. Both providers let you edit an existing one, and editing keeps
 *    the value already pasted here working. Offering "Replace" here would send
 *    somebody to mint a second token and abandon the first, which is worse than
 *    what they had.
 *  - **Replace** — a new token, which means REVOKING THE OLD ONE FIRST. Neither
 *    provider lets this revoke on their behalf with the permissions being asked
 *    for, and a token that can manage tokens is stronger than the token itself,
 *    so asking for that would be the wrong trade. The hint names the deletion
 *    as step zero instead of implying it is handled.
 */
private fun actionLabel(provider: Fleet.Connections.Available, linked: Fleet.Connections.Linked?): String {
    if (linked == null) return if (provider.isSignIn) "Sign in" else "Connect"
    if (provider.isSignIn) return "Sign in again"
    if (!linked.missing.isNullOrEmpty()) return "Update permissions"
    return "Replace"
}

/**
 * The one line a row shows: `Connected as @octocat`, `Reconnect needed`,
 * `Not connected`. Most urgent first: a credential that stops within the day
 * outranks the account it is for. The colour never carries the meaning alone
 * (docs/psychology.md §5); the words do. The same words as iOS, which also
 * says `Missing on <machine>` from a field this app's Linked does not carry.
 */
private fun describeStatus(linked: Fleet.Connections.Linked?): Pair<String, Tone> {
    if (linked == null) return "Not connected" to Design.Palette.inkDim
    // THE ONE THAT NEEDS ACTING ON: the token works right now and stops
    // within the day, and the button below is the whole remedy.
    if (linked.needsReconnect) return "Reconnect needed" to Design.Palette.bad
    val account = linked.account
    if (account.isNullOrBlank()) return "Connected" to Design.Palette.inkDim
    return "Connected as $account" to Design.Palette.inkDim
}

/** One line under Details. */
private class Detail(val text: String, val tone: Tone)

/**
 * What goes under Details for a row, in the order it matters, or nothing.
 *
 * USAGE in the account's own figures: the difference between "sessions are
 * failing" and "sessions are failing because this plan is out until 15:10".
 * Nothing at all from a host that has not said; the attention colour only
 * when a window is nearly spent. MISSING PERMISSIONS said here rather than
 * discovered in a session: the asked-for list grows, and a token minted
 * before it grew still verifies and then fails at the step that needs the
 * scope it never had. And what a Test found, when one has been run.
 */
private fun detailLines(provider: Fleet.Connections.Available, linked: Fleet.Connections.Linked?, check: Fleet.Check?): List<Detail> {
    val out = mutableListOf<Detail>()
    if (linked != null) {
        if (linked.needsReconnect) out += Detail("Still works, and stops within eight hours.", Design.Palette.bad)
        linked.usage?.let { usage ->
            out += Detail(describeUsage(usage), if (usage.isNearLimit) Design.Palette.attention else Design.Palette.inkDim)
        }
        linked.missing?.takeIf { it.isNotEmpty() }?.let {
            out += Detail("Missing permissions: ${it.joinToString(", ")}", Design.Palette.attention)
        }
    }
    if (check != null) {
        out += Detail(describeCheck(check), if (check.ok) Design.Palette.ink else Design.Palette.bad)
        val granted = check.granted
        if (granted != null && granted.isNotEmpty()) {
            out += Detail("Has: ${granted.joinToString(", ")}", Design.Palette.inkDim)
        } else if (granted == null) {
            // TWO DIFFERENT REASONS FOR THE SAME NULL, and telling them apart
            // is the difference between "this is fine" and "we could not
            // check". Cloudflare has nothing a token may read about its own
            // permissions, so it never reports — a property of the provider.
            // GitHub reports for classic tokens and not for app or
            // fine-grained ones, so it is a property of the TOKEN, and
            // "GitHub does not report" would be flatly untrue of the next
            // token shown here.
            //
            // The CATALOGUE's `wants` separates them: a provider whose
            // permissions are checkable publishes one.
            out += Detail(
                if (provider.wants.isEmpty()) "${provider.label} does not report what a token was granted."
                else "Permissions for this token are set on ${provider.label}.",
                Design.Palette.inkDim,
            )
        }
        check.missing?.takeIf { it.isNotEmpty() }?.let {
            out += Detail("Asked for and not granted: ${it.joinToString(", ")}", Design.Palette.attention)
        }
    }
    return out
}

/**
 * "works · octocat · 6 scopes · 4 missing", or what went wrong.
 *
 * One line, because it sits under Details with the scopes themselves
 * directly beneath it.
 */
private fun describeCheck(check: Fleet.Check): String {
    if (!check.ok) return check.message ?: "could not be checked"
    return listOfNotNull(
        "works",
        check.account?.takeIf { it.isNotBlank() },
        check.granted?.let { "${it.size} scope${if (it.size == 1) "" else "s"}" },
        check.missing?.takeIf { it.isNotEmpty() }?.let { "${it.size} missing" },
        // WHERE, when the fleet asked every machine and one answered for it.
        check.hostId?.takeIf { it.isNotBlank() }?.let { "on $it" },
    ).joinToString(" · ")
}
