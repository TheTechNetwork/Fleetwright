package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
@Composable
internal fun ClaudeSetup(settings: Settings, onKept: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val phone = remember { PhoneGitHub(settings) }
    // Bumped when the GitHub sign-in changes, so this redraws into its next step.
    var generation by remember { mutableIntStateOf(0) }
    var draft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        val signedIn = remember(generation) { phone.signedIn }
        if (!signedIn) {
            Hint("Your Claude login is kept under your GitHub account, so sign in to GitHub on this phone first.")
            PhoneGitHubSignIn(settings, onChanged = { generation++ })
        } else {
            Hint(
                "Sessions run on your own Claude subscription. On a computer, run claude setup-token, sign in, " +
                    "and paste the line it prints here. Every runner you start, and every box you approve, uses it.",
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
