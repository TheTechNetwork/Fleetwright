package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
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
    var contents by remember { mutableStateOf<PhoneVault.Contents?>(null) }
    var boxes by remember { mutableStateOf<List<Fleet.Host>>(emptyList()) }
    var secretName by remember { mutableStateOf("") }
    var secretValue by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    // The item a Forget is waiting on, until the dialog is answered.
    var forgetting by remember { mutableStateOf<String?>(null) }

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

    forgetting?.let { name ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("Forget ${PhoneVault.label(name)}?") },
            text = { Text(PhoneVault.forgetting(name)) },
            confirmButton = {
                TextButton(onClick = {
                    forgetting = null
                    act { vault.forget(Fleet(settings), name) }
                }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
        )
    }

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
            // A SETUP-TOKEN IS NOT A SIGN-IN, and "Kept: Claude" let a person
            // think Remote Control would work. Said only when the minter said
            // which (C-5): null is a minter from before it did.
            if (kept.items.firstOrNull { it.name == "claude" }?.kind == "token") {
                Hint(
                    "Your Claude login is a setup-token: it runs sessions but cannot open Remote Control. " +
                        "Make it on a machine below to have Remote Control.",
                )
            }
            // WHEN THE SIGN-IN RUNS OUT, AND WHY THE LAST RENEWAL FAILED.
            // Said only when the minter said (C-5): the sentence is its record,
            // and a missing one is not "nothing is wrong".
            kept.items.firstOrNull { it.name == "claude" }?.note?.takeIf { it.isNotBlank() }?.let { Hint(it) }
            // TEST, BECAUSE KEPT IS NOT WORKS. A Claude token Claude had
            // revoked sat here as "Kept" until a runner stopped at its first
            // message. Offered only where there is a service to ask (C-2).
            //
            // FORGET ASKS FIRST. It was one tap, beside the button people come
            // here to press, and it took the Claude login out from under every
            // runner without a word.
            kept.items.forEach { item ->
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    if (PhoneVault.isTestable(item.name)) {
                        OutlinedButton(enabled = !busy, onClick = { act { vault.test(Fleet(settings), item.name) } }) {
                            Text("Test ${PhoneVault.label(item.name)}")
                        }
                    }
                    TextButton(enabled = !busy, onClick = { forgetting = item.name }) {
                        Text("Forget ${PhoneVault.label(item.name)}")
                    }
                }
            }
        }

        // CLAUDE, kept the same way: this is the vault's Claude row, which
        // runners and approved boxes both use. The same rows as Set up Claude,
        // so a machine can make the token here too, rather than a paste field
        // that wanted a computer from somebody holding a phone. Its own Forget
        // went: it was a second button doing what Forget Claude above does.
        ClaudeSetup(settings) { scope.launch { reload() } }

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
            // A box approved for part of the vault (`only`, a pool's own machine
            // and its one record) says so, rather than "Held by" as if it held
            // everything (eighth audit).
            val holders = kept.grants.mapNotNull { g ->
                inFleet[g.fingerprint]?.let { name ->
                    if (g.only.isEmpty()) name else "$name (${g.only.joinToString(", ") { PhoneVault.label(it) }} only)"
                }
            }.sorted()
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
            // The whole key hash, as the minter names the grant, not its
            // sixteen-character start.
            .onSuccess { c ->
                val whole = host.publicJwk?.let { PhoneVault.keyHash(it) }
                grant = c.grants.firstOrNull { it.key == whole }
            }
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
                // ONLY WHAT IT WAS GIVEN: a grant scoped by `only` was shown as
                // "Approved" over the whole vault (eighth audit).
                Text(
                    if (held.only.isEmpty()) "Your credentials: Approved"
                    else "Your credentials: only ${held.only.joinToString(", ") { PhoneVault.label(it) }}",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.ok.now,
                )
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
