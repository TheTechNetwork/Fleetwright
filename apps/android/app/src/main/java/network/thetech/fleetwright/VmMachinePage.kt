package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * One machine made on your hypervisor: what it is, how to reach it, and what
 * you can do about it. docs/hypervisors.md, "Working a machine". iOS's
 * VMMachineView, in the same order and the same words.
 *
 * Asked for: "Vm console, settings, reboot, ssh". Everything here is what the
 * box holding the pool last saw, and every fact may be missing: null is
 * CANNOT TELL and is said so, never drawn as a blank or a zero (C-5).
 *
 * THE CONSOLE IS XEN ORCHESTRA'S OWN, opened in the browser where you sign in
 * to it. This phone never holds the pool's token, and a console stream
 * through the fleet would make it hold one.
 *
 * THE ACTIONS ARE THE BOX'S: it holds the token and works the machine under
 * your name, and only a machine tagged as made for you (xo-pools.js,
 * `control`). Each that interrupts a session asks first.
 */
@Composable
fun VmMachinePage(settings: Settings, name: String, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    var machine by remember(name) { mutableStateOf<Fleet.VmMachine?>(null) }
    var loaded by remember(name) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var cpus by remember { mutableStateOf(2) }
    var memoryGib by remember { mutableStateOf(4) }
    var asking by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        // A FAILED REQUEST IS NOT A MISSING MACHINE: what was shown stays.
        Fleet(settings).vmMachines().onSuccess { list ->
            val found = list.firstOrNull { it.name == name }
            machine = found
            if (found != null && !busy) {
                found.cpus?.let { cpus = it }
                found.memory?.let { memoryGib = maxOf(1, Math.round(it / GIB.toDouble()).toInt()) }
            }
        }
        loaded = true
    }

    fun act(action: String, minutes: Int? = null) {
        scope.launch {
            busy = true
            message = ""
            val r = runCatching {
                Fleet(settings).vmctl(
                    name, action, minutes = minutes,
                    cpus = if (action == "resize") cpus else null,
                    memoryGib = if (action == "resize") memoryGib else null,
                )
            }
            r.onSuccess {
                failed = !it.ok
                message = it.text.ifBlank { if (failed) "The fleet refused that." else "Done." }
            }.onFailure {
                failed = true
                message = it.message ?: "that did not work"
            }
            busy = false
            load()
        }
    }

    LaunchedEffect(name) { load() }

    asking?.let { ask ->
        AlertDialog(
            onDismissRequest = { asking = null },
            title = {
                Text(
                    when (ask) {
                        "reboot" -> "Restart $name? A session running on it ends."
                        "resize" -> "Restart $name with the new size? A session running on it ends."
                        else -> "End $name now? It is stopped and removed with its disk, and anything on it is lost."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = { asking = null; act(ask) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(
                        when (ask) {
                            "reboot" -> "Restart"
                            "resize" -> "Restart with $cpus vCPUs and $memoryGib GiB"
                            else -> "End it now"
                        },
                        color = if (ask == "stop") Design.Palette.bad.now else Design.Palette.accent.now,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } },
        )
    }

    FullScreen(name, onDismiss) {
        val m = machine
        when {
            m == null && !loaded -> Hint("Asking the fleet…")
            m == null -> Hint("The fleet has no report of this machine. The box holding your pool may not have looked yet, or it has been removed.")
            else -> {
                SectionHead("This machine")
                Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                    Fact("State", vmStateWords(m.state), if (m.state == "Running") Design.Palette.ok.now else Design.Palette.attention.now)
                    Fact("Made from", m.image ?: "Not reported")
                    Fact("On", m.address)
                    Fact("Network", m.network ?: "Not reported")
                    Fact("Size", sizeWords(m))
                    Fact("Ends", m.until?.let { "${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(it))}, ${relative(it)}" } ?: "Cannot tell")
                }

                SectionHead("Reach it")
                val ssh = m.sshCommand
                if (ssh != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Quoted(ssh) }
                        TextButton(
                            onClick = {
                                context.getSystemService(android.content.ClipboardManager::class.java)
                                    ?.setPrimaryClip(android.content.ClipData.newPlainText("SSH command", ssh))
                            },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Copy the SSH command" },
                        ) { Text("Copy") }
                    }
                } else {
                    Hint("No address reported yet. Its guest agent says it once it has booted.")
                }
                m.consoleUrl?.let { console ->
                    OpenRow("Open its console in Xen Orchestra") { uri.openUri(console) }
                }
                Hint(
                    "SSH takes the public keys you keep under You › SSH keys, on machines made after you add them. " +
                        "The console is Xen Orchestra’s own page, which asks you to sign in there: this phone never holds the pool’s token.",
                )

                SectionHead("Work it")
                OutlinedButton(onClick = { asking = "reboot" }, enabled = !busy && m.state == "Running", modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Restart")
                }
                // LONGER, up to its longest life from when it was made. Not drawn
                // past that: a button that can only be refused is not an action.
                if (canExtend(m)) {
                    Text("Give it longer", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
                    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        listOf(30 to "30 minutes", 60 to "1 hour", 120 to "2 hours").forEach { (minutes, label) ->
                            OutlinedButton(onClick = { act("extend", minutes) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text(label)
                            }
                        }
                    }
                }
                Counter("$cpus vCPU${if (cpus == 1) "" else "s"}", enabled = !busy, canLess = cpus > 1, canMore = cpus < 64,
                    onLess = { cpus-- }, onMore = { cpus++ })
                Counter("$memoryGib GiB of memory", enabled = !busy, canLess = memoryGib > 1, canMore = memoryGib < 512,
                    onLess = { memoryGib-- }, onMore = { memoryGib++ })
                OutlinedButton(
                    onClick = { asking = "resize" },
                    enabled = !busy && !(cpus == m.cpus && memoryGib.toLong() * GIB == m.memory),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("Restart with this size") }
                OutlinedButton(onClick = { asking = "stop" }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("End it now", color = Design.Palette.bad.now)
                }
                if (message.isNotBlank()) Hint(message, if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
                Hint(
                    "A machine lives at most ${Fleet.VmMachine.MAX_MINUTES} minutes from when it was made. A new size is " +
                        "held to your pool’s limits, and the machine restarts at its old size if the pool refuses.",
                )
            }
        }
    }
}

private const val GIB = 1024L * 1024 * 1024

@Composable
private fun Fact(label: String, value: String, tone: androidx.compose.ui.graphics.Color = Design.Palette.ink.now) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = Design.Style.label, color = Design.Palette.inkDim.now, modifier = Modifier.weight(1f))
        Text(value, style = Design.Style.label, color = tone, textAlign = TextAlign.End, modifier = Modifier.weight(2f))
    }
}

