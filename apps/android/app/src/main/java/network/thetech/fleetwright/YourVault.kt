package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch

/**
 * Your vault: each credential kept once, and the boxes that may hold it.
 * See PhoneVault for how, and docs/vault.md for why.
 *
 * Drawn inside RunnersFromPhone once the minter key is saved and this phone is
 * signed in to GitHub, because every request here is sealed to that key and
 * proves whose vault it is with that sign-in. The Claude login kept above is
 * the same vault's, and shows in the list.
 *
 * A box is offered for approval with the fingerprint this phone worked out
 * from its key, beside the sentence that says to compare it, because the
 * comparison is the whole of why approving is safe. The same sentences as iOS
 * (YourVault in RunnersFromPhone.swift), which
 * test/runners-from-phone-in-apps.test.js holds them to.
 */
@Composable
internal fun YourVault(settings: Settings) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val vault = remember { PhoneVault(settings) }
    var contents by remember { mutableStateOf<PhoneVault.Contents?>(null) }
    var boxes by remember { mutableStateOf<List<Fleet.Host>>(emptyList()) }
    var secretName by remember { mutableStateOf("") }
    var secretValue by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }

    suspend fun reload() {
        val fleet = Fleet(settings)
        runCatching { vault.list(fleet) }
            .onSuccess { contents = it }
            .onFailure {
                failed = true
                result = it.message ?: "Your vault did not answer."
            }
        boxes = fleet.enrolledHosts().filter { !it.revoked && !it.ephemeral }
    }

    /** Run one change, say what it did, then show the vault as it is now. */
    fun act(block: suspend () -> Result<String>) {
        scope.launch {
            busy = true
            result = ""
            val r = block()
            failed = r.isFailure
            result = r.getOrElse { it.message ?: "That did not work." }
            reload()
            busy = false
        }
    }

    LaunchedEffect(Unit) { reload() }

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        Text("Your vault", style = MaterialTheme.typography.titleSmall)
        Text(
            "Keep each credential here once. A box you approve gets them when a session needs them, " +
                "and loses them when you remove it.",
            style = MaterialTheme.typography.bodySmall,
            color = Design.Palette.inkDim.now,
        )

        val kept = contents
        if (kept == null) {
            Text("Loading your vault…", style = MaterialTheme.typography.bodySmall, color = Design.Palette.inkDim.now)
        } else {
            Text(
                if (kept.items.isEmpty()) "Nothing kept yet."
                else "Kept: " + kept.items.joinToString(", ") { PhoneVault.label(it.name) } + ".",
                style = MaterialTheme.typography.bodySmall,
                color = Design.Palette.ink.now,
            )
            kept.items.forEach { item ->
                TextButton(enabled = !busy, onClick = { act { vault.forget(Fleet(settings), item.name) } }) {
                    Text("Forget ${PhoneVault.label(item.name)}")
                }
            }
        }

        OutlinedButton(enabled = !busy, onClick = { act { vault.connect(context, Fleet(settings), "github") } }) {
            Text("Keep GitHub for my boxes")
        }
        OutlinedButton(enabled = !busy, onClick = { act { vault.connect(context, Fleet(settings), "cloudflare") } }) {
            Text("Keep Cloudflare for my boxes")
        }

        OutlinedTextField(
            value = secretName,
            onValueChange = { secretName = it.trim() },
            label = { Text("Secret name") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        )
        OutlinedTextField(
            value = secretValue,
            onValueChange = { secretValue = it },
            label = { Text("Secret value") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        )
        OutlinedButton(
            enabled = !busy && secretName.isNotBlank() && secretValue.isNotEmpty(),
            onClick = {
                act {
                    vault.keepSecret(Fleet(settings), secretName, secretValue).onSuccess {
                        secretName = ""
                        secretValue = ""
                    }
                }
            },
        ) { Text("Keep secret") }

        Text("Boxes", style = MaterialTheme.typography.titleSmall)
        Text(
            "Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.",
            style = MaterialTheme.typography.bodySmall,
            color = Design.Palette.inkDim.now,
        )
        boxes.forEach { box ->
            // WORKED OUT HERE, from the key the fleet listed, never the
            // fingerprint the fleet says beside it.
            val fp = box.publicJwk?.let { PhoneVault.fingerprint(it) }
            val grant = kept?.grants?.firstOrNull { it.fingerprint == fp }
            Text(
                "${box.hostId} · ${fp ?: "no key listed"}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = Design.Palette.ink.now,
            )
            if (grant != null) {
                Text("Approved", style = MaterialTheme.typography.bodySmall, color = Design.Palette.ok.now)
                TextButton(enabled = !busy, onClick = { act { vault.remove(Fleet(settings), grant) } }) { Text("Remove") }
            } else if (fp != null) {
                OutlinedButton(enabled = !busy && kept != null, onClick = { act { vault.approve(Fleet(settings), box) } }) {
                    Text("Approve")
                }
            }
        }

        // APPROVED, AND NOT IN THIS FLEET ANY MORE: still removable, because an
        // approval outlives the box being taken out of the fleet.
        val listed = boxes.mapNotNull { b -> b.publicJwk?.let { PhoneVault.fingerprint(it) } }.toSet()
        kept?.grants?.filter { it.fingerprint !in listed }?.forEach { grant ->
            Text(
                "${grant.label.ifBlank { "A box" }} · ${grant.fingerprint}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = Design.Palette.inkDim.now,
            )
            TextButton(enabled = !busy, onClick = { act { vault.remove(Fleet(settings), grant) } }) { Text("Remove") }
        }

        if (result.isNotBlank()) {
            Text(
                result,
                style = MaterialTheme.typography.bodySmall,
                color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now,
            )
        }
    }
}
