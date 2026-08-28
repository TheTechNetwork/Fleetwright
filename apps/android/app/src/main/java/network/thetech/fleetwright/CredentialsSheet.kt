package network.thetech.fleetwright

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
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(host) {
        busy = true
        Fleet(settings).connections(host).connections?.let { connections = it }
        busy = false
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Credentials on $host") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "Each one is created on the provider's own page, on your account, and can be revoked "
                        + "there at any time. Sessions you start on this box get them; nobody else's do.",
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
                            ) { Text(if (linked == null) "Connect" else "Replace") }

                            if (linked != null) {
                                TextButton(
                                    enabled = !busy,
                                    onClick = {
                                        scope.launch {
                                            busy = true
                                            val reply = Fleet(settings).unlink(host, provider.provider)
                                            result = reply.text
                                            reply.connections?.let { connections = it }
                                            busy = false
                                        }
                                    },
                                ) { Text("Forget") }
                            }
                        }
                    }
                }

                pending?.let { p ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        p.url?.let { url ->
                            TextButton(onClick = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            }) { Text(if (p.isSignIn) "Open the sign-in page" else "Create the token") }
                        }
                        Text(p.hint, style = MaterialTheme.typography.bodySmall)
                        // The one field in this app that holds a live
                        // credential. Password transformation and no
                        // autocapitalisation: Android would otherwise offer to
                        // capitalise a token and keep it in the keyboard's
                        // learned-words cache.
                        OutlinedTextField(
                            value = secret,
                            onValueChange = { secret = it },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
                            label = { Text(if (p.isSignIn) "Paste the code" else "Paste the token") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            if (p.isSignIn)
                                "This page was generated by $host for this attempt, and the code goes back to the same box."
                            else
                                "It is checked with ${p.label} before it is stored, so a typo fails here and not four hours into a session.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
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
                                        val reply = Fleet(settings).link(host, p.provider, sending)
                                        result = reply.text
                                        reply.connections?.let { connections = it }
                                        if (reply.ok) pending = null
                                        busy = false
                                    }
                                },
                            ) { Text("Connect ${p.label}") }
                            TextButton(onClick = { pending = null; secret = "" }) { Text("Cancel") }
                        }
                    }
                }

                if (result.isNotBlank()) Text(result, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}
