package network.thetech.fleetwright

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Add a Proxmox VE cluster: run the setup on a node, paste the line it
 * prints. docs/proxmox.md, "By hand". The same screen as iOS's
 * AddProxmoxView, in the same words.
 *
 * ONE SCREEN, TWO STEPS, AND NO PASSWORD. The setup script runs as root on
 * the node itself and prints one line, which carries a token born limited and
 * the cluster's CA, and nothing that is a password. This phone keeps it in the
 * vault as `hypervisor:<address>`, as it keeps a Xen Orchestra pool's token,
 * and the boxes this person approved pick it up within ten minutes
 * (src/fleet/host/pve-pools.js). No probe, no machine to pick, no key to
 * compare: no admin credential ever crosses the fleet for Proxmox.
 */
@Composable
internal fun ProxmoxSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var line by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var kept by rememberSaveable { mutableStateOf(false) }
    var result by rememberSaveable { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    val parsed = remember(line) { ProxmoxLine.parse(line) }

    FullScreen(title = "Add Proxmox VE", onDismiss = onDismiss) {
        SectionHead("1. On the node, as root")
        // SELECTABLE, so a long press copies it whole.
        SelectionContainer {
            Text(ProxmoxLine.SETUP_COMMAND, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
        }
        Hint(
            "In Proxmox's web interface: Datacenter › the node › Shell. It makes a pool, a user with no password, " +
                "its token, a firewall group and the machine image, which takes a few minutes, and prints one line. " +
                "Proxmox VE 9 or newer.",
        )

        SectionHead("2. The line it printed")
        OutlinedTextField(
            value = line,
            onValueChange = { line = it },
            enabled = !busy && !kept,
            placeholder = { Text("fleetwright-pve:1:…") },
            textStyle = Design.Style.label.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        if (parsed != null) {
            Column {
                Text(parsed.address, style = Design.Style.bodyStrong, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                Hint("Pool ${parsed.pool}, ${parsed.trustWords}")
            }
        } else if (line.isNotBlank()) {
            // SAID AS SOON AS IT IS NOT ONE, so a half-copied line is found
            // before Add, not after.
            Hint("That is not the whole line the setup printed. It starts with fleetwright-pve:1: and is one long line.", color = Design.Palette.bad.now)
        }
        // DRAWN ONLY WHEN THERE IS A LINE TO KEEP (C-2).
        if (parsed != null && !kept) {
            OutlinedButton(
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
                onClick = {
                    scope.launch {
                        busy = true
                        PhoneVault(settings).keepHypervisor(Fleet(settings), parsed.address, parsed.json).fold(
                            onSuccess = {
                                kept = true
                                failed = false
                                line = ""
                                // WHAT HAPPENS NEXT, AND WHEN: not "added", a
                                // claim about the cluster nobody has checked (C-5).
                                result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; " +
                                    "it then shows under New session › Where, as Proxmox at ${parsed.address}."
                            },
                            onFailure = {
                                failed = true
                                result = it.message ?: "The vault would not keep it."
                            },
                        )
                        busy = false
                    }
                },
            ) { Text(if (busy) "Adding…" else "Add the cluster") }
        }
        Hint("The line is the cluster's token. It is kept in your vault and handed only to the machines you approved, which hold it in memory.")

        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
            if (kept) OpenRow("Done") { onDismiss() }
        }
    }
}

/**
 * The line `fleetwright-pve-setup` prints, read the way the boxes read it
 * (src/fleet/host/pve-pools.js, `parseConnection` and `recordOf`), so a line
 * this phone keeps is one they take. test/pve-pools.test.js holds the prefix,
 * the command and the shapes to the JavaScript.
 */
internal object ProxmoxLine {
    const val PREFIX = "fleetwright-pve:1:"
    const val SCRIPT_URL = "https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup"
    const val SETUP_COMMAND = "curl -fsSLo /root/fleetwright-pve-setup $SCRIPT_URL && bash /root/fleetwright-pve-setup"

    data class Record(val address: String, val pool: String, val trust: String, val json: String) {
        val trustWords: String get() = if (trust == "public") "trusted by its public certificate" else "trusted by its own CA"
    }

    private val TOKEN = Regex("^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val POOL = Regex("^[A-Za-z0-9_-]{1,40}$")
    private val ADDRESS = Regex("^(?:\\[[0-9A-Fa-f:.]{2,45}\\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\\d{1,5})?$")

    fun parse(raw: String): Record? {
        // A LINE PASTED FROM A TERMINAL may carry spaces or a break where it
        // wrapped; none belongs in it, so none is kept.
        val s = raw.filterNot { it.isWhitespace() }
        if (!s.startsWith(PREFIX)) return null
        return runCatching {
            val json = String(java.util.Base64.getUrlDecoder().decode(s.removePrefix(PREFIX)), Charsets.UTF_8)
            val o = JSONObject(json)
            if (o.optString("kind") != "proxmox") return null
            val address = o.optString("address")
            val token = o.optString("token")
            val pool = o.optString("pool")
            if (!ADDRESS.matches(address) || !TOKEN.matches(token) || !POOL.matches(pool)) return null
            // HOW TO TRUST THE CLUSTER, or no record: a CA, or a public certificate.
            val trust = when {
                o.optString("ca").startsWith("-----BEGIN CERTIFICATE-----") -> "ca"
                o.optString("trust") == "public" -> "public"
                else -> return null
            }
            Record(address, pool, trust, json)
        }.getOrNull()
    }
}
