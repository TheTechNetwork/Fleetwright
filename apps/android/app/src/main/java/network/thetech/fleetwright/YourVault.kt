package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
                result = it.message ?: "Your credentials did not load."
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

    /**
     * The one word beside a saved credential. A SETUP-TOKEN IS NOT A SIGN-IN,
     * and a plain "Claude" let a person think Remote Control would work; said
     * only when the minter said which (C-5): null is a minter from before it
     * did, and reads as saved and nothing more.
     */
    fun status(item: PhoneVault.Item): String =
        if (item.name == "claude" && item.kind == "token") "No Remote Control" else "Saved"

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        Hint("Saved once, for your sessions on the machines you approve.")

        val kept = contents
        if (kept == null) {
            Hint("Loading your credentials…")
        } else {
            if (kept.items.isEmpty()) {
                Text("Nothing saved yet.", style = Design.Style.bodySmall, color = Design.Palette.ink.now)
            }
            // ONE ROW PER SAVED CREDENTIAL: its name, one status word, and its
            // actions on the row. It was a sentence listing the names and then
            // a column of Test and Forget buttons under it, naming each again.
            // The button says the verb; the item it acts on is the row's name,
            // and the content description says both for TalkBack.
            //
            // TEST, BECAUSE SAVED IS NOT WORKS. A Claude token Claude had
            // revoked sat here as saved until a runner stopped at its first
            // message. Offered only where there is a service to ask (C-2).
            //
            // FORGET ASKS FIRST. It was one tap, beside the button people come
            // here to press, and it took the Claude login out from under every
            // runner without a word.
            kept.items.forEach { item ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    Text(
                        PhoneVault.label(item.name),
                        style = Design.Style.body,
                        color = Design.Palette.ink.now,
                        modifier = Modifier.weight(1f),
                    )
                    Text(status(item), style = Design.Style.label, color = Design.Palette.inkDim.now)
                    if (PhoneVault.isTestable(item.name)) {
                        TextButton(
                            enabled = !busy,
                            onClick = { act { vault.test(Fleet(settings), item.name) } },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Test ${PhoneVault.label(item.name)}" },
                        ) { Text("Test") }
                    }
                    TextButton(
                        enabled = !busy,
                        onClick = { forgetting = item.name },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Forget ${PhoneVault.label(item.name)}" },
                    ) { Text("Forget") }
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
            Text("Add GitHub")
        }
        OutlinedButton(enabled = !busy, onClick = { act { vault.connect(context, Fleet(settings), "cloudflare") } }) {
            Text("Add Cloudflare")
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
        ) { Text("Save secret") }

        if (kept != null) {
            // WORKED OUT HERE, from the keys the fleet listed, never the
            // fingerprints the fleet says beside them.
            val inFleet = boxes.mapNotNull { b -> b.publicJwk?.let { PhoneVault.fingerprint(it) to b.hostId } }.toMap()
            // A box approved for part of the vault (`only`, a pool's own machine
            // and its one record) says so, rather than being listed as if it
            // held everything (eighth audit).
            val holders = kept.grants.mapNotNull { g ->
                inFleet[g.fingerprint]?.let { name ->
                    if (g.only.isEmpty()) name else "$name (${g.only.joinToString(", ") { PhoneVault.label(it) }} only)"
                }
            }.sorted()
            // WHICH MACHINES, as one row with their names, and the how-to once
            // under it. Approving is on each machine's page, beside its key,
            // because the comparison is what makes it safe.
            Text(
                "Machines: ${if (holders.isEmpty()) "none" else holders.joinToString(", ")}",
                style = Design.Style.bodySmall,
                color = Design.Palette.ink.now,
            )
            // APPROVED, AND NOT IN THIS FLEET ANY MORE: still removable, because
            // an approval outlives the box being taken out of the fleet.
            kept.grants.filter { it.fingerprint !in inFleet }.forEach { grant ->
                Text(
                    "${grant.label.ifBlank { "A machine" }} · ${grant.fingerprint} · not in this fleet",
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.inkDim.now,
                )
                TextButton(enabled = !busy, onClick = { act { vault.remove(Fleet(settings), grant) } }) { Text("Remove") }
            }
            Hint("Approve a machine from its page.")
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
                result = it.message ?: "Your credentials did not load."
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
            !loaded -> Hint("Loading your credentials…")
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
                Hint("Check this matches fleetwright-sidecar identity on the machine before approving.")
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
