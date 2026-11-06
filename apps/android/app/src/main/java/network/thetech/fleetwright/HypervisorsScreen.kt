package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Every hypervisor of yours, of either kind, on one page, and the one way to
 * add another. Asked for: "unify the two hypervisor pages". Machines had Add a
 * hypervisor, Add Proxmox VE and a list of the Xen Orchestra pools this phone
 * holds, and nothing anywhere for a Proxmox VE cluster, whose token lives in
 * the vault and on boxes alone. The same page as iOS (HypervisorsView.swift).
 *
 * Each row is the same shape (RHYTHM 1): its address, which kind, and what the
 * machines holding it saw. A row that wears the attention ring is one no
 * machine can use, or a cluster too old for the fleet.
 */
@Composable
internal fun HypervisorsScreen(
    settings: Settings,
    /** This phone's own pools: their pages read them phone-direct. */
    held: List<XoHandoff.Held>,
    onOpenPool: (String) -> Unit,
    /** Xen Orchestra's setup, with the address it was found at, if any. */
    onAddXo: (String?) -> Unit,
    /** Proxmox VE's setup, with the node it was found at, if any. */
    onAddProxmox: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var fleet by remember { mutableStateOf<List<Fleet.Hypervisor>?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<HypervisorRow?>(null) }
    var choosing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf("") }
    var finding by remember { mutableStateOf(false) }
    // Nothing answered as either: said, and both setups offered.
    var unknown by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // WHICH KIND, FOUND RATHER THAN ASKED. Asked for: "Instead of ask which
    // kind detect don't ask question you can find the answer to". The fleet's
    // machines look (`xoprobe`, which says whether Xen Orchestra answered and
    // whether Proxmox VE's API did), and so does this phone, at Proxmox VE's
    // port, because a node is often on a network only the phone reaches.
    // Only when nothing answers as either is the person asked. Same as iOS.
    fun find() {
        val at = adding.trim()
        if (at.isEmpty() || finding) return
        finding = true
        unknown = null
        scope.launch {
            val (probes, phoneSees) = coroutineScope {
                val asked = async { runCatching { Fleet(settings).xoprobe(at).probes }.getOrNull() ?: emptyList() }
                val opens = async { HypervisorAddress.pveAnswers(at) }
                asked.await() to opens.await()
            }
            finding = false
            when {
                probes.any { it.xo == true } -> { choosing = false; onAddXo(at) }
                probes.any { it.pve == true } || phoneSees -> { choosing = false; onAddProxmox(HypervisorAddress.node(at)) }
                // A MACHINE THAT NEVER LOOKED is named, and the way to make it
                // look given, rather than counted among the ones that found nothing.
                else -> {
                    val didNotLook = probes.filter { it.pveLooked != true && it.through != "phone" }.map { it.hostId }
                    unknown = if (didNotLook.isEmpty()) HypervisorWords.notFound(at) else HypervisorWords.notLooked(at, didNotLook)
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        // A FAILED ASK IS NOT "NONE": what was listed stays, and the page says
        // the fleet did not answer.
        Fleet(settings).hypervisors()
            .onSuccess { fleet = it; failed = false }
            .onFailure { failed = true }
        loaded = true
    }

    val rows = hypervisorRows(fleet, held)

    open?.let { row ->
        HypervisorPage(row, onSetUpAgain = { open = null; onAddProxmox(HypervisorAddress.node(row.address)) }, onDismiss = { open = null })
        return
    }
    if (choosing) {
        FullScreen(title = "Add a hypervisor", onDismiss = { choosing = false }) {
            OutlinedTextField(
                value = adding,
                onValueChange = { adding = it; unknown = null },
                enabled = !finding,
                label = { Text("Host name or address") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { find() }),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(enabled = adding.isNotBlank() && !finding, modifier = Modifier.heightIn(min = 48.dp), onClick = { find() }) {
                Text(if (finding) "Looking…" else "Find it")
            }
            Hint(HypervisorWords.FIND_FOOTER)
            unknown?.let { said ->
                Hint(said, Design.Palette.attention.now)
                SectionHead("Which hypervisor is it")
                Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                    ChoiceRow("Xen Orchestra", HypervisorWords.XO_CHOICE) { choosing = false; onAddXo(adding.trim()) }
                    ChoiceRow("Proxmox VE", HypervisorWords.PVE_CHOICE) { choosing = false; onAddProxmox(HypervisorAddress.node(adding.trim())) }
                }
            }
        }
        return
    }

    FullScreen(title = "Hypervisors", onDismiss = onDismiss) {
        when {
            !loaded -> Hint("Asking the fleet…")
            rows.isEmpty() -> {
                SectionHead("No hypervisors yet")
                Hint(if (failed) HypervisorWords.FLEET_SILENT_EMPTY else HypervisorWords.NONE)
            }
        }
        if (loaded && failed && rows.isNotEmpty()) Hint(HypervisorWords.FLEET_SILENT, Design.Palette.attention.now)
        rows.forEach { row ->
            val trouble = HypervisorWords.wantsSomething(row.fleet, row.onPhone)
            Column(
                Modifier
                    .fillMaxWidth()
                    .fleetCard(radius = Design.Radius.cardSmall, ring = if (trouble) Design.Palette.attention.now.copy(alpha = 0.55f) else Design.Palette.ring.now)
                    .clickable(onClickLabel = "Opens its page", role = Role.Button) {
                        if (row.onPhone) onOpenPool(row.address) else open = row
                    }
                    .heightIn(min = 48.dp)
                    .padding(Design.Space.groupTight),
                verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(row.address, style = Design.Style.bodyStrong, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                    Text(if (row.proxmox) "Proxmox VE" else "Xen Orchestra", style = Design.Style.label, color = Design.Palette.inkDim.now)
                }
                Text(
                    HypervisorWords.status(row.fleet, row.onPhone),
                    style = Design.Style.label,
                    color = if (trouble) Design.Palette.attention.now else Design.Palette.inkDim.now,
                )
                // HOW CURRENT ITS PAGE WILL BE, for a pool this phone reads
                // itself: nothing watches a pool while the app is closed, so the
                // row says when this phone last looked.
                if (row.onPhone) {
                    Text(
                        Manage.lastLooked(settings, row.address)?.let { Manage.Words.rowLooked(relative(it).toString()) } ?: Manage.Words.never,
                        style = Design.Style.label,
                        color = Design.Palette.inkDim.now,
                    )
                }
            }
        }
        // ONE WAY TO ADD, after the list, which is read every time.
        Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
            OpenRow("Add a hypervisor") { choosing = true }
        }
    }
}

/** One row: the fleet's word on a hypervisor, and whether this phone holds its pool. */
internal data class HypervisorRow(val address: String, val proxmox: Boolean, val fleet: Fleet.Hypervisor?, val onPhone: Boolean)

/** The fleet's hypervisors, and this phone's pools the fleet does not list (no machine holds their token yet). */
internal fun hypervisorRows(fleet: List<Fleet.Hypervisor>?, held: List<XoHandoff.Held>): List<HypervisorRow> {
    val all = (fleet ?: emptyList()).map { h ->
        HypervisorRow(h.address, h.onProxmox, h, !h.onProxmox && held.any { it.address == h.address })
    }.toMutableList()
    for (pool in held) if (all.none { !it.proxmox && it.address == pool.address }) all.add(HypervisorRow(pool.address, false, null, true))
    return all.sortedWith(compareBy({ if (it.proxmox) 1 else 0 }, { it.address }))
}

@Composable
private fun ChoiceRow(title: String, line: String, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClick = onClick).padding(vertical = Design.Space.insideTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Text(title, style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
        Text(line, style = Design.Style.label, color = Design.Palette.inkDim.now)
    }
}

/** What the fleet saw of one hypervisor, box by box, and what can be done. */
@Composable
private fun HypervisorPage(row: HypervisorRow, onSetUpAgain: () -> Unit, onDismiss: () -> Unit) {
    FullScreen(title = row.address, onDismiss = onDismiss) {
        SectionHead("What each machine saw")
        val boxes = row.fleet?.boxes ?: emptyList()
        if (boxes.isEmpty()) Hint(HypervisorWords.NO_BOX, Design.Palette.attention.now)
        boxes.forEach { box ->
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(box.hostId, style = Design.Style.bodyStrong, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                    Text(
                        HypervisorWords.reach(box.reachable),
                        style = Design.Style.label,
                        color = when (box.reachable) {
                            true -> Design.Palette.ok.now
                            false -> Design.Palette.attention.now
                            null -> Design.Palette.inkDim.now
                        },
                    )
                }
                box.problem?.let { SelectionContainer { Text(it, style = Design.Style.label, color = Design.Palette.inkDim.now) } }
            }
        }
        Hint(HypervisorWords.BOXES_FOOTER)
        row.fleet?.let { f ->
            SectionHead("The hypervisor")
            HypervisorWords.facts(f).forEach { Text(it, style = Design.Style.body, color = Design.Palette.ink.now) }
        }
        if (row.proxmox) {
            Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                OpenRow("Set it up again", onClick = onSetUpAgain)
            }
            Hint(HypervisorWords.AGAIN_FOOTER)
        } else if (!row.onPhone) {
            Hint(HypervisorWords.XO_ELSEWHERE)
        }
    }
}

