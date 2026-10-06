package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * What the fleet may use on a pool, as a form: the choice a policy job waits
 * on (XoPolicy, and HypervisorSheet in policy mode, which owns the job).
 *
 * FOUR QUESTIONS, IN THE ORDER THE MACHINE CHECKS THEM. Storage first,
 * because a VM needs somewhere for its disk and Apply stays off without one;
 * networks; the way out, which can only be one of the networks just chosen;
 * then the limits, whose disk bound is the storage chosen. Every row is the
 * same shape (RHYTHM 1): a box or a dot, the name, and one dim line of what
 * the machine said about it. Nothing here is coloured: the one question on
 * this screen is the whole screen, and the attention ring is for trouble.
 *
 * STATELESS. The choice comes in and every change goes out through
 * [onChange], already put through XoPolicy's rules (the disk follows the
 * storage down, the way out goes with its network), so the form cannot hold
 * a combination the sheet does not know about.
 */
@Composable
internal fun PolicyForm(
    inv: XoPolicy.Inventory,
    choice: XoPolicy.Choice,
    enabled: Boolean,
    canEdge: Boolean,
    machine: String,
    onChange: (XoPolicy.Choice) -> Unit,
    canImage: Boolean = false,
) {
    // WHICH POOL, said only when there is more than one to confuse it with.
    val poolNames = inv.pools.associate { it.id to it.name }
    fun inPool(pool: String?): String =
        if (inv.pools.size > 1) pool?.let { poolNames[it] }?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "" else ""

    SectionHead("Storage")
    if (inv.srs.isEmpty()) {
        Hint("The pool listed no storage a VM's disk can go on, so there is nothing to choose here. Add some in Xen Orchestra first.")
    }
    inv.srs.forEach { s ->
        CheckRow(
            checked = s.id in choice.srs,
            enabled = enabled,
            title = s.name.ifBlank { s.id },
            line = XoPolicy.storageLine(s) + inPool(s.pool),
            onChange = { on -> onChange(XoPolicy.withStorage(inv, choice, s.id, on)) },
        )
    }

    SectionHead("Networks")
    if (inv.networks.isEmpty()) Hint("The pool listed no networks.")
    inv.networks.forEach { n ->
        CheckRow(
            checked = n.id in choice.networks,
            enabled = enabled,
            title = n.name.ifBlank { n.id },
            line = XoPolicy.networkLine(n) + (if (n.egress) " · the way out now" else "") + inPool(n.pool),
            onChange = { on -> onChange(XoPolicy.withNetwork(choice, n.id, on)) },
        )
    }

    SectionHead("Way out")
    // WHAT CHOOSING IT DOES, in iOS's words: the network is recorded, and
    // the router is built on it only when the switch below asks for it.
    // ANY OF THE POOL'S NETWORKS, on a machine that takes that (`egress-any`),
    // and only the ones chosen above on one that does not, which is all it
    // takes (checkPolicy). Asked for: the first version offered only the
    // fleet's networks, and the WAN usually belongs on one that is not.
    val anyWayOut = choice.anyWayOut
    val wayOut = "The network the edge router, an OPNsense VM, will put its WAN on, so labs reach the internet through it and not " +
        "your LAN. It is recorded in Xen Orchestra as the fleetwright-egress tag on that network. " +
        if (anyWayOut) {
            "Any of the pool’s networks can be it. One the fleet’s VMs may not use is the better, so no lab can skip the router."
        } else {
            "Only a network chosen above can be the way out."
        }
    Hint(if (canEdge) wayOut else "$wayOut $machine is too old to build the router; update it to have it built from here.")
    inv.networks.filter { anyWayOut || it.id in choice.networks }.forEach { n ->
        RadioRow(
            selected = choice.egress == n.id,
            enabled = enabled,
            title = n.name.ifBlank { n.id },
            line = XoPolicy.networkLine(n),
            onClick = { onChange(choice.copy(egress = n.id)) },
        )
    }
    RadioRow(
        selected = choice.egress == null,
        enabled = enabled,
        title = "None yet",
        line = if (!anyWayOut && choice.networks.isEmpty()) "Choose a network above to offer it here." else null,
        // No way out, no router and no image: the switches go off with it.
        onClick = { onChange(choice.copy(egress = null, edge = false, image = false)) },
    )
    // THE EDGE ROUTER, offered only by a machine that can build it and only
    // with a way out (C-2): built when the pool has none, kept in step when
    // it has, and what building costs said before it is asked for.
    if (canEdge && choice.egress != null) {
        val there = XoPolicy.edgeOn(inv, choice.egress)
        CheckRow(
            checked = choice.edge,
            enabled = enabled,
            title = if (there == null) "Build the edge router on it" else "Keep the edge router on it",
            line = when {
                there == null ->
                    "An OPNsense VM with 2 vCPUs, 2 GiB of memory and a 3 GiB disk on the storage chosen. " +
                        "$machine downloads OPNsense once, about 470 MB, and builds it while you wait."
                there.running -> "It is there and running. Apply keeps its WAN on this network." + (there.sr?.let { " Its disk is on $it." } ?: "")
                else -> "It is there and stopped. Apply keeps its WAN on this network and starts it." + (there.sr?.let { " Its disk is on $it." } ?: "")
            },
            // The image is built behind the router: no router, no image.
            onChange = { on -> onChange(choice.copy(edge = on, image = choice.image && (on || there != null))) },
        )
    }
    // THE MACHINE IMAGE sessions' machines are cloned from, offered only by a
    // machine that builds one, and only where there is none. Asked for:
    // "Still can't run sessions on it".
    if (canImage && choice.egress != null) {
        val there = XoPolicy.edgeOn(inv, choice.egress)
        val image = XoPolicy.imageOn(inv, choice.egress)
        if (image != null) {
            Hint("Machine image: ${image.name} is there. New session › Where offers machines from it.")
        } else {
            CheckRow(
                checked = choice.image,
                enabled = enabled,
                title = "Make the machine image for sessions",
                line = "Debian 13 with Fleetwright installed, on a 20 GiB disk on the storage chosen. $machine downloads Debian once, " +
                    "about 220 MB, and installs Fleetwright on it, which takes about ten minutes. Sessions can then start on a new " +
                    "machine from it.",
                // Built behind the router, so asking for it asks for that too.
                onChange = { on -> onChange(choice.copy(image = on, edge = choice.edge || (on && there == null))) },
            )
        }
    }
    // WHERE THE DISKS GO, asked before anything is built and said while it is:
    // any storage in the way out's pool with room, the fleet's own first.
    // Asked for: "which disk did it put it on?"
    val (buildEdge, buildImage) = XoPolicy.building(inv, choice)
    if (choice.edgeDiskChoice && (buildEdge || buildImage)) {
        run {
            SectionHead(if (buildEdge && buildImage) "Their disks go on" else if (buildImage) "The image’s disk goes on" else "Its disk goes on")
            val fits = XoPolicy.edgeDisks(inv, choice.egress, XoPolicy.diskNeed(inv, choice))
            if (fits.isEmpty()) {
                Hint(
                    if (buildImage) "Nothing in the way out’s pool has 20 GiB free for the machine image’s disk."
                    else "Nothing in the way out’s pool has 3 GiB free for its disk.",
                )
            }
            val picked = XoPolicy.edgeDisk(inv, choice)
            fits.forEach { s ->
                RadioRow(
                    selected = picked == s.id,
                    enabled = enabled,
                    title = s.name.ifBlank { s.id },
                    line = XoPolicy.storageLine(s),
                    onClick = { onChange(choice.copy(edgeSr = s.id)) },
                )
            }
        }
    }

    SectionHead("Limits")
    Hint("The most the fleet's machines may use between them. Xen Orchestra holds them to it.")
    val maxCpus = XoPolicy.maxCpus(inv).toLong()
    Stepper(
        label = "vCPUs",
        value = choice.cpus.toLong(),
        min = 1,
        max = maxCpus,
        shown = "${choice.cpus}",
        bound = "1 to $maxCpus, what the pool has",
        less = "Fewer vCPUs",
        more = "More vCPUs",
        enabled = enabled,
        onValue = { onChange(choice.copy(cpus = it.toInt())) },
    )
    val maxMemory = XoPolicy.maxMemoryGib(inv)
    Stepper(
        label = "Memory",
        value = choice.memoryGib,
        min = 1,
        max = maxMemory,
        shown = "${choice.memoryGib} GiB",
        bound = "1 to $maxMemory GiB, what the pool has",
        less = "Less memory",
        more = "More memory",
        enabled = enabled,
        onValue = { onChange(choice.copy(memoryGib = it)) },
    )
    val maxDisk = XoPolicy.maxDiskGib(inv, choice.srs)
    Stepper(
        label = "Disk",
        value = choice.diskGib,
        min = XoPolicy.MIN_DISK / XoPolicy.GIB,
        max = maxDisk,
        shown = "${choice.diskGib} GiB",
        bound = "10 to $maxDisk GiB, the size of the storage chosen",
        less = "Less disk",
        more = "More disk",
        enabled = enabled,
        onValue = { onChange(choice.copy(diskGib = it)) },
    )
}

