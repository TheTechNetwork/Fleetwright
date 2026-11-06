package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
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
internal fun ProxmoxSheet(
    settings: Settings,
    startNode: String = "",
    /** Options to open with, over the remembered ones: the cluster's page asks for the firewall on. */
    startOptions: ProxmoxOptions? = null,
    onDismiss: () -> Unit,
) {
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
    // The node's address when Add a hypervisor found Proxmox VE there.
    var node by rememberSaveable { mutableStateOf(startNode) }
    // THE VM IDS the fleet's image and machines take, FROM-TO, or empty for
    // the cluster's next free ones, remembered for next time. Asked for:
    // "vmid range user deserves a choice".
    var vmids by remember { mutableStateOf(known.getString("vmids", "") ?: "") }
    val trimmedVmids = vmids.trim().replace('–', '-')
    val vmidsOk = trimmedVmids.isEmpty() || ProxmoxLine.isVmids(trimmedVmids)
    // EVERY OTHER OPTION, remembered for next time as the numbers are.
    var options by remember { mutableStateOf(startOptions ?: ProxmoxOptions.load(known.getString("options", null))) }
    var optionsOpen by remember { mutableStateOf(startOptions != null) }
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
                ProxmoxSsh.run(at, key, password, ProxmoxSsh.startCommand(settings.coordinatorUrl, trimmedVmids, options)).fold(
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
            vmids = trimmedVmids,
            options = options,
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
        OutlinedTextField(
            value = vmids,
            onValueChange = { vmids = it; known.edit().putString("vmids", it.trim()).apply() },
            enabled = since == null && !kept,
            label = { Text("Machine numbers (optional)") },
            placeholder = { Text("9000-9099") },
            singleLine = true,
            isError = !vmidsOk,
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
            modifier = Modifier.fillMaxWidth(),
        )
        if (!vmidsOk) Hint("Two numbers from 100 up with a dash between, the first no larger, such as 9000-9099.", color = Design.Palette.bad.now)
        ProxmoxOptionsBlock(options, enabled = since == null && !kept, open = optionsOpen, onOpen = { optionsOpen = it }) {
            options = it
            known.edit().putString("options", it.saved()).apply()
        }
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
            since == null && !kept && node.isNotBlank() && password.isNotEmpty() && vmidsOk && options.problem == null -> OutlinedButton(
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
                "that can sets it up, with the password sealed to it alone. Machine numbers are the VM IDs the fleet's image and " +
                "machines take; left empty, they take the cluster's next free ones.",
        )

        SectionHead("Or by hand, on the node")
        // SELECTABLE, so a long press copies it whole.
        SelectionContainer {
            Text(ProxmoxLine.setupCommand(settings.coordinatorUrl, trimmedVmids), style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
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

    /** The same, with the range of machine numbers the person gave, when it is one (`--vmids`, pve-setup.js VMIDS_RE). */
    fun setupCommand(coordinator: String, vmids: String, options: ProxmoxOptions = ProxmoxOptions()): String =
        setupCommand(coordinator) + (if (isVmids(vmids)) " --vmids $vmids" else "") + options.args

    /** FROM-TO, two numbers Proxmox numbers machines with, the first no larger. */
    fun isVmids(s: String): Boolean {
        val m = Regex("^([1-9][0-9]{2,8})-([1-9][0-9]{2,8})$").find(s) ?: return false
        return m.groupValues[1].toLong() <= m.groupValues[2].toLong()
    }

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

/** The options' words, the same on iOS (AddProxmoxView.swift, ProxmoxWords). */
internal object ProxmoxWords {
    const val SYSTEMS_HINT = "Each system chosen becomes an image a session's machine can be made from. One already on the cluster is kept, and built again only when asked."
    const val FIREWALL_HINT = "Until it is on, the fleet's machines are made only on networks you choose. Proxmox VE's own rules keep the nodes' web interface, SSH and cluster traffic open to the local network; anything else coming in to the nodes themselves is dropped, so add a rule first for any other service they run."
}

/**
 * EVERY OPTION THE SETUP TAKES, as this phone sets them. Asked for:
 * "Everything should be in app". The script's defaults are the defaults here,
 * and only what differs from them is passed, so a run with nothing changed is
 * the run it always was. The bounds and the flags are pve-setup.js's
 * (pveOptionsOf, optionArgs), the same as iOS (ProxmoxOptions).
 */
internal data class ProxmoxOptions(
    val firewall: Boolean = false,
    /** "keep" the image there, "rebuild" it, or "none" built at all. */
    val image: String = "keep",
    val channel: String = "stable",
    val storage: String = "",
    val bridge: String = "",
    val expireDays: Int = 365,
    val groups: Int = 2,
    val labsOpen: Int = 1,
    val labsClosed: Int = 1,
    /**
     * Which systems the setup builds an image of, by the script's keys
     * (`--images`, its `pinned` table), in the catalogue's order. Debian 13
     * alone is every run before there was a choice, and options saved then.
     */
    val systems: List<String> = listOf("debian-13"),
) {
    private val trimmedStorage get() = storage.trim()

    fun builds(key: String) = key in systems

    /** One system on or off, the list kept in the catalogue's order. */
    fun withSystem(key: String, on: Boolean) =
        copy(systems = SYSTEMS.map { it.first }.filter { if (it == key) on else it in systems })

    /** Passed only when it is not Debian 13 alone, and never with no image. */
    private val imagesArg: List<String>? get() = if (image == "none" || systems == listOf("debian-13")) null else systems
    private val trimmedBridge get() = bridge.trim()

    /** What is wrong with them, in the script's own words, or null. */
    val problem: String?
        get() = when {
            trimmedStorage.isNotEmpty() && !STORAGE.matches(trimmedStorage) -> "The storage is not a Proxmox VE storage id, such as local-lvm."
            trimmedBridge.isNotEmpty() && !BRIDGE.matches(trimmedBridge) -> "The bridge is not a bridge's name, such as vmbr0."
            labsOpen + labsClosed > 4 -> "Four labs at most, open and closed together."
            image != "none" && systems.isEmpty() -> "Choose at least one system to build, or Do not build one."
            else -> null
        }

    /** The flags for the script, each only when it differs from its default. */
    val args: String
        get() {
            if (problem != null) return ""
            val a = StringBuilder()
            if (firewall) a.append(" --enable-firewall")
            if (image == "rebuild") a.append(" --rebuild-image")
            if (image == "none") a.append(" --no-image")
            imagesArg?.let { a.append(" --images ${it.joinToString(",")}") }
            if (channel == "rolling") a.append(" --channel rolling")
            if (trimmedStorage.isNotEmpty()) a.append(" --storage $trimmedStorage")
            if (trimmedBridge.isNotEmpty()) a.append(" --bridge $trimmedBridge")
            if (expireDays != 365) a.append(" --expire-days $expireDays")
            if (groups != 2) a.append(" --groups $groups")
            if (labsOpen != 1) a.append(" --labs-open $labsOpen")
            if (labsClosed != 1) a.append(" --labs-closed $labsClosed")
            return a.toString()
        }

    /** The same for the route through a machine, sealed with the password. */
    fun payload(): JSONObject {
        val p = JSONObject()
        if (problem != null) return p
        if (firewall) p.put("firewall", true)
        if (image == "rebuild") p.put("rebuildImage", true)
        if (image == "none") p.put("noImage", true)
        imagesArg?.let { p.put("images", JSONArray(it)) }
        if (channel == "rolling") p.put("channel", "rolling")
        if (trimmedStorage.isNotEmpty()) p.put("storage", trimmedStorage)
        if (trimmedBridge.isNotEmpty()) p.put("bridge", trimmedBridge)
        if (expireDays != 365) p.put("expireDays", expireDays)
        if (groups != 2) p.put("groups", groups)
        if (labsOpen != 1) p.put("labsOpen", labsOpen)
        if (labsClosed != 1) p.put("labsClosed", labsClosed)
        return p
    }

    /** Remembered for the next run, as the machine numbers are. */
    fun saved(): String = JSONObject()
        .put("firewall", firewall).put("image", image).put("channel", channel).put("storage", storage).put("bridge", bridge)
        .put("expireDays", expireDays).put("groups", groups).put("labsOpen", labsOpen).put("labsClosed", labsClosed)
        .put("systems", JSONArray(systems))
        .toString()

    companion object {
        val STORAGE = Regex("^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
        val BRIDGE = Regex("^[A-Za-z0-9_.-]{1,15}$")
        val LIFETIMES = listOf(30, 90, 180, 365, 730)

        /** Every system the setup can build, in its own order: the catalogue Xen Orchestra pools build from too (src/fleet/host/vm-image.js, IMAGES). */
        val SYSTEMS = listOf(
            "debian-13" to "Debian 13",
            "ubuntu-24.04" to "Ubuntu 24.04 LTS",
            "ubuntu-26.04" to "Ubuntu 26.04 LTS",
        )

        fun load(text: String?): ProxmoxOptions = runCatching {
            val o = JSONObject(text ?: "")
            ProxmoxOptions(
                firewall = o.optBoolean("firewall", false),
                image = o.optString("image", "keep").takeIf { it in listOf("keep", "rebuild", "none") } ?: "keep",
                channel = o.optString("channel", "stable").takeIf { it in listOf("stable", "rolling") } ?: "stable",
                storage = o.optString("storage", ""),
                bridge = o.optString("bridge", ""),
                expireDays = o.optInt("expireDays", 365).takeIf { it in LIFETIMES } ?: 365,
                groups = o.optInt("groups", 2).coerceIn(0, 4),
                labsOpen = o.optInt("labsOpen", 1).coerceIn(0, 4),
                labsClosed = o.optInt("labsClosed", 1).coerceIn(0, 4),
                systems = o.optJSONArray("systems")?.let { a ->
                    val kept = (0 until a.length()).map { a.optString(it) }.toSet()
                    SYSTEMS.map { it.first }.filter { it in kept }
                } ?: listOf("debian-13"),
            )
        }.getOrDefault(ProxmoxOptions())
    }
}

/** Every option, folded away until opened: the defaults are what most nodes want, and each says what it changes. */
@Composable
internal fun ProxmoxOptionsBlock(options: ProxmoxOptions, enabled: Boolean, open: Boolean, onOpen: (Boolean) -> Unit, onChange: (ProxmoxOptions) -> Unit) {
    OpenRow(if (open) "Options ▾" else "Options") { onOpen(!open) }
    if (!open) return
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Turn on the datacenter firewall", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
        Switch(checked = options.firewall, onCheckedChange = { onChange(options.copy(firewall = it)) }, enabled = enabled)
    }
    Hint(ProxmoxWords.FIREWALL_HINT)
    Hint("Machine images", Design.Palette.ink.now)
    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        listOf("keep" to "Keep what is there", "rebuild" to "Build them again", "none" to "Do not build one").forEach { (k, label) ->
            FilterChip(selected = options.image == k, onClick = { onChange(options.copy(image = k)) }, enabled = enabled, label = { Text(label) })
        }
    }
    if (options.image != "none") {
        ProxmoxOptions.SYSTEMS.forEach { (key, name) ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                Switch(checked = options.builds(key), onCheckedChange = { onChange(options.withSystem(key, it)) }, enabled = enabled)
            }
        }
        Hint(ProxmoxWords.SYSTEMS_HINT)
    }
    Hint("Updates for its machines", Design.Palette.ink.now)
    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        listOf("stable" to "Stable", "rolling" to "Rolling").forEach { (k, label) ->
            FilterChip(selected = options.channel == k, onClick = { onChange(options.copy(channel = k)) }, enabled = enabled, label = { Text(label) })
        }
    }
    OutlinedTextField(
        value = options.storage, onValueChange = { onChange(options.copy(storage = it)) }, enabled = enabled,
        label = { Text("Storage (found by itself when empty)") }, singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = options.bridge, onValueChange = { onChange(options.copy(bridge = it)) }, enabled = enabled,
        label = { Text("Bridge (vmbr0 when empty)") }, singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
        modifier = Modifier.fillMaxWidth(),
    )
    Hint("The fleet's token lasts", Design.Palette.ink.now)
    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        ProxmoxOptions.LIFETIMES.forEach { d ->
            FilterChip(selected = options.expireDays == d, onClick = { onChange(options.copy(expireDays = d)) }, enabled = enabled, label = { Text("$d days") })
        }
    }
    CountRow("Group networks", options.groups, enabled) { onChange(options.copy(groups = it)) }
    CountRow("Open labs", options.labsOpen, enabled) { onChange(options.copy(labsOpen = it)) }
    CountRow("Closed labs", options.labsClosed, enabled) { onChange(options.copy(labsClosed = it)) }
    options.problem?.let { Hint(it, Design.Palette.bad.now) }
}

/** A count from 0 to 4, with a step down and up. */
@Composable
private fun CountRow(label: String, value: Int, enabled: Boolean, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("$label: $value", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
        TextButton(onClick = { onChange(value - 1) }, enabled = enabled && value > 0, modifier = Modifier.heightIn(min = 48.dp)) { Text("−") }
        TextButton(onClick = { onChange(value + 1) }, enabled = enabled && value < 4, modifier = Modifier.heightIn(min = 48.dp)) { Text("+") }
    }
}