/** A number with a less and a more, each 48dp, for the size. */
@Composable
private fun Counter(label: String, enabled: Boolean, canLess: Boolean, canMore: Boolean, onLess: () -> Unit, onMore: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
        TextButton(onClick = onLess, enabled = enabled && canLess, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Less" }) {
            Text("−")
        }
        TextButton(onClick = onMore, enabled = enabled && canMore, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "More" }) {
            Text("+")
        }
    }
}

private fun sizeWords(m: Fleet.VmMachine): String {
    val parts = listOfNotNull(m.cpus?.let { "$it vCPU${if (it == 1) "" else "s"}" }, m.memory?.let { XoPolicy.gib(it) })
    return if (parts.isEmpty()) "Not reported" else parts.joinToString(", ")
}

private fun canExtend(m: Fleet.VmMachine): Boolean {
    val made = m.madeAt ?: return false
    val until = m.until ?: return false
    return until < made + Fleet.VmMachine.MAX_MINUTES * 60_000L
}

/** Xen Orchestra's power state in this app's words; null is cannot tell. The same as iOS. */
fun vmStateWords(state: String?): String = when (state) {
    "Running" -> "running"
    "Halted" -> "stopped"
    "Suspended" -> "suspended"
    "Paused" -> "paused"
    null -> "cannot tell"
    else -> state.lowercase()
}
