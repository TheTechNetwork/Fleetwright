package network.thetech.fleetwright

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
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
 *
 * WHAT IT DID ON THE NETWORK is the hypervisor's count at its interfaces,
 * which a session on the machine cannot change: how much, not where to.
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

                SectionHead("On the network")
                val net = m.net
                if (net != null && net.rx.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                        TrafficChart(net, Modifier.padding(top = Design.Space.inside).fillMaxWidth().height(56.dp))
                        Text(
                            "Received is the solid line, sent the dashed one.",
                            style = Design.Style.micro,
                            color = Design.Palette.inkDim.now,
                            modifier = Modifier.padding(top = Design.Space.insideTight),
                        )
                        Fact("Now", nowWords(net))
                        Fact("Last ${net.minutes} minutes", totalWords(net))
                    }
                } else {
                    Hint(noTrafficWords(m))
                }
                Hint(
                    "As the hypervisor counted it at this machine’s network interfaces, which nothing running on the machine can change. " +
                        "It is how much went in and out, not where it went.",
                )

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

/**
 * A machine's traffic as two lines on one scale: received solid, sent dashed,
 * so the two never rest on colour alone. A sample nobody counted breaks the
 * line rather than drawing it to zero. The palette's chart ramp, chart5 and
 * chart4, both clear 3:1 against the card in either theme. The same as iOS.
 */
@Composable
private fun TrafficChart(net: Fleet.VmMachine.Traffic, modifier: Modifier) {
    val received = Design.Palette.chart5.now
    val sent = Design.Palette.chart4.now
    fun most(points: List<Double?>) = points.filterNotNull().maxOrNull()?.let { rateText(it) } ?: "nothing counted"
    val summary = "Over the last ${net.minutes} minutes, received at most ${most(net.rx)}, sent at most ${most(net.tx)}."
    Canvas(modifier.semantics { contentDescription = summary }) {
        val top = maxOf(1.0, (net.rx + net.tx).filterNotNull().maxOrNull() ?: 1.0)
        fun line(points: List<Double?>): Path = Path().apply {
            val step = if (points.size > 1) size.width / (points.size - 1) else 0f
            var drawing = false
            points.forEachIndexed { i, v ->
                if (v == null) {
                    drawing = false
                    return@forEachIndexed
                }
                val at = Offset(i * step, size.height * (1 - (v / top).toFloat()))
                if (drawing) lineTo(at.x, at.y) else moveTo(at.x, at.y)
                drawing = true
            }
        }
        drawPath(
            line(net.tx), sent,
            style = Stroke(
                width = 1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
            ),
        )
        drawPath(line(net.rx), received, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

private fun nowWords(net: Fleet.VmMachine.Traffic): String {
    val rx = net.rx.lastOrNull() ?: return "Not counted in the last minute"
    val tx = net.tx.lastOrNull() ?: return "Not counted in the last minute"
    return "${rateText(rx)} in, ${rateText(tx)} out"
}

private fun totalWords(net: Fleet.VmMachine.Traffic): String {
    val total = "${bytesText(net.received)} in, ${bytesText(net.sent)} out"
    if (net.gaps == 0) return total
    val gap = Math.round(net.gaps * net.interval / 60).toInt()
    return "$total, with $gap minute${if (gap == 1) "" else "s"} not counted"
}

/**
 * Nothing reported is said for what it is: a stopped machine sends nothing,
 * a running one the pool did not answer for is cannot tell.
 */
private fun noTrafficWords(m: Fleet.VmMachine): String = when (m.state) {
    "Running" -> "The pool has not said what it sent and received. The box holding it asks each time it looks."
    null -> "Cannot tell."
    else -> "It is not running, so there is nothing to count."
}

/**
 * Bytes, the way a person reads them, in powers of a thousand as iOS's
 * ByteCountFormatter writes them: 0 bytes, 12 KB, 4.2 MB.
 */
fun bytesText(bytes: Double): String {
    val b = Math.round(bytes)
    if (b < 1000) return "$b byte${if (b == 1L) "" else "s"}"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = b / 1000.0
    var i = 0
    while (v >= 999.95 && i < units.size - 1) {
        v /= 1000
        i++
    }
    val n = if (i == 0) Math.round(v).toString() else String.format(java.util.Locale.ROOT, "%.1f", v).removeSuffix(".0")
    return "$n ${units[i]}"
}

/** A rate, the same way: 12 KB/s. */
fun rateText(perSecond: Double): String = "${bytesText(perSecond)}/s"

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
