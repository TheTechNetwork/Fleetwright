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
        Hint("This pool lists no storage for VM disks. Add some in Xen Orchestra first.")
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
    // Less the group networks, which are this policy's to make and not a choice.
    val choosable = XoPolicy.choosable(inv)
    if (choosable.isEmpty()) Hint("The pool listed no networks.")
    choosable.forEach { n ->
        CheckRow(
            checked = n.id in choice.networks,
            enabled = enabled,
            title = n.name.ifBlank { n.id },
            line = XoPolicy.networkLine(n) + (if (n.egress) " · internet access now" else "") + inPool(n.pool),
            onChange = { on -> onChange(XoPolicy.withNetwork(choice, n.id, on)) },
        )
    }

    SectionHead("Internet access")
    // WHAT IT IS, in iOS's words, in one sentence; the router is built on it
    // only when the switch below asks for it.
    // ANY OF THE POOL'S NETWORKS, on a machine that takes that (`egress-any`),
    // and only the ones chosen above on one that does not, which is all it
    // takes (checkPolicy). Asked for: the first version offered only the
    // fleet's networks, and the WAN usually belongs on one that is not.
    val anyWayOut = choice.anyWayOut
    val wayOut = if (anyWayOut) {
        "The uplink: the network VMs reach the internet through. Pick one the VMs are not on themselves."
    } else {
        "The uplink: the network VMs reach the internet through, from those chosen above."
    }
    Hint(if (canEdge) wayOut else "$wayOut $machine needs an update to build the router.")
    choosable.filter { anyWayOut || it.id in choice.networks }.forEach { n ->
        RadioRow(
            selected = choice.egress == n.id,
            enabled = enabled,
            title = n.name.ifBlank { n.id },
            line = XoPolicy.networkLine(n),
            // Another pool has its own group networks to start from, and its router filters its own way.
            onClick = {
                val edge = XoPolicy.edgeOn(inv, n.id)
                onChange(choice.copy(egress = n.id, groups = XoPolicy.groupCount(inv, n.id), edgeBlock = edge?.blocks ?: false, edgeHa = edge?.ha ?: false, labsOpen = edge?.labs?.open ?: 0, labsClosed = edge?.labs?.closed ?: 0, labsEach = edge?.labsEach ?: 0))
            },
        )
    }
    RadioRow(
        selected = choice.egress == null,
        enabled = enabled,
        title = "None yet",
        line = if (!anyWayOut && choice.networks.isEmpty()) "Choose a network above to offer it here." else null,
        // No way out, no router and no image: the switches go off with it.
        onClick = { onChange(choice.copy(egress = null, edge = false, image = false, images = emptySet(), groups = 0, holder = false, holderAgain = false)) },
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
                there == null -> "2 vCPU · 2 GiB · 3 GiB disk · 470 MB download"
                there.running -> "Running" + (there.sr?.let { " · disk on $it" } ?: "")
                else -> "Stopped · Apply starts it" + (there.sr?.let { " · disk on $it" } ?: "")
            },
            // The image is built behind the router: no router, no image.
            onChange = { on ->
                val kept = on || there != null
                onChange(choice.copy(edge = on, image = choice.image && kept, images = if (kept) choice.images else emptySet()))
            },
        )
    }
    // WHAT THE ROUTER DOES WITH WHAT ITS THREAT RULES MATCH, offered only by
    // a machine that builds either kind, and only with the router asked for.
    // Asked for: blocking mode for the edge's intrusion detection, which only
    // ever logged. What changing it costs on a router that is there is said
    // once, beside Apply (HypervisorSheet), not here. The same words as iOS.
    if (canEdge && choice.edgeBlockChoice && choice.edge && choice.egress != null) {
        CheckRow(
            checked = choice.edgeBlock,
            enabled = enabled,
            title = "Drop what the threat rules match",
            line = if (choice.edgeBlock) "Blocks matched traffic" else "Logs only",
            onChange = { on -> onChange(choice.copy(edgeBlock = on)) },
        )
    }
    // TWO ROUTERS OR ONE, offered only by a machine that builds a pair, and
    // only with the router asked for. Asked for: "do ha will allow
    // maintenance". The cost of changing it is beside Apply. The same words
    // as iOS.
    if (canEdge && choice.edgeHaChoice && choice.edge && choice.egress != null) {
        CheckRow(
            checked = choice.edgeHa,
            enabled = enabled,
            title = "Two edge routers",
            line = if (choice.edgeHa) "No downtime during updates" else "Brief outage during updates",
            onChange = { on -> onChange(choice.copy(edgeHa = on)) },
        )
    }
    // THE MACHINE IMAGE sessions' machines are cloned from, offered only by a
    // machine that builds one, and only where there is none. Asked for:
    // "Still can't run sessions on it".
    val kinds = inv.imageKinds
    if (canImage && choice.egress != null && choice.imagesChoice && kinds != null) {
        // ONE ROW PER OPERATING SYSTEM the machine can make an image of: a
        // box when the pool does not have it, and when it does, what Apply
        // does to it, kept unless the person says otherwise. Asked for: "os
        // selection not just Debian", and "There is no rebuild button or
        // delete button".
        val there = XoPolicy.edgeOn(inv, choice.egress)
        val present = XoPolicy.imageKeysOn(inv, choice.egress)
        kinds.forEach { kind ->
            // Said beside an image that is there when it was built from main.
            val builtFrom = if (XoPolicy.imageChannelOn(inv, choice.egress, kind.key) == XoPolicy.CHANNEL_ROLLING) XoPolicy.BUILT_FROM_MAIN else ""
            if (kind.key in present && choice.imageManageChoice) {
                Text("${kind.os} machine image", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
                val action = choice.imageActions[kind.key]
                listOf(null to "Keep", XoPolicy.REBUILD to "Rebuild", XoPolicy.REMOVE to "Remove").forEach { (value, title) ->
                    RadioRow(
                        selected = action == value,
                        enabled = enabled,
                        title = title,
                        line = imageThereLine(value) + builtFrom,
                        onClick = {
                            onChange(choice.copy(
                                imageActions = if (value == null) choice.imageActions - kind.key else choice.imageActions + (kind.key to value),
                                rebuiltForChannel = choice.rebuiltForChannel - kind.key,
                            ))
                        },
                    )
                }
            } else if (kind.key in present) {
                Hint("${kind.os} machine image. ${imageThereLine(null)}$builtFrom")
            } else {
                CheckRow(
                    checked = kind.key in choice.images,
                    enabled = enabled,
                    title = "Make the ${kind.os} machine image",
                    line = imageLine(kind),
                    // Built behind the router, so asking for it asks for that too.
                    onChange = { on ->
                        onChange(choice.copy(
                            images = if (on) choice.images + kind.key else choice.images - kind.key,
                            edge = choice.edge || (on && there == null),
                        ))
                    },
                )
            }
        }
        // WHAT AN IMAGE BUILT NOW IS BUILT FROM, offered only by a machine
        // that builds from either (C-2). Asked for: "Or should we build a path
        // for the images to use main/rolling?"
        if (choice.imageChannelChoice) {
            // THROUGH withImageChannel, so an image there built from the other
            // is marked to rebuild: otherwise Apply changes nothing and the
            // screen opens again on what the image was (XoPolicy.Choice).
            Text("Built from", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
            val marked = choice.rebuiltForChannel.count { choice.imageActions[it] == XoPolicy.REBUILD }
            listOf(XoPolicy.CHANNEL_STABLE to "Released versions", XoPolicy.CHANNEL_ROLLING to "Every merge to main").forEach { (value, title) ->
                val chosen = choice.imageChannel == value
                RadioRow(
                    selected = chosen,
                    enabled = enabled,
                    title = title,
                    line = XoPolicy.imageChannelLine(value, present.isNotEmpty() && !(chosen && marked > 0)) +
                        (if (chosen && marked > 0) XoPolicy.channelRebuildLine(marked) else ""),
                    onClick = { onChange(XoPolicy.withImageChannel(inv, choice, value)) },
                )
            }
        }
    } else if (canImage && choice.egress != null) {
        val there = XoPolicy.edgeOn(inv, choice.egress)
        val image = XoPolicy.imageOn(inv, choice.egress)
        if (image != null) {
            Hint("Machine image: ${image.name} · Ready")
        } else {
            CheckRow(
                checked = choice.image,
                enabled = enabled,
                title = "Make the machine image for sessions",
                line = "Debian 13 · 20 GiB disk · 220 MB download · about 10 min",
                // Built behind the router, so asking for it asks for that too.
                onChange = { on -> onChange(choice.copy(image = on, edge = choice.edge || (on && there == null))) },
            )
        }
    }
    // THE POOL'S OWN MACHINE, offered only by a machine that makes one: said
    // as there when the pool has it, a switch when it has not. Asked for:
    // "dedicated hypervisor VM on the pool".
    if (choice.holderChoice && choice.egress != null) {
        val mine = XoPolicy.holderOn(inv, choice.egress)
        if (mine != null) {
            Hint(
                "The pool’s own machine: ${mine.name} · " + if (mine.running) {
                    "Running. Approve it under Machines if you have not yet."
                } else {
                    "Stopped · Apply starts it"
                },
            )
            // MAKE IT AGAIN, for one that never joined: offered only by a
            // machine that makes the new one ask (C-2). The same words as iOS.
            if (choice.holderAskChoice) {
                CheckRow(
                    checked = choice.holderAgain,
                    enabled = enabled,
                    title = "Make it again",
                    line = "Removes ${mine.name} and makes a new one. For one that never joined.",
                    onChange = { on -> onChange(choice.copy(holderAgain = on)) },
                )
            }
        } else {
            val router = XoPolicy.edgeOn(inv, choice.egress)
            CheckRow(
                checked = choice.holder,
                enabled = enabled,
                title = "Make the pool a machine of its own",
                line = "An always-on VM that manages this pool, so $machine need not stay awake.",
                // Made from the image: asking for it asks for Debian's, and the
                // router that is built behind, when the pool has neither.
                onChange = { on ->
                    val needsImage = on && XoPolicy.imageOn(inv, choice.egress) == null && !(choice.imageChoice && choice.wantsImage)
                    onChange(choice.copy(
                        holder = on,
                        images = if (needsImage && choice.imagesChoice) choice.images + XoPolicy.DEBIAN_KEY else choice.images,
                        image = choice.image || (needsImage && !choice.imagesChoice),
                        edge = choice.edge || (needsImage && router == null),
                    ))
                },
            )
        }
    }
    // WHERE THE DISKS GO, asked before anything is built and said while it is:
    // any storage in the uplink's pool with room, the fleet's own first.
    // Asked for: "which disk did it put it on?"
    val (buildEdge, buildImage) = XoPolicy.building(inv, choice)
    if (choice.edgeDiskChoice && (buildEdge || buildImage)) {
        run {
            SectionHead(if (buildEdge && buildImage) "Their disks go on" else if (buildImage) "The image’s disk goes on" else "Its disk goes on")
            val fits = XoPolicy.edgeDisks(inv, choice.egress, XoPolicy.diskNeed(inv, choice))
            if (fits.isEmpty()) {
                Hint(
                    if (buildImage) "Nothing in that network’s pool has 20 GiB free for the image’s disk."
                    else "Nothing in that network’s pool has 3 GiB free for its disk.",
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

    // GROUP NETWORKS, in the uplink's pool: how many to have, from the ones
    // there (never fewer) to four. Asked for: "the 3 VMs need to reach each
    // other". What a machine is fenced from by default is said here, because
    // this is the one place it can be let through. iOS's words.
    if (choice.groupsChoice && choice.egress != null) {
        SectionHead("Machines that work together")
        Hint("VMs in the same group can reach each other. Pick a group when you start a session.")
        val there = XoPolicy.groupCount(inv, choice.egress)
        val range = XoPolicy.groupRange(inv, choice)
        Stepper(
            label = "Groups",
            value = choice.groups.toLong(),
            min = range.first.toLong(),
            max = range.last.toLong(),
            shown = XoPolicy.groupsLine(choice.groups, there),
            bound = "${range.first} to ${range.last}",
            less = "Fewer groups",
            more = "More groups",
            enabled = enabled,
            onValue = { onChange(choice.copy(groups = it.toInt())) },
        )
    }

    // LABS, on the edge router: how many of each kind, four in all at most.
    // Each is a network of its own with one machine at a time, and costs no
    // machine of its own. Changing them rebuilds the router, which is said
    // once, beside Apply (HypervisorSheet). iOS's words.
    if (choice.labsChoice && choice.egress != null && (choice.edge || XoPolicy.edgeOn(inv, choice.egress) != null)) {
        SectionHead("Labs")
        Hint("One VM per lab. Up to four labs." + if (choice.labsEachChoice) " Labs per person caps how many one person holds at once." else "")
        Stepper(
            label = "Open labs",
            value = choice.labsOpen.toLong(),
            min = 0,
            max = (XoPolicy.MAX_LABS - choice.labsClosed).toLong(),
            shown = "${choice.labsOpen} · internet only",
            bound = "0 to ${XoPolicy.MAX_LABS - choice.labsClosed}",
            less = "Fewer open labs",
            more = "More open labs",
            enabled = enabled,
            // Fewer labs, a limit no higher: one past the labs there are is a number nobody could reach.
            onValue = { onChange(choice.copy(labsOpen = it.toInt(), labsEach = minOf(choice.labsEach, it.toInt() + choice.labsClosed))) },
        )
        Stepper(
            label = "Closed labs",
            value = choice.labsClosed.toLong(),
            min = 0,
            max = (XoPolicy.MAX_LABS - choice.labsOpen).toLong(),
            shown = "${choice.labsClosed} · Claude and Fleetwright only",
            bound = "0 to ${XoPolicy.MAX_LABS - choice.labsOpen}",
            less = "Fewer closed labs",
            more = "More closed labs",
            enabled = enabled,
            onValue = { onChange(choice.copy(labsClosed = it.toInt(), labsEach = minOf(choice.labsEach, choice.labsOpen + it.toInt()))) },
        )
        // LABS PER PERSON, offered only by a machine that keeps it and only
        // with labs to limit. Its lowest step is No limit.
        val allLabs = choice.labsOpen + choice.labsClosed
        if (choice.labsEachChoice && allLabs > 0) {
            Stepper(
                label = "Labs per person",
                value = choice.labsEach.toLong(),
                min = 0,
                max = allLabs.toLong(),
                shown = XoPolicy.labsEachLine(choice.labsEach),
                bound = "No limit, or 1 to $allLabs",
                less = "Fewer labs per person",
                more = "More labs per person",
                enabled = enabled,
                onValue = { onChange(choice.copy(labsEach = it.toInt())) },
            )
        }
    }

    // WHAT THE MACHINES MADE HERE MAY DO FROM THE APP, offered only by a
    // machine that applies it (C-2). Each machine is born with it; nothing
    // running is asked to change, so the one line that does is said. The
    // same words as iOS. Asked for: "Should be a toggle where we can either
    // enable it on vms or not".
    if (choice.grantsChoice) {
        SectionHead("Machines made here")
        CheckRow(
            checked = choice.machineUpdates,
            enabled = enabled,
            title = "Update their system from the app",
            line = "Sessions keep running while it updates.",
            onChange = { on -> onChange(choice.copy(machineUpdates = on)) },
        )
        CheckRow(
            checked = choice.machineReboot,
            enabled = enabled,
            title = "Reboot from the app",
            line = "A reboot ends every session on that machine.",
            onChange = { on -> onChange(choice.copy(machineReboot = on)) },
        )
        Hint(XoPolicy.MACHINE_GRANTS_FOOTER)
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

/** What Apply does to an image that is there: kept (null), rebuilt or removed. The same words as iOS (AddHypervisorView.swift). */
private fun imageThereLine(action: String?): String = when (action) {
    XoPolicy.REBUILD -> "Rebuilt on Apply from the newest image"
    XoPolicy.REMOVE -> "Removed on Apply"
    else -> "Ready"
}

/** What making one of the images costs, as a row's line. The same words as iOS (AddHypervisorView.swift). */
private fun imageLine(kind: XoPolicy.ImageKind): String =
    if (kind.key == XoPolicy.DEBIAN_KEY) "Debian 13 · 20 GiB disk · 220 MB download · about 10 min"
    else "${kind.os} · 20 GiB disk · about 10 min"
