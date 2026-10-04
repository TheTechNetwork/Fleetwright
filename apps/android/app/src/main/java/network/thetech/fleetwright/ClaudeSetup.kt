package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Whether this person's Claude login is kept for their runners and the boxes
 * they approve: the vault's Claude row, which a runner fetches when it joins
 * (src/fleet/minter/claude.js). The same four answers as iOS (ClaudeSetup.swift).
 *
 * FOUR, NOT TWO. "Not kept" only when the vault answered without a Claude row.
 * With no GitHub sign-in on this phone the vault cannot be asked, which is a
 * step to take rather than a fact; a vault that did not answer is cannot tell,
 * which draws nothing.
 */
internal enum class ClaudeKept { Kept, Missing, NeedsGitHub, CannotTell }

internal suspend fun claudeKept(settings: Settings): ClaudeKept {
    if (!settings.configured) return ClaudeKept.CannotTell
    if (!PhoneGitHub(settings).signedIn) return ClaudeKept.NeedsGitHub
    val contents = runCatching { PhoneVault(settings).list(Fleet(settings)) }.getOrNull() ?: return ClaudeKept.CannotTell
    return if (contents.items.any { it.name == "claude" }) ClaudeKept.Kept else ClaudeKept.Missing
}

/**
 * Keep a Claude login for your runners, in the order it has to happen: this
 * phone's GitHub sign-in first, because the minter keeps the login under that
 * account, then the token.
 *
 * WRITTEN BECAUSE NOTHING ASKED. A runner started from New session joined with
 * no Claude login and refused the session it was started for; the only place to
 * keep one was a field deep under Credentials. This is that field where it is
 * needed: on Sessions after sign-in, and in New session for a new machine. The
 * same words as iOS, held equal by test/claude-setup-in-apps.test.js.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ClaudeSetup(settings: Settings, onKept: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val phone = remember { PhoneGitHub(settings) }
    val uri = LocalUriHandler.current
    // Bumped when the GitHub sign-in changes, so this redraws into its next step.
    var generation by remember { mutableIntStateOf(0) }
    var draft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    // Machines that could run `claude setup-token` for this person. Empty until
    // asked and on a fleet with none connected, which leaves only the paste
    // field: nothing is offered that could not happen.
    var machines by remember { mutableStateOf(emptyList<String>()) }
    var machine by remember { mutableStateOf("") }
    // The sign-in page the chosen machine started, once it has.
    var page by remember { mutableStateOf<String?>(null) }
    var pageHost by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        val signedIn = remember(generation) { phone.signedIn }
        if (!signedIn) {
            Hint("Your Claude login is kept under your GitHub account, so sign in to GitHub on this phone first.")
            PhoneGitHubSignIn(settings, onChanged = { generation++ })
        } else {
            LaunchedEffect(Unit) {
                machines = Fleet(settings).fleetHosts().filter { it.state != "offline" }.map { it.hostId }.sorted()
                if (machine.isBlank()) machine = machines.firstOrNull().orEmpty()
            }
            Hint(
                "Sessions run on your own Claude subscription. Keep your login once, and every runner you start, " +
                    "and every box you approve, uses it.",
            )
            val opened = page
            if (opened != null) {
                // A MACHINE IS MAKING IT. The page opened by itself; the button
                // is for coming back to it. Numbered, because the person leaves
                // the app in the middle and has to know what they are coming
                // back to do.
                TextButton(onClick = { uri.openUri(opened) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("1. Open the sign-in page")
                }
                Hint("2. Sign in to Claude, copy the code the page shows, and paste it here.")
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.trim() },
                    label = { Text("Code from the sign-in page") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Password,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(
                        enabled = !busy && code.isNotBlank(),
                        onClick = {
                            scope.launch {
                                busy = true
                                val sending = code
                                code = ""
                                val r = phone.keepTokenFromMachine(Fleet(settings), pageHost, sending)
                                failed = r.isFailure
                                result = r.getOrElse { it.message ?: "$pageHost did not make a token." }
                                if (r.isSuccess) {
                                    page = null
                                    onKept()
                                }
                                busy = false
                            }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (busy) "Keeping…" else "3. Keep my Claude login") }
                    TextButton(onClick = { page = null; code = "" }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("Cancel")
                    }
                }
            } else {
                // WRITTEN BECAUSE IT WAS ASKED FOR: "If a host is available why
                // not offer to run it, return the link, open the page, capture
                // the token?" The field below wanted the output of a command run
                // on a computer, from somebody holding a phone.
                if (machines.isNotEmpty()) {
                    if (machines.size > 1) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                            machines.forEach { m ->
                                FilterChip(selected = m == machine, onClick = { machine = m }, label = { Text(m) })
                            }
                        }
                    }
                    OutlinedButton(
                        enabled = !busy && machine.isNotBlank(),
                        onClick = {
                            scope.launch {
                                busy = true
                                result = ""
                                val reply = Fleet(settings).setupToken(machine)
                                val url = reply.url
                                if (reply.ok && url != null) {
                                    page = url
                                    pageHost = machine
                                    code = ""
                                    runCatching { uri.openUri(url) }
                                } else {
                                    failed = true
                                    result = reply.text.ifBlank { "$machine did not start a sign-in." }
                                }
                                busy = false
                            }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (busy) "Starting…" else "Make it on $machine") }
                    Hint(
                        "$machine runs claude setup-token for you. The token comes back sealed to this phone, " +
                            "and the machine keeps no copy.",
                    )
                }
                Hint(
                    if (machines.isEmpty()) {
                        "On a computer, run claude setup-token, sign in, and paste the line it prints here."
                    } else {
                        "Or, on a computer, run claude setup-token, sign in, and paste the line it prints here."
                    },
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it.trim() },
                    label = { Text("Token from claude setup-token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Password,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(
                    enabled = !busy && draft.isNotBlank(),
                    onClick = {
                        scope.launch {
                            busy = true
                            val r = phone.depositClaudeLogin(Fleet(settings), draft)
                            failed = r.isFailure
                            result = r.getOrElse { it.message ?: "The minter did not keep it." }
                            if (r.isSuccess) {
                                draft = ""
                                onKept()
                            }
                            busy = false
                        }
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (busy) "Keeping…" else "Keep my Claude login") }
            }
        }
        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        }
    }
}

/** The onboarding ask, on Sessions, until the login is kept or put off. */
@Composable
internal fun ClaudeSetupCard(onSetUp: () -> Unit, onPutOff: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Text("Finish setting up", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
        Text(
            "Sessions run on your own Claude account. Keep your Claude login once, and every runner " +
                "you start can use it.",
            style = Design.Style.bodySmall,
            color = Design.Palette.inkDim.now,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            TextButton(onClick = onSetUp, modifier = Modifier.heightIn(min = 48.dp)) { Text("Set up Claude") }
            TextButton(onClick = onPutOff, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Not now", color = Design.Palette.inkDim.now)
            }
        }
    }
}

/** The same steps as a page of their own, opened from the card. */
@Composable
internal fun ClaudeSetupScreen(settings: Settings, onDismiss: () -> Unit) {
    FullScreen(title = "Set up Claude", onDismiss = onDismiss) {
        SectionHead("Claude for your sessions")
        ClaudeSetup(settings, onKept = onDismiss)
    }
}
