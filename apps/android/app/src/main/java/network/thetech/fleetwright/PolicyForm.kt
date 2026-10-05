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
internal fun PolicyForm(inv: XoPolicy.Inventory, choice: XoPolicy.Choice, enabled: Boolean, onChange: (XoPolicy.Choice) -> Unit) {
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
    // WHAT CHOOSING IT DOES, and what it does not: the router is not built
    // yet, and a sentence that implied one was would be the screen claiming
    // a state it does not know (C-5).
    Hint(
        "The network the edge router's WAN will go on: the one way out of every lab. Choosing it records it in Xen " +
            "Orchestra, as the fleetwright-egress tag on that network; it does not build the router.",
    )
    inv.networks.filter { it.id in choice.networks }.forEach { n ->
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
        line = if (choice.networks.isEmpty()) "Choose a network above to offer it here." else null,
        onClick = { onChange(choice.copy(egress = null)) },
    )

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
