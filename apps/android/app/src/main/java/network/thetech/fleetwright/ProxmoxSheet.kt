package network.thetech.fleetwright

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Add a Proxmox VE cluster, from this phone or by hand. docs/proxmox.md,
 * "From the phone" and "By hand". The same screen as iOS's AddProxmoxView,
 * in the same words.
 *
 * ONE WAY IN: the node's address and its root password, and Set it up.
 * Asked for: "the route through a machine and main direct route can be
 * combined". The phone tries the node itself first (ProxmoxSsh), so the
 * password goes nowhere but the node: it shows the node's key for the person
 * to check the first time, starts the setup as a unit of its own on the
 * node, and follows it. When the phone cannot reach the node, one of the
 * person's machines that can is asked instead, with the address and password
 * already filled in ([ProxmoxThroughSheet], `auto`), and the password sealed
 * to that machine alone. Either way the screen may close: the line is
 * collected when the app is next open ([ProxmoxDirectHandoff],
 * [ProxmoxThroughHandoff]).
 *
 * BY HAND: the same command in the node's own Shell, and the line it prints
 * pasted here. Either way the line is kept in the vault as
 * `hypervisor:<address>`, and the boxes this person approved pick it up
 * within ten minutes (src/fleet/host/pve-pools.js).
 */
