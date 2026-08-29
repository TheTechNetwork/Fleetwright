package network.thetech.fleetwright

import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
@Composable
fun CredentialsSheet(settings: Settings, host: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var connections by remember { mutableStateOf(Fleet.Connections()) }
    var pending by remember { mutableStateOf<Fleet.Connections.Available?>(null) }
    var secret by remember { mutableStateOf("") }
    var result by remember { mutableStateOf("") }
    // The last answer per provider, kept so the detail can be reopened without
    // asking the provider again.
    var checks by remember { mutableStateOf(mapOf<String, Fleet.Check>()) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(host) {
        busy = true
        Fleet(settings).connections(host).connections?.let { connections = it }
        busy = false
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Your credentials") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "Each one is created on the provider's own page, on your account, and can be revoked "
                        + "there at any time. A token goes to every machine in the fleet, because it is yours "
                        + "rather than any one box's — sessions you start get it, and nobody else's do. Signing "
                        + "in to Claude is per machine: that one is a login the box performs, not a token you paste.",
                    style = MaterialTheme.typography.bodySmall,
                )

                connections.catalogue.forEach { provider ->
                    val linked = connections.linked(provider.provider)
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(provider.label, style = MaterialTheme.typography.titleSmall)
                        Text(
                            if (linked == null) "not connected"
                            else if (linked.account.isNullOrBlank()) "connected"
                            else "connected as ${linked.account}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        // MISSING PERMISSIONS, said here rather than discovered
                        // in a session. The asked-for list grows; a token minted
                        // before it grew still verifies, still says "connected",
                        // and then fails at whatever step needs the scope it
                        // never had.
                        if (!linked?.missing.isNullOrEmpty()) {
                            Text(
                                "missing ${linked.missing.joinToString(", ")}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
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

                            if (linked != null) {
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
                                            if (reply.check != null) checks = checks + (provider.provider to reply.check)
                                            else result = reply.text
                                            busy = false
                                        }
                                    },
                                ) { Text("Test") }
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            val reply = if (provider.isSignIn) Fleet(settings).unlink(host, provider.provider)
                                                else Fleet(settings).unlinkEverywhere(provider.provider)
                                            result = reply.text
                                            reply.connections?.let { connections = it }
                                            busy = false
                                        }
                                    },
                                ) { Text("Forget") }
                            }
                        }

                        // WHAT IT CAN DO, once somebody has asked. Shown under
                        // the row rather than in a dialog: it is the answer to
                        // the button directly above it.
                        checks[provider.provider]?.let { c ->
                            Text(
                                describeCheck(c),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (c.ok) MaterialTheme.colorScheme.onSurface
                                else MaterialTheme.colorScheme.error,
                            )
                            c.granted?.takeIf { it.isNotEmpty() }?.let {
                                Text("Has: ${it.joinToString(", ")}", style = MaterialTheme.typography.bodySmall)
                            }
                            if (c.granted == null) {
                                Text(
                                    "${provider.label} does not report what a token was granted.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            c.missing?.takeIf { it.isNotEmpty() }?.let {
                                Text(
                                    "Asked for and not granted: ${it.joinToString(", ")}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                }

                pending?.let { p ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        // NUMBERED, because this flow leaves the app and comes
                        // back, and "tap the link, then paste" was two controls
                        // with no order between them. The person is in a browser
                        // on somebody else's website and has to know what they
                        // are coming back to do.
                        p.url?.let { url ->
                            TextButton(onClick = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            }) {
                                Text(
                                    if (p.isSignIn) "1. Open the sign-in page"
                                    else "1. Open ${p.label} and create the token",
                                )
                            }
                        }
                        Text(p.hint, style = MaterialTheme.typography.bodySmall)
                        // NO PASTE FIELD FOR AN APP FLOW, because there is
                        // nothing to copy. GitHub sends the result to the
                        // coordinator, which hands it to the box over the
                        // socket it already holds. A token field here would be
                        // asking for something that does not exist.
                        Text(
                            if (p.isAppFlow) "2. That is all — GitHub sends the result back by itself."
                            else if (p.isSignIn) "2. Come back and paste the code"
                            else "2. Come back and paste the token",
                            style = MaterialTheme.typography.bodySmall,
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
                            if (p.isSignIn)
                                "This page was generated by $host for this attempt, and the code goes back to the same box."
                            else
                                "It is checked with ${p.label} before it is stored, so a typo fails here and not four "
                                    + "hours into a session. It goes to every machine in the fleet.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
                                        val reply = if (p.isSignIn) Fleet(settings).link(host, p.provider, sending)
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
                                if (p.isAppFlow) {
                                    scope.launch { Fleet(settings).connections(host).connections?.let { connections = it } }
                                }
                            }) { Text(if (p.isAppFlow) "Done" else "Cancel") }
                        }
                    }
                }

                if (result.isNotBlank()) Text(result, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
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
 * "works · octocat · 6 scopes · 4 missing", or what went wrong.
 *
 * One line, because the detail is directly underneath and this sits below a
 * row that is already three lines tall.
 */
private fun describeCheck(check: Fleet.Check): String {
    if (!check.ok) return check.message ?: "could not be checked"
    return listOfNotNull(
        "works",
        check.account?.takeIf { it.isNotBlank() },
        check.granted?.let { "${it.size} scope${if (it.size == 1) "" else "s"}" },
        check.missing?.takeIf { it.isNotEmpty() }?.let { "${it.size} missing" },
    ).joinToString(" · ")
}