/** The page's words, the same on iOS (HypervisorsView.swift); test/hypervisors-in-apps.test.js holds them equal. */
object HypervisorWords {
    const val NONE = "Add one, and the machines that can reach it make machines on it for your sessions."
    const val FLEET_SILENT = "The fleet did not answer, so only the pools this phone holds are listed. Open this page again to ask again."
    const val FLEET_SILENT_EMPTY = "The fleet did not answer, and this phone holds no pool of its own. Open this page again to ask again."
    const val NO_BOX = "No machine of the fleet holds its token yet. Machines pick up a hypervisor from your vault within ten minutes of it being kept there."
    const val BOXES_FOOTER = "Each machine you approved reads your vault and looks at the hypervisor every few minutes. One that can reach it makes machines on it."
    const val AGAIN_FOOTER = "Run on the node again, it finds what it made, keeps the image, and hands over a new line. The old line stops working."
    const val XO_ELSEWHERE = "Its page opens on the phone that set it up, which holds its token."
    const val XO_CHOICE = "A pool of XCP-ng hosts, through the Xen Orchestra in front of it."
    const val PVE_CHOICE = "A Proxmox VE 9 node or cluster, set up over SSH as root."
    const val FIND_FOOTER = "The fleet's machines and this phone look at what answers there, and the setup for it opens."

