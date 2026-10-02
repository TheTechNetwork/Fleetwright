package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch

/**
 * Your vault: each credential kept once, and the boxes that may hold it.
 * See PhoneVault for how, and docs/vault.md for why.
 *
 * THE CREDENTIALS SCREEN LEADS WITH THIS. A credential linked on one box is the
 * older way and shows below it as a fact; this is the way a person keeps
 * Claude, GitHub, Cloudflare and named secrets once for every machine they
 * approve. Every request is sealed to the minter's key and proves whose vault
 * it is with this phone's GitHub sign-in, so it is drawn once that exists.
 *
 * APPROVING A BOX IS ON THAT BOX'S PAGE ([VaultApproval]), beside its own Key,
 * because the comparison of the two fingerprints is the whole of why approving
 * is safe. This lists which boxes hold your credentials, and removes an
 * approval for a box that has left the fleet, which has no page to do it from.
 *
 * The same sentences as iOS (YourVault in RunnersFromPhone.swift), which
 * test/runners-from-phone-in-apps.test.js holds them to.
 */
@Composable
internal fun YourVault(settings: Settings) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val vault = remember { PhoneVault(settings) }
    val phone = remember { PhoneGitHub(settings) }
    var contents by remember { mutableStateOf<PhoneVault.Contents?>(null) }
    var boxes by remember { mutableStateOf<List<Fleet.Host>>(emptyList()) }
    var claudeDraft by remember { mutableStateOf("") }
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
        Hint(
            "Keep each credential here once. A box you approve gets them when a session needs them, " +
                "and loses them when you remove it.",
        )

        val kept = contents
        if (kept == null) {
            Hint("Loading your vault…")
        } else {
            Text(
                if (kept.items.isEmpty()) "Nothing kept yet."
                else "Kept: " + kept.items.joinToString(", ") { PhoneVault.label(it.name) } + ".",
                style = Design.Style.bodySmall,
                color = Design.Palette.ink.now,
            )
            kept.items.forEach { item ->
                TextButton(enabled = !busy, onClick = { act { vault.forget(Fleet(settings), item.name) } }) {
                    Text("Forget ${PhoneVault.label(item.name)}")
                }
            }
        }

        // CLAUDE, kept the same way: this is the vault's Claude row, which
        // runners and approved boxes both use.
        Hint(
            "Runners you start can use your Claude subscription instead of the runner repository's API key. " +
                "Make the token on a computer with claude setup-token, and paste it here.",
        )
        OutlinedTextField(
            value = claudeDraft,
            onValueChange = { claudeDraft = it.trim() },
            label = { Text("Token from claude setup-token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Password,
            ),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            OutlinedButton(
                enabled = !busy && claudeDraft.isNotBlank(),
                onClick = {
                    act { phone.depositClaudeLogin(Fleet(settings), claudeDraft).onSuccess { claudeDraft = "" } }
                },
            ) { Text("Keep for my runners") }
            if (kept?.items?.any { it.name == "claude" } == true) {
                TextButton(
                    enabled = !busy,
                    onClick = { act { phone.depositClaudeLogin(Fleet(settings), null) } },
                ) { Text("Forget my Claude login") }
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

        if (kept != null) {
            // WORKED OUT HERE, from the keys the fleet listed, never the
            // fingerprints the fleet says beside them.
            val inFleet = boxes.mapNotNull { b -> b.publicJwk?.let { PhoneVault.fingerprint(it) to b.hostId } }.toMap()
            val holders = kept.grants.mapNotNull { inFleet[it.fingerprint] }.sorted()
            Text("Boxes", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
            Hint(
                if (holders.isEmpty()) "No box holds your credentials yet. Approve one from its page under Machines."
                else "Held by ${holders.joinToString(", ")}. Approve or remove a box from its page under Machines.",
            )
            // APPROVED, AND NOT IN THIS FLEET ANY MORE: still removable, because
            // an approval outlives the box being taken out of the fleet.
            kept.grants.filter { it.fingerprint !in inFleet }.forEach { grant ->
                Text(
                    "${grant.label.ifBlank { "A box" }} · ${grant.fingerprint} · not in this fleet",
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.inkDim.now,
                )
                TextButton(enabled = !busy, onClick = { act { vault.remove(Fleet(settings), grant) } }) { Text("Remove") }
            }
        }

        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        }
    }
}

/**
 * Whether ONE box may hold your vault's credentials, on that box's page.
 *
 * Beside its Key on purpose: approving is safe because the fingerprint this
 * phone works out from the box's key matches what `fleetwright-sidecar
 * identity` prints on the box, and the page is where both are in view.
 *
 * Drawn only for a permanent box the fleet has a key for, and only once this
 * phone is signed in to GitHub, which is how the vault knows whose it is.
 */
@Composable
internal fun VaultApproval(settings: Settings, host: Fleet.Host) {
    val scope = rememberCoroutineScope()
    val vault = remember { PhoneVault(settings) }
    if (!PhoneGitHub(settings).signedIn) return
    val fingerprint = remember(host) { host.publicJwk?.let { PhoneVault.fingerprint(it) } }
    var grant by remember { mutableStateOf<PhoneVault.Grant?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }

    suspend fun reload() {
        runCatching { vault.list(Fleet(settings)) }
            .onSuccess { c -> grant = c.grants.firstOrNull { it.fingerprint == fingerprint } }
            .onFailure {
                failed = true
                result = it.message ?: "Your vault did not answer."
            }
        loaded = true
    }

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

    LaunchedEffect(host.hostId) { reload() }

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        val held = grant
        when {
            fingerprint == null -> Text(
                "${host.hostId} · no key listed",
                style = Design.Style.label,
                fontFamily = FontFamily.Monospace,
                color = Design.Palette.inkDim.now,
            )
            !loaded -> Hint("Loading your vault…")
            held != null -> {
                Text("Your credentials: Approved", style = Design.Style.bodySmall, color = Design.Palette.ok.now)
                TextButton(enabled = !busy, onClick = { act { vault.remove(Fleet(settings), held) } }) { Text("Remove") }
            }
            else -> {
                Hint("Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.")
                SelectionContainer {
                    Text(fingerprint, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                }
                OutlinedButton(enabled = !busy, onClick = { act { vault.approve(Fleet(settings), host) } }) { Text("Approve") }
            }
        }
        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        }
    }
}