@Composable
internal fun ProxmoxSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val known = remember { context.getSharedPreferences("proxmox-host-keys", android.content.Context.MODE_PRIVATE) }
    var line by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var kept by rememberSaveable { mutableStateOf(false) }
    var result by rememberSaveable { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    val parsed = remember(line) { ProxmoxLine.parse(line) }

    // FROM THIS PHONE. The password is never saveable: it goes when the
    // screen does.
    var node by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    /** The key the node answered with, waiting on the person's word, or null. */
    var offered by remember { mutableStateOf<String?>(null) }
    /** The key the person checked, which every connection holds the node to. */
    var trusted by remember { mutableStateOf<String?>(null) }
    var since by remember { mutableStateOf<Long?>(null) }
    var progress by remember { mutableStateOf<ProxmoxSsh.Progress?>(null) }
    var sshText by remember { mutableStateOf("") }
    var sshBusy by remember { mutableStateOf(false) }
    /** The phone could not reach the node: a machine that can does it. */
    var through by rememberSaveable { mutableStateOf(false) }
    val coordinatorOk = Regex("^https://[A-Za-z0-9.:/_-]+$").matches(settings.coordinatorUrl)

    /** Keep a line, from either path, and say what happens next. */
    suspend fun keep(record: ProxmoxLine.Record) {
        busy = true
        PhoneVault(settings).keepHypervisor(Fleet(settings), record.address, record.json).fold(
            onSuccess = {
                kept = true
                failed = false
                line = ""
                // WHAT HAPPENS NEXT, AND WHEN: not "added", a claim about the
                // cluster nobody has checked (C-5).
                result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; " +
                    "it then shows under New session › Where, as Proxmox at ${record.address}."
            },
            onFailure = {
                failed = true
                result = it.message ?: "The vault would not keep it."
            },
        )
        busy = false
    }

    /** A line a run set up and this phone kept in the vault, said as a line kept by hand is. */
    fun keptThrough(address: String) {
        kept = true
        failed = false
        line = ""
        result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; " +
            "it then shows under New session › Where, as Proxmox at $address."
    }

    // A RUN THIS PHONE STARTED and has not collected, followed again when
    // the screen is opened.
    LaunchedEffect(Unit) {
        val run = ProxmoxDirectHandoff.pending(settings).firstOrNull()
        if (node.isBlank() && since == null && run != null) {
            node = run.address
            trusted = run.fingerprint
            since = run.since
        }
    }

    // FOLLOWING THE RUN through the same look a launch takes
    // (ProxmoxDirectHandoff), every three seconds, so the two never both
    // take its line. A look that fails is said and tried again; the run on
    // the node does not depend on this phone.
    LaunchedEffect(since) {
        if (since == null) return@LaunchedEffect
        val at = node.trim()
        while (since != null && !kept) {
            val looked = ProxmoxDirectHandoff.look(settings, at)
            if (looked == null) {
                if (!ProxmoxDirectHandoff.isPending(settings, at)) {
                    since = null
                    sshText = "This phone follows no setup on $at now. If it finished, its line is in your vault."
                    break
                }
            } else {
                looked.fold(
                    onSuccess = { (p, outcome) ->
                        if (p != null) progress = p
                        sshText = ""
                        when (outcome) {
                            is ProxmoxDirectHandoff.Outcome.Kept -> { keptThrough(outcome.address); since = null }
                            is ProxmoxDirectHandoff.Outcome.Failed -> { sshText = outcome.text; since = null }
                            null -> {}
                        }
                    },
                    onFailure = { sshText = "Lost the node for a moment (${it.message}); asking again." },
                )
            }
            if (since != null) delay(3_000)
        }
    }

    /**
     * PHONE FIRST: the node's key asked for, which is also whether this phone
     * reaches it at all. A node it cannot reach goes to a machine that can. A
     * key checked before goes straight on; any other key is shown to be
     * checked, and nothing is sent until it is.
     */
    suspend fun start() {
        sshBusy = true
        sshText = ""
        val at = node.trim()
        if (trusted == null) {
            val answered = ProxmoxSsh.hostKey(at).getOrElse { e ->
                if (coordinatorOk) {
                    through = true
                } else {
                    sshText = "This phone could not reach $at (${e.message}), and its fleet address is not one a machine can be told. Set it up by hand below."
                }
                sshBusy = false
                return
            }
            val remembered = known.getString(at, null)
            if (remembered == answered) {
                trusted = answered
            } else {
                if (remembered != null) sshText = "The node answered with another key than the one checked before. Check it again before going on."
                offered = answered
                sshBusy = false
                return
            }
        }
        val key = trusted ?: run { sshBusy = false; return }
        ProxmoxSsh.run(at, key, password, ProxmoxSsh.NOW).mapCatching { (_, out) -> out.trim().toLong() }.fold(
            onSuccess = { now ->
                ProxmoxSsh.run(at, key, password, ProxmoxSsh.startCommand(settings.coordinatorUrl)).fold(
                    onSuccess = { (status, out) ->
                        if (status == 0) {
                            ProxmoxDirectHandoff.started(settings, at, key, now, password)
                            since = now
                        } else {
                            sshText = "The node would not start the setup: ${out.trim().take(300)}"
                        }
                    },
                    onFailure = { sshText = it.message ?: "The setup could not be started." },
                )
            },
            onFailure = { sshText = signInWords(it) },
        )
        sshBusy = false
    }

    // WHEN THIS PHONE CANNOT REACH THE NODE, one of the person's machines
    // that can does it (ProxmoxThrough), with what was typed here already
    // filled in. Drawn in this screen's place, and back to it when closed.
    if (through) {
        ProxmoxThroughSheet(
            settings,
            node,
            password = password,
            auto = true,
            // KEPT BY THE MACHINE'S HAND-OFF (ProxmoxThroughHandoff), said
            // here as a line kept by hand is.
            kept = { address ->
                keptThrough(address)
                through = false
            },
            onDismiss = { through = false },
        )
        return
    }

    FullScreen(title = "Add Proxmox VE", onDismiss = { password = ""; onDismiss() }) {
        SectionHead("Set it up")
        OutlinedTextField(
            value = node,
            onValueChange = { node = it; offered = null; trusted = null },
            enabled = since == null && !kept,
            label = { Text("The node's address") },
            placeholder = { Text("10.0.0.5") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            enabled = since == null && !kept,
            label = { Text("Its root password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        val waiting = offered
        when {
            !coordinatorOk -> Hint("This phone's fleet address is not one the setup can be told, so set it up by hand below.", color = Design.Palette.bad.now)
            waiting != null -> {
                // THE ONE THING TO CHECK, said once and plainly.
                Hint("The node answered with this key. On its console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub", color = Design.Palette.ink.now)
                SelectionContainer { Text(waiting, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now) }
                OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = {
                    known.edit().putString(node.trim(), waiting).apply()
                    trusted = waiting
                    offered = null
                    scope.launch { start() }
                }) { Text("It matches") }
            }
            since == null && !kept && node.isNotBlank() && password.isNotEmpty() -> OutlinedButton(
                enabled = !sshBusy,
                modifier = Modifier.heightIn(min = 48.dp),
                onClick = { scope.launch { start() } },
            ) { Text(if (sshBusy) "Reaching the node…" else "Set it up") }
        }
        progress?.let { p ->
            p.steps.forEach { Hint(ProxmoxSsh.stepWords(it), color = Design.Palette.ink.now) }
            // HOW FAR INTO THE STEP IT IS ON, when the script says: the
            // image's download and build are most of the wait. A bar only
            // for what it measured.
            val part = p.part
            if (part != null && p.running) {
                part.fill?.let { fill ->
                    LinearProgressIndicator(
                        progress = { fill / 1000f },
                        color = Design.Palette.active.now,
                        trackColor = Design.Palette.track.now,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Hint(part.text)
            }
            if (since != null) Hint("Running on the node, and you need not watch: it carries on if this screen closes, and this phone keeps its line in your vault when Fleetwright is next open.")
        }
        if (sshText.isNotBlank()) Hint(sshText, color = if (since != null) Design.Palette.inkDim.now else Design.Palette.bad.now)
        Hint(
            "Proxmox VE 9 or newer. This phone tries the node itself first, and the password goes to the node and nowhere else; " +
                "it is kept on this phone only while the setup runs. When this phone cannot reach the node, one of your machines " +
                "that can sets it up, with the password sealed to it alone.",
        )

        SectionHead("Or by hand, on the node")
        // SELECTABLE, so a long press copies it whole.
        SelectionContainer {
            Text(ProxmoxLine.setupCommand(settings.coordinatorUrl), style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
        }
        Hint(
            "In Proxmox's web interface: Datacenter › the node › Shell. It makes a pool, a user with no password, " +
                "its token, a firewall group, the lab and group networks and the machine image, which takes a few minutes, and prints one line.",
        )
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
            OutlinedButton(enabled = !busy, modifier = Modifier.heightIn(min = 48.dp), onClick = { scope.launch { keep(parsed) } }) {
                Text(if (busy) "Adding…" else "Add the cluster")
            }
        }
        Hint("The line is the cluster's token. It is kept in your vault and handed only to the machines you approved, which hold it in memory.")

        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
            if (kept) OpenRow("Done") { password = ""; onDismiss() }
        }
    }
}

/** A failed sign-in in words: the password, or the network, not a stack trace. */
private fun signInWords(e: Throwable): String {
    val m = e.message ?: ""
    return when {
        m.contains("Exhausted available authentication", ignoreCase = true) || m.contains("auth", ignoreCase = true) && m.contains("fail", ignoreCase = true) ->
            "The node refused that password for root. Root may also have password sign-in turned off in its sshd."
        else -> m.ifBlank { "The node did not answer." }
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
    /** The command for the node, naming this phone's fleet, which a closed lab answers names for and lets HTTPS reach. */
    fun setupCommand(coordinator: String): String = "curl -fsSLo /root/fleetwright-pve-setup $SCRIPT_URL && bash /root/fleetwright-pve-setup --coordinator $coordinator"

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