    /** Nothing answered as Xen Orchestra, and some machines never looked for Proxmox VE: named, with the update that makes them look. */
    fun notLooked(address: String, machines: List<String>): String {
        val one = machines.size == 1
        return "Nothing at $address answered as Xen Orchestra, and this phone could not reach its Proxmox VE port. ${machines.joinToString(", ")} did not look for Proxmox VE: ${if (one) "its" else "their"} Fleetwright is older than that look. Apply update on ${if (one) "its page" else "their pages"} under Machines, then Find it again, or say which it is."
    }

    /** Nothing answered as either kind: the one question the page asks. */
    fun notFound(address: String) =
        "Nothing at $address answered as Xen Orchestra or as Proxmox VE, from the fleet's machines or from this phone. Which is it?"

    fun reach(reachable: Boolean?): String = when (reachable) {
        true -> "reached it"
        false -> "could not reach it"
        null -> "has not looked yet"
    }

    /** The row's one line: the machines that reached it and what is there, or why none could. */
    fun status(h: Fleet.Hypervisor?, onPhone: Boolean): String {
        if (h == null || h.boxes.isEmpty()) {
            return if (onPhone) "On this phone. No machine of the fleet holds its token yet." else "No machine of the fleet holds its token yet."
        }
        val reached = h.boxes.filter { it.reachable == true }.map { it.hostId }
        if (reached.isNotEmpty()) {
            val parts = mutableListOf("Reached from ${reached.joinToString(", ")}")
            h.images?.let { parts.add(if (it == 1) "1 image" else "$it images") }
            h.machines?.let { parts.add(if (it == 1) "1 machine" else "$it machines") }
            if (h.onProxmox && h.supported == false) parts.add("older than Proxmox VE 9")
            return parts.joinToString(" · ")
        }
        h.boxes.firstOrNull { it.reachable == false }?.let { failed ->
            val why = failed.problem?.let { ": $it" } ?: ""
            return "No machine reached it. ${failed.hostId}$why"
        }
        return "Not looked at yet. The machines holding it look every few minutes."
    }

