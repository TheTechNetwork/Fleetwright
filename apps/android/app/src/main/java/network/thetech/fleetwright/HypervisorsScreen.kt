package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
 * Each row is the same shape (RHYTHM 1): its address, which kind, and one
 * short status from a fixed set (`HypervisorWords.status`). The why, the
 * machines and the counts are on its page, not in the row (the copy review of
 * 2026-11-06, finding 59). A row that wears the attention ring is one no
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
    /** The same setup with the datacenter firewall already on, for a cluster where it is off. */
    onTurnOnFirewall: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var fleet by remember { mutableStateOf<List<Fleet.Hypervisor>?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<HypervisorRow?>(null) }
    var choosing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf("") }
    var finding by remember { mutableStateOf(false) }
    // Nothing answered as either: said above the two rows.
    var unknown by remember { mutableStateOf<String?>(null) }
    // Machines too old to check for Proxmox VE, named once, quietly.
    var note by remember { mutableStateOf<String?>(null) }
    // What answered last ("xo" or "pve"), so its row says so.
    var marked by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // WHICH KIND, FOUND RATHER THAN ASKED. Asked for: "Instead of ask which
    // kind detect don't ask question you can find the answer to". The fleet's
    // machines look (`xoprobe`, which says whether Xen Orchestra answered and
    // whether Proxmox VE's API did), and so does this phone, at Proxmox VE's
    // port, because a node is often on a network only the phone reaches. Both
    // kinds are rows under the field the whole time: the one that answered is
    // marked and its setup opens; when nothing answers as either, the line
    // above the rows says so and the person picks. Same as iOS.
    fun find() {
        val at = adding.trim()
        if (at.isEmpty() || finding) return
        finding = true
        unknown = null
        note = null
        marked = null
        scope.launch {
            val (probes, phoneSees) = coroutineScope {
                val asked = async { runCatching { Fleet(settings).xoprobe(at).probes }.getOrNull() ?: emptyList() }
                val opens = async { HypervisorAddress.pveAnswers(at) }
                asked.await() to opens.await()
            }
            finding = false
            // THE ONE THAT ANSWERED is remembered first, so its row says so
            // when this screen is next open; the same test decides both.
            marked = if (probes.any { it.xo == true }) "xo" else if (probes.any { it.pve == true } || phoneSees) "pve" else null
            when {
                probes.any { it.xo == true } -> { choosing = false; onAddXo(at) }
                probes.any { it.pve == true } || phoneSees -> { choosing = false; onAddProxmox(HypervisorAddress.node(at)) }
                // A MACHINE THAT NEVER LOOKED is named, in one quiet line under
                // the answer, rather than counted among the ones that found nothing.
                else -> {
                    val didNotLook = probes.filter { it.pveLooked != true && it.through != "phone" }.map { it.hostId }
                    unknown = HypervisorWords.notFound(at)
                    note = if (didNotLook.isEmpty()) null else HypervisorWords.needsUpdate(didNotLook)
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
        HypervisorPage(
            row,
            onSetUpAgain = { open = null; onAddProxmox(HypervisorAddress.node(row.address)) },
            onTurnOnFirewall = { open = null; onTurnOnFirewall(HypervisorAddress.node(row.address)) },
            onDismiss = { open = null },
        )
        return
    }
    if (choosing) {
        FullScreen(title = "Add a hypervisor", onDismiss = { choosing = false }) {
            OutlinedTextField(
                value = adding,
                onValueChange = { adding = it; unknown = null; note = null },
                enabled = !finding,
                label = { Text("Host name or address") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { find() }),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(enabled = adding.isNotBlank() && !finding, modifier = Modifier.heightIn(min = 48.dp), onClick = { find() }) {
                Text(if (finding) "Checking…" else "Find it")
            }
            Hint(HypervisorWords.FIND_FOOTER)
            unknown?.let { Hint(it, Design.Palette.attention.now) }
            note?.let { Hint(it) }
            SectionHead("Which hypervisor is it")
            Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                ChoiceRow("Xen Orchestra", HypervisorWords.XO_CHOICE) { choosing = false; onAddXo(adding.trim()) }
                // THE ONE THAT ANSWERED says so under its row, quietly, in the ok colour.
                if (marked == "xo") Hint(HypervisorWords.FOUND_HERE, Design.Palette.ok.now)
                ChoiceRow("Proxmox VE", HypervisorWords.PVE_CHOICE) { choosing = false; onAddProxmox(HypervisorAddress.node(adding.trim())) }
                if (marked == "pve") Hint(HypervisorWords.FOUND_HERE, Design.Palette.ok.now)
            }
        }
        return
    }

    FullScreen(title = "Hypervisors", onDismiss = onDismiss) {
        when {
            !loaded -> Hint("Checking…")
            rows.isEmpty() -> {
                // THE TITLE KEEPS §7: a fleet that did not answer is not a fleet with
                // no hypervisors, and the title says which.
                SectionHead(if (failed) "Couldn't load hypervisors" else "No hypervisors yet")
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
                // ONE STATUS, never colour alone: the word changes with the
                // colour. `answered` keeps §7: a pool the fleet did not list
                // is waiting for a machine only when the fleet actually
                // answered, and Unknown when it did not.
                Text(
                    HypervisorWords.status(row.fleet, row.onPhone, answered = fleet != null),
                    style = Design.Style.label,
                    color = if (trouble) Design.Palette.attention.now else Design.Palette.inkDim.now,
                )
                // HOW CURRENT ITS PAGE WILL BE, for a pool this phone reads
                // itself: nothing watches a pool while the app is closed, so the
                // row says when this phone last read it.
                if (row.onPhone) {
                    Text(
                        Manage.lastLooked(settings, row.address)?.let { HypervisorWords.updated(relative(it).toString()) } ?: HypervisorWords.NEVER_OPENED,
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

/**
 * One hypervisor: the answer in a sentence, then the machines that checked it,
 * its details, and what can be done. The sentence is the page; the rest is the
 * evidence under it.
 */
@Composable
private fun HypervisorPage(row: HypervisorRow, onSetUpAgain: () -> Unit, onTurnOnFirewall: () -> Unit, onDismiss: () -> Unit) {
    FullScreen(title = row.address, onDismiss = onDismiss) {
        Text(HypervisorWords.answer(row.fleet), style = Design.Style.body, color = Design.Palette.ink.now)
        SectionHead("Machines")
        val boxes = row.fleet?.boxes ?: emptyList()
        if (boxes.isEmpty()) Hint(HypervisorWords.NO_BOX)
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
                // THE MACHINE'S OWN WORDS on why, under Details: the row's
                // verdict is the word beside the name, and the sentence is
                // the mechanism (docs/design-system.md, Words). Same as iOS.
                box.problem?.takeIf { it.isNotBlank() }?.let { Details(it) }
            }
        }
        row.fleet?.let { f ->
            val facts = HypervisorWords.facts(f)
            if (facts.isNotEmpty()) {
                SectionHead("Details")
                facts.forEach { Text(it, style = Design.Style.body, color = Design.Palette.ink.now) }
            }
        }
        if (row.proxmox) {
            Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                // THE FIREWALL, where it is off: the same setup, with the
                // address filled in and the option already on.
                if (row.fleet?.fenced == false) OpenRow(HypervisorWords.TURN_ON_FIREWALL, onClick = onTurnOnFirewall)
                OpenRow("Set it up again", onClick = onSetUpAgain)
            }
            Hint(HypervisorWords.AGAIN_FOOTER)
        } else if (!row.onPhone) {
            Hint(HypervisorWords.XO_ELSEWHERE)
        }
    }
}

/**
 * The page's words, the same on iOS (HypervisorsView.swift); test/hypervisors-in-apps.test.js holds them equal.
 *
 * THREE LEVELS, from the copy review of 2026-11-06: a row says a verdict in a
 * word or three, a page says the result in a sentence and offers at most one
 * action, and the mechanism is not on this screen at all. §7 of
 * docs/psychology.md survives as a word: "cannot tell" is `Unknown` or `Not
 * checked`, never a sentence naming what did not answer, and never "none".
 */
object HypervisorWords {
    const val NONE = "Add one. Machines that can reach it make machines on it for your sessions."
    const val FLEET_SILENT = "Your fleet didn't answer. Only pools on this phone are shown."
    const val FLEET_SILENT_EMPTY = "Your fleet didn't answer, and this phone has no pool of its own."
    const val NO_BOX = "None yet"
    const val TURN_ON_FIREWALL = "Turn on the datacenter firewall"
    const val AGAIN_FOOTER = "Keeps what it made; the old access stops working."
    const val XO_ELSEWHERE = "Its page opens on the phone that set it up."
    const val XO_CHOICE = "A pool of XCP-ng hosts, through Xen Orchestra."
    const val PVE_CHOICE = "A Proxmox VE 9 node or cluster, set up over SSH."
    const val FIND_FOOTER = "Fleetwright checks what answers there and opens the right setup."
    const val FOUND_HERE = "Found at this address"
    const val NEVER_OPENED = "Never opened"

    /** THE ROW'S ONE STATUS, from a fixed set. Trouble is the three that wear the attention colour (`wantsSomething`); the rest are calm. */
    const val READY = "Ready"
    const val CANT_REACH = "Can't reach"
    const val WAITING = "Waiting for a machine"
    const val NEEDS_PVE9 = "Needs Proxmox VE 9"
    const val CHECKING = "Checking"
    const val UNKNOWN = "Unknown"

    /** When this phone last read a pool it holds, for the row. */
    fun updated(time: String) = "Updated $time"

    /** Nothing answered as either kind: the one line above the two rows. */
    fun notFound(address: String) =
        "Couldn't tell what's at $address. Pick one."

    /** Some machines never checked for Proxmox VE: their Fleetwright is older than that check. Named once, quietly, under the answer. */
    fun needsUpdate(machines: List<String>): String =
        "${machines.joinToString(", ")} ${if (machines.size == 1) "needs" else "need"} an update to check for Proxmox VE."

    /** One machine's word on the page: null is "has not checked", never "no". */
    fun reach(reachable: Boolean?): String = when (reachable) {
        true -> "Reached"
        false -> "Can't reach"
        null -> "Not checked"
    }

    /**
     * The row's status. `answered` is whether the fleet sent its list at all: a
     * pool of this phone's the fleet did not list is waiting for a machine only
     * when the fleet said so by leaving it out (§7).
     */
    fun status(h: Fleet.Hypervisor?, onPhone: Boolean, answered: Boolean): String {
        if (h == null) return if (answered && onPhone) WAITING else UNKNOWN
        if (h.boxes.isEmpty()) return WAITING
        if (h.boxes.any { it.reachable == true }) return if (h.onProxmox && h.supported == false) NEEDS_PVE9 else READY
        if (h.boxes.any { it.reachable == false }) return CANT_REACH
        return CHECKING
    }

    /** The page's one sentence: the same verdict as the row, and the one fact that makes it so. */
    fun answer(h: Fleet.Hypervisor?): String {
        if (h == null) return "Unknown. Your fleet said nothing about it."
        if (h.boxes.isEmpty()) return "Waiting for a machine to pick it up."
        val reached = h.boxes.filter { it.reachable == true }.map { it.hostId }
        if (reached.isNotEmpty()) {
            if (h.onProxmox && h.supported == false) return "Needs Proxmox VE 9. No machine is made on it."
            return "Ready. ${reached.joinToString(", ")} ${if (reached.size == 1) "makes" else "make"} machines on it."
        }
        if (h.boxes.any { it.reachable == false }) return "Can't reach it. No machine got through."
        return "Checking. No machine has checked it yet."
    }

    /** Whether the row wears the attention ring: nothing of the fleet's can use it, or the cluster is too old. Checking is not trouble. */
    fun wantsSomething(h: Fleet.Hypervisor?, onPhone: Boolean): Boolean {
        if (h == null) return !onPhone
        if (h.boxes.isEmpty()) return true
        if (h.boxes.any { it.reachable == true }) return h.onProxmox && h.supported == false
        return h.boxes.any { it.reachable == false }
    }

    /** The facts the machines could tell, each said only when known, each a short line. Whether the cluster is new enough is the headline's, not repeated here. */
    fun facts(h: Fleet.Hypervisor): List<String> {
        val lines = mutableListOf<String>()
        h.version?.let { lines.add(if (h.onProxmox) "Proxmox VE $it" else "Version $it") }
        if (h.pools.isNotEmpty()) lines.add("${if (h.onProxmox) "Pool" else "Pools"}: ${h.pools.joinToString(", ")}")
        if (h.onProxmox) {
            when (h.fenced) {
                true -> lines.add("Datacenter firewall on")
                false -> lines.add("Datacenter firewall off: machines only on networks you chose")
                null -> {}
            }
        }
        h.images?.let { lines.add(if (it == 1) "1 image" else "$it images") }
        h.machines?.let { lines.add(if (it == 1) "1 machine made on it" else "$it machines made on it") }
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
