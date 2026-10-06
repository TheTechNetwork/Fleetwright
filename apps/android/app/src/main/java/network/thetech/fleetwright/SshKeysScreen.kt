package network.thetech.fleetwright

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Your SSH public keys, kept in your vault, for the machines made on your
 * hypervisor. docs/hypervisors.md, "Working a machine". iOS's SSHKeysView,
 * in the same words.
 *
 * Asked for: "ssh". Kept as the secret SSH_AUTHORIZED_KEYS, one key a line,
 * which the boxes you approved are handed with the rest of your vault. A
 * machine made on your pool after that takes them on its `fleetwright`
 * account, with sudo (src/fleet/host/xo-pools.js, `machineCloudConfig`).
 *
 * PUBLIC KEYS ONLY, checked here line by line before anything is sent, and
 * again on the box: a private key pasted by mistake never leaves the phone.
 */
@Composable
internal fun SshKeysScreen(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }
    // When they were kept, or null for none; `answered` is whether the vault
    // has said, since null before it has is cannot tell.
    var keptAt by remember { mutableStateOf<Long?>(null) }
    var answered by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    val vault = remember { PhoneVault(settings) }

    val lines = draft.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val notKeys = lines.filterNot { isPublicKey(it) }

    suspend fun load() {
        // A refusal is cannot tell, and leaves the line saying so.
        val contents = runCatching { vault.list(Fleet(settings)) }.getOrNull() ?: return
        keptAt = contents.items.firstOrNull { it.name == "secret:$SSH_SECRET" }?.at
        answered = true
    }

    fun run(work: suspend () -> Result<String>) {
        scope.launch {
            busy = true
            work().onSuccess { message = it; failed = false; draft = "" }.onFailure { message = it.message ?: "that did not work"; failed = true }
            busy = false
            load()
        }
    }

    LaunchedEffect(Unit) { load() }

    FullScreen(title = "SSH keys", onDismiss = onDismiss) {
        SectionHead("SSH keys")
        when {
            !answered -> Hint("Asking your vault…")
            keptAt != null -> Hint("Kept in your vault ${relative(keptAt!!)}. Paste them again to replace them.")
            else -> Hint("None kept yet.")
        }
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            label = { Text("Your SSH public keys, one a line") },
            textStyle = Design.Style.label.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        if (notKeys.isNotEmpty()) {
            Hint(
                "Only public keys, one a line, starting ssh-ed25519, ssh-rsa or ecdsa-sha2. This line is not one: ${notKeys[0].take(40)}",
                Design.Palette.bad.now,
            )
        }
        OutlinedButton(
            onClick = { run { vault.keepSecret(Fleet(settings), SSH_SECRET, lines.joinToString("\n")) } },
            enabled = !busy && lines.isNotEmpty() && notKeys.isEmpty(),
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Keeping…" else "Keep in your vault") }
        if (keptAt != null) {
            OutlinedButton(
                onClick = { run { vault.forget(Fleet(settings), "secret:$SSH_SECRET") } },
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Forget them", color = Design.Palette.bad.now) }
        }
        if (message.isNotBlank()) Hint(message, if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        Hint(
            "A machine made on your hypervisor after you keep them lets you in as fleetwright, with sudo: " +
                "ssh fleetwright@ and its address, on its page under Machines. Machines already running keep what they were made with.",
        )
    }
}

internal const val SSH_SECRET = "SSH_AUTHORIZED_KEYS"

private val KEY_KINDS = listOf(
    "ssh-ed25519 ", "ssh-rsa ", "ecdsa-sha2-nistp256 ", "ecdsa-sha2-nistp384 ", "ecdsa-sha2-nistp521 ",
    "sk-ssh-ed25519@openssh.com ", "sk-ecdsa-sha2-nistp256@openssh.com ",
)

internal fun isPublicKey(line: String): Boolean = KEY_KINDS.any { line.startsWith(it) } && "PRIVATE KEY" !in line
