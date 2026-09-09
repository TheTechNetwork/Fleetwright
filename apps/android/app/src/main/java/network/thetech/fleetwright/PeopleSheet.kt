package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * Who is allowed into this fleet, and the screen that lets somebody in.
 *
 * Adding a person used to mean editing `AGENT_FLEET_AUTH_ALLOW` in
 * `wrangler.toml`, committing, and waiting for a deploy — a CODE CHANGE PER
 * PERSON, by the one person who could already do everything. The iOS app has
 * had this screen since invitations shipped; this app rendered the same fleet
 * with no way to let anybody into it, while the roadmap said both phones had
 * it.
 *
 * WHAT AN INVITATION IS, said on the screen because it is the thing people get
 * wrong about invitations: permission to attempt a sign-in, not a credential.
 * There is no link to send and nothing to leak — the person signs in with
 * Google as themselves, and the coordinator checks the verified address
 * against this list. So "invite" here means "add an address", and the only
 * thing to send them is the app.
 *
 * ADMIN ONLY, in every direction including reading: a list of who has been
 * invited is a list of colleagues. The screen does not check that itself — it
 * asks, and shows the refusal, which is the pattern the host list uses and the
 * one that keeps the app from having a second opinion about who is allowed
 * to do what.
 *
 * Matches the iOS screen field for field.
 */
@Composable
fun PeopleSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var invites by remember { mutableStateOf(listOf<Fleet.Invite>()) }
    var email by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var result by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }

    suspend fun load() {
        busy = true
        try {
            invites = Fleet(settings).invites()
        } catch (e: Exception) {
            // The refusal reaches the screen rather than an empty list. A
            // member asking this gets "needs an admin credential", which is
            // an answer; an empty list is a lie.
            result = e.message ?: "could not reach the coordinator"
        }
        busy = false
        loaded = true
    }

    LaunchedEffect(Unit) { load() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("People") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
            ) {
                Text("Invite somebody", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    placeholder = { Text("their@email.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Email,
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                // Optional, and worth having: six months later "who is
                // e6591050@gmail.com" is a real question, and the answer is
                // cheapest to record now.
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    placeholder = { Text("what they are here for (optional)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "They sign in as themselves with Google — there is no link to send and nothing to leak. "
                        + "Send them the app. They will bring their own Claude, GitHub and Cloudflare accounts, "
                        + "and see only the sessions they start.",
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(
                    enabled = !busy && email.contains("@"),
                    onClick = {
                        scope.launch {
                            busy = true
                            val reply = Fleet(settings).invite(email.trim(), note)
                            result = reply.text
                            if (reply.ok) {
                                email = ""
                                note = ""
                            }
                            load()
                        }
                    },
                ) { Text("Invite") }

                Text("Invited", style = MaterialTheme.typography.titleSmall)
                if (invites.isEmpty() && loaded) {
                    Text(
                        "Nobody invited yet. The people in this deployment's own allow list are not shown here — "
                            + "they were set when it was deployed.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                invites.forEach { invite ->
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair / 2)) {
                        Text(invite.email, style = MaterialTheme.typography.bodyMedium)
                        invite.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        Text(describeInvite(invite), style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        result = Fleet(settings).uninvite(invite.email).text
                                        load()
                                    }
                                },
                            ) { Text("Withdraw") }
                        }
                    }
                }
                // SAID BEFORE IT MATTERS. Withdrawing stops a future sign-in
                // and does nothing to a phone already signed in — a smaller
                // action than the word suggests, and the gap is exactly where
                // somebody would assume otherwise.
                Text(
                    "Withdrawing stops them signing in again. A phone they have already signed in on keeps "
                        + "working until you revoke it under Devices.",
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
 * "invited by you · 3 Mar 2026" — who and roughly when, which is what somebody
 * scanning this list is actually asking.
 */
private fun describeInvite(invite: Fleet.Invite): String {
    val parts = mutableListOf<String>()
    invite.invitedBy?.let { parts.add("invited by $it") }
    invite.at?.takeIf { it > 0 }?.let { parts.add(DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it))) }
    return parts.joinToString(" · ")
}