    /** Whether the row wears the attention ring: nothing of the fleet's can use it, or the cluster is too old. Not looked at yet is not trouble. */
    fun wantsSomething(h: Fleet.Hypervisor?, onPhone: Boolean): Boolean {
        if (h == null) return !onPhone
        if (h.boxes.isEmpty()) return true
        if (h.boxes.any { it.reachable == true }) return h.onProxmox && h.supported == false
        return h.boxes.any { it.reachable == false }
    }

    /** The facts the machines could tell, each said only when known. */
    fun facts(h: Fleet.Hypervisor): List<String> {
        val lines = mutableListOf<String>()
        h.version?.let { lines.add(if (h.onProxmox) "Proxmox VE $it" else "Version $it") }
        if (h.supported == false) lines.add("Older than Proxmox VE 9, so no machine is made on it.")
        if (h.pools.isNotEmpty()) lines.add("${if (h.onProxmox) "Pool" else "Pools"}: ${h.pools.joinToString(", ")}")
        if (h.onProxmox) {
            when (h.fenced) {
                true -> lines.add("The datacenter firewall is on, and the fleet's machines are behind it.")
                false -> lines.add("The datacenter firewall is off: machines are made only on networks you chose until it is on.")
                null -> {}
            }
        }
        h.images?.let { lines.add(if (it == 1) "1 machine image" else "$it machine images") }
        h.machines?.let { lines.add(if (it == 1) "1 machine of the fleet's on it" else "$it machines of the fleet's on it") }
        return lines
    }
}

/** An address as Add a hypervisor reads it. The same as iOS (HypervisorAddress). */
internal object HypervisorAddress {
    /** The host, without a port, as the Proxmox VE setup takes it (it is what SSH is pointed at). */
    fun node(address: String): String = split(address).first

    fun split(address: String): Pair<String, Int?> {
        if (address.startsWith("[")) {
            val close = address.indexOf(']')
            if (close > 0) {
                val rest = address.substring(close + 1)
                return address.substring(1, close) to (if (rest.startsWith(":")) rest.drop(1).toIntOrNull() else null)
            }
        }
        val parts = address.split(":")
        if (parts.size == 2) parts[1].toIntOrNull()?.let { return parts[0] to it }
        return address to null
    }

    /**
     * WHETHER PROXMOX VE'S PORT TAKES A CONNECTION from this phone: a TCP
     * connection to 8006 (or the port the address names, unless it is 443,
     * Xen Orchestra's), closed as soon as it opens. Nothing is sent, so no
     * certificate is involved; the setup checks the node itself over SSH.
     */
    suspend fun pveAnswers(address: String): Boolean = withContext(Dispatchers.IO) {
        val (host, named) = split(address)
        val port = named?.takeIf { it != 443 } ?: 8006
        if (host.isBlank()) return@withContext false
        runCatching {
            java.net.Socket().use { it.connect(java.net.InetSocketAddress(host, port), 3_000) }
            true
        }.getOrDefault(false)
    }
}
