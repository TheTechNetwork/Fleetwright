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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * What the Proxmox VE machines a box made printed as they booted, kept by that
 * box (src/fleet/host/pve-console.js, docs/proxmox.md "A machine that does not
 * join"). Asked for: "add some troubleshooting for VMs that dont join as we
 * cant ssh and get the logs".
 *
 * WHAT THIS PAGE IS FOR: the machine that never joined, which nothing else
 * reaches. One row per machine, newest first, with the one word for how its
 * join went; the one that did not say it joined wears the attention colour,
 * and its row opens what its screen showed. Same as iOS (BootLogsView.swift).
 */
@Composable
internal fun BootLogsPage(settings: Settings, hostId: String, onDismiss: () -> Unit) {
    var machines by remember { mutableStateOf<List<Fleet.BootMachine>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    var showing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(hostId) {
        val r = runCatching { Fleet(settings).logs(hostId, service = "boot") }
        r.onSuccess { reply ->
            if (!reply.ok || reply.boot == null) failed = reply.text.takeIf { it.isNotBlank() } ?: BootWords.COULD_NOT
            else machines = reply.boot
        }.onFailure { failed = it.message ?: BootWords.COULD_NOT }
    }
    showing?.let { name ->
        BootLogPage(settings, hostId, name) { showing = null }
        return
    }
    FullScreen(title = BootWords.TITLE, onDismiss = onDismiss) {
        val list = machines
        when {
            failed != null -> Hint(failed ?: "", color = Design.Palette.attention.now)
            list == null -> Hint(BootWords.READING)
            list.isEmpty() -> Hint(BootWords.NONE)
            else -> Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                list.forEach { m -> BootRow(m) { showing = m.name } }
            }
        }
        Hint(BootWords.FOOTER)
    }
}

@Composable
private fun BootRow(m: Fleet.BootMachine, onClick: () -> Unit) {
    val (word, trouble) = BootWords.state(m.joined, m.reading)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(vertical = Design.Space.insideTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(m.name, style = Design.Style.bodyStrong, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
            Text(word, style = Design.Style.label, color = if (trouble) Design.Palette.attention.now else Design.Palette.inkDim.now)
            Text("  ›", style = Design.Style.body, color = Design.Palette.inkDim.now)
        }
        Text(listOfNotNull(m.address, m.at?.let { relative(it).toString() }).joinToString(" · "), style = Design.Style.label, color = Design.Palette.inkDim.now)
    }
}

/**
 * One machine's boot, as the box kept it: the box's sentence on how the join
 * went, then what the screen showed, monospaced and selectable, because it
 * names addresses and errors that get searched for.
 */
@Composable
private fun BootLogPage(settings: Settings, hostId: String, machine: String, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(hostId, machine) {
        text = runCatching { Fleet(settings).logs(hostId, service = "boot", machine = machine, lines = 200) }
            .fold({ r -> r.text.takeIf { it.isNotBlank() } ?: BootWords.COULD_NOT }, { it.message ?: BootWords.COULD_NOT })
    }
    FullScreen(title = machine, onDismiss = onDismiss) {
        val t = text
        if (t == null) Hint(BootWords.READING) else Quoted(t)
    }
}

/** The page's words, the same on iOS (BootLogsView.swift); test/boot-logs-in-apps.test.js holds the two equal. */
object BootWords {
    const val TITLE = "Machines it made"
    const val NONE = "It has made no Proxmox VE machine since it last started."
    const val READING = "Reading…"
    const val COULD_NOT = "Couldn’t read what this machine kept."
    const val FOOTER = "What each Proxmox VE machine it made showed on its screen while it booted, kept for a day."
    const val JOINED = "Joined"
    const val STILL_READING = "Booting"
    const val NOT_JOINED = "Didn’t join"

    /** One word for how its join went. Not joined is the one that wants something, and it is said as that. */
    fun state(joined: Boolean, reading: Boolean): Pair<String, Boolean> = when {
        joined -> JOINED to false
        reading -> STILL_READING to false
        else -> NOT_JOINED to true
    }
}