/** One thing the fleet may use or not: the box, the name, and what the machine said about it. 48dp, the whole row the target. */
@Composable
private fun CheckRow(checked: Boolean, enabled: Boolean, title: String, line: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Spacer(Modifier.width(Design.Space.insideTight))
        Column(Modifier.weight(1f)) {
            Text(title, style = Design.Style.body, color = Design.Palette.ink.now)
            Text(line, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
    }
}

/** One answer to the way out. The same shape as CheckRow, with a dot, because only one can be. */
@Composable
private fun RadioRow(selected: Boolean, enabled: Boolean, title: String, line: String?, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Spacer(Modifier.width(Design.Space.insideTight))
        Column(Modifier.weight(1f)) {
            Text(title, style = Design.Style.body, color = Design.Palette.ink.now)
            line?.let { Text(it, style = Design.Style.label, color = Design.Palette.inkDim.now) }
        }
    }
}

/**
 * A limit: its name, its bounds in words, then less, the value, more. The
 * controls sit on a line of their own so a narrow phone or a large type size
 * wraps the words and never squeezes a button under 48dp. Each press moves by
 * XoPolicy.stepFor and stops at the bound, and the button that would go past
 * it is off, not a press that does nothing (C-2).
 */
@Composable
private fun Stepper(
    label: String,
    value: Long,
    min: Long,
    max: Long,
    shown: String,
    bound: String,
    less: String,
    more: String,
    enabled: Boolean,
    onValue: (Long) -> Unit,
) {
    val step = XoPolicy.stepFor(max)
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = Design.Style.body, color = Design.Palette.ink.now)
        Text(bound, style = Design.Style.label, color = Design.Palette.inkDim.now)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            OutlinedButton(
                enabled = enabled && value > min,
                onClick = { onValue((value - step).coerceIn(min, max)) },
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = less },
            ) { Text("−") }
            Text(
                shown,
                style = Design.Style.bodyStrong,
                color = Design.Palette.ink.now,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(min = 72.dp),
            )
            OutlinedButton(
                enabled = enabled && value < max,
                onClick = { onValue((value + step).coerceIn(min, max)) },
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = more },
            ) { Text("+") }
        }
    }
}
