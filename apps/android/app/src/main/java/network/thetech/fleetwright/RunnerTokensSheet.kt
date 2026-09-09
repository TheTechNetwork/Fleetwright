package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * The tokens a repository's workflow uses to join runners to this fleet as
 * you, and the screen that mints and revokes them.
 *
 * WHY A SCREEN. A runner token lives in a GitHub secret and is spent on every
 * run started by hand — the reusable half of runner central, kept beside the
 * single-use ticket the fleet mints when it dispatches a run itself. It has
 * been minted with curl since it shipped, which docs/runner-central.md showed
 * and the parity test recorded as a gap rather than a decision.
 *
 * WHAT A TOKEN IS, said on the screen because it is the thing people get
 * wrong: it authenticates nothing. It answers "whose runner is this" after
 * GitHub has already proved the job is real, and a leaked one attributes a
 * machine to you — it cannot call the API as you or admit a host by itself.
 *
 * SHOWN ONCE. The coordinator keeps a hash, so the value on this screen is
 * the only copy there will ever be. Matches the iOS screen field for field.
 */
@Composable
fun RunnerTokensSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var tokens by remember { mutableStateOf(listOf<Fleet.Client>()) }
    var name by remember { mutableStateOf("") }
    // The secret just minted, and the id it belongs to. Gone with the sheet;
    // nothing else holds it.
    var minted by remember { mutableStateOf<Pair<String, String>?>(null) }
    var result by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<Fleet.Client?>(null) }

    suspend fun load() {
        busy = true
        try {
            tokens = Fleet(settings).runnerTokens()
        } catch (e: Exception) {
            // The refusal reaches the screen rather than an empty list: an
            // empty list is a lie about a request that did not happen.
            result = e.message ?: "could not reach the coordinator"
        }
        busy = false
        loaded = true
    }

    LaunchedEffect(Unit) { load() }

    confirming?.let { token ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("Revoke ${token.name ?: "this token"}?") },
            text = {
                Text("The next run that presents it is refused. Put a new one in the repository's secret to let it back in.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    scope.launch {
                        busy = true
                        result = Fleet(settings).revokeRunnerToken(token.id).text
                        if (minted?.first == token.id) minted = null
                        load()
                    }
                }) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Runner tokens") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
            ) {
                Text("Mint a token for a repository", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = { Text("owner/repo") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(
                    enabled = !busy && name.isNotBlank(),
                    onClick = {
                        scope.launch {
                            busy = true
                            try {
                                minted = Fleet(settings).mintRunnerToken(name.trim())
                                name = ""
                                result = ""
                            } catch (e: Exception) {
                                result = e.message ?: "could not mint a runner token"
                            }
                            load()
                        }
                    },
                ) { Text("Mint a token") }
                minted?.let { (_, token) ->
                    // MONOSPACE, because the next thing that happens to it is
                    // a paste into a repository secret. Said where, rather than
                    // leaving the value to explain itself.
                    Text(token, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    Text(
                        "Shown once. Put it in the repository's FLEETWRIGHT_RUNNER_TOKEN secret.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                Text(
                    "A workflow started by hand presents this to join a runner to the fleet as you. It cannot "
                        + "call the API and cannot admit a machine on its own — GitHub proves the job is real first.",
                    style = MaterialTheme.typography.bodySmall,
                )

                Text("Tokens", style = MaterialTheme.typography.titleSmall)
                if (tokens.isEmpty() && loaded) {
                    Text(
                        "No runner tokens. A run the fleet dispatches itself carries a single-use ticket instead, "
                            + "and needs none of these.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                tokens.forEach { token ->
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair / 2)) {
                        Text(token.name ?: "unnamed", style = MaterialTheme.typography.bodyMedium)
                        Text(describeToken(token), style = MaterialTheme.typography.bodySmall)
                        TextButton(enabled = !busy, onClick = { confirming = token }) { Text("Revoke") }
                    }
                }
                // SAID BEFORE IT MATTERS: revoking is refused at the next
                // enrolment, and a runner already in the fleet stays until its
                // job ends.
                Text(
                    "Revoking stops the next run from joining. A runner already in the fleet keeps working "
                        + "until its job ends.",
                    style = MaterialTheme.typography.bodySmall,
                )

                if (result.isNotBlank()) {
                    Text(result, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

/**
 * "you@example.com · minted 3 Mar 2026 · never used", which is what somebody
 * deciding what to revoke is asking. NEVER USED AND USED LONG AGO MUST LOOK
 * DIFFERENT.
 */
private fun describeToken(token: Fleet.Client): String {
    val dates = DateFormat.getDateInstance(DateFormat.MEDIUM)
    val parts = mutableListOf<String>()
    token.email?.let { parts.add(it) }
    token.createdAt?.takeIf { it > 0 }?.let { parts.add("minted " + dates.format(Date(it))) }
    val seen = token.lastSeenAt
    parts.add(if (seen != null && seen > 0) "last run " + dates.format(Date(seen)) else "never used")
    return parts.joinToString(" · ")
}
