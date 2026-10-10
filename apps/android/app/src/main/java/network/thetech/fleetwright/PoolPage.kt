package network.thetech.fleetwright

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.snap
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

/**
 * A pool this phone holds a token for, managed from here: its pools, hosts,
 * VMs and storage, each the same kind of row, and each a way to its page.
 * docs/manage.md, "The first slice". iOS's PoolManageView, in the same order
 * and the same words.
 *
 * WHERE IT IS. Machines → Hypervisors → the pool. That row was already the
 * pool's way in (it opened the policy), and a pool is a machine of a kind:
 * putting what is on it under the same tab, as one more page under the row
 * that names it, reads as part of Machines rather than as an app of its own.
 * Changing what the fleet may use is a row on this page now, for an admin,
 * beside what it governs.
 *
 * THE ROWS ARE THE MACHINES TAB'S CARDS: one shape (RHYTHM 1), the name at a
 * hostname's weight, the state word on the right in a tone that only agrees
 * with it, then what it is and the numbers behind how it is. No row wears a
 * ring: nothing here is asking anything.
 *
 * THE FIRST LINE SAYS HOW CURRENT IT IS: watching now while the socket is
 * open, and otherwise when it was last looked at (PoolWatch).
 *
 * MOTION: a section that gains or loses a row settles to its new height on
 * the spring, and a state word that changes crossfades, which is all that
 * moves (MOTION 2). Under reduced motion the height simply changes.
 */
@Composable
internal fun PoolPage(settings: Settings, pool: XoHandoff.Held, admin: Boolean?, onChangePolicy: () -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val watch = remember(pool.address) { PoolWatch(settings, pool.address, scope) }
    var showing by remember { mutableStateOf<String?>(null) }
    val reduced = Design.Motion.reduced()

    LaunchedEffect(watch) { watch.start() }
    // THE APP STOPPING IS THE SOCKET CLOSING, said as such, rather than a
    // connection the system cuts later and the screen reports as lost.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, watch) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) watch.stop()
            if (event == Lifecycle.Event.ON_START) scope.launch { watch.start() }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            watch.stop()
        }
    }

    // THE ROUTERS, every half minute while the page is open: the machine
    // reading them does so on the same beat. Null until the fleet was asked.
    var edges by remember { mutableStateOf<Fleet.VmEdges?>(null) }
    var edgesAsked by remember { mutableStateOf(false) }
    var edgesFailed by remember { mutableStateOf(false) }
    var edgesKnown by remember { mutableStateOf(true) }
    LaunchedEffect(pool.address) {
        while (true) {
            Fleet(settings).vmEdges()
                .onSuccess { all ->
                    edgesKnown = all != null
                    edges = all?.firstOrNull { it.address == pool.address }
                    edgesFailed = false
                }
                .onFailure { edgesFailed = true }
            edgesAsked = true
            kotlinx.coroutines.delay(30_000)
        }
    }

    FullScreen(pool.address, onDismiss) {
        StatusCard(watch)
        if (edgesAsked && edgesKnown) EdgeCard(edges, edgesFailed)
        if (watch.phase == PoolWatch.Phase.Live && watch.snapshot.isEmpty) Hint(Manage.Words.seesNothing)
        for (kind in Manage.Kind.values()) {
            val rows = watch.snapshot.list(kind)
            // A heading over nothing promises what the pool does not have.
            if (rows.isNotEmpty()) {
                SectionHead(Manage.Words.heading(kind))
                Column(
                    Modifier.animateContentSize(animationSpec = Design.Motion.settle<IntSize>(reduced) ?: snap()),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    rows.forEach { c -> ComponentRow(c, watch.snapshot) { showing = c.id } }
                }
            }
        }
        // AN ADMIN'S, as it was on Machines: changing the policy takes an
        // admin sign-in and the verb refuses a member.
        if (admin == true) {
            Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                OpenRow(Manage.Words.changePolicy) { onChangePolicy() }
            }
        }
    }
    showing?.let { id -> ComponentPage(watch, id, onDismiss = { showing = null }) }
}

@Composable
private fun StatusCard(watch: PoolWatch) {
    val scope = rememberCoroutineScope()
    val phase = watch.phase
    val line = when (phase) {
        PoolWatch.Phase.Live -> watch.currentLine
        PoolWatch.Phase.Connecting -> Manage.Words.connecting(watch.address)
        PoolWatch.Phase.Relaying -> Manage.Words.askingFleet(watch.address)
        is PoolWatch.Phase.Stopped -> phase.why
        PoolWatch.Phase.Idle -> watch.lookedLine
    }
    // A stop is the one state here that wants something of the person.
    val tone = if (phase is PoolWatch.Phase.Stopped) Design.Palette.attention.now else Design.Palette.ink.now
    // Only where looking again could change the answer (C-2).
    val canLookAgain = phase == PoolWatch.Phase.Idle || (phase is PoolWatch.Phase.Stopped && phase.retry)
    Column(
        Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        AnimatedContent(
            targetState = line,
            transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
            label = "pool status",
        ) { words ->
            Text(words, style = Design.Style.body, color = tone)
        }
        if (phase is PoolWatch.Phase.Stopped) Text(watch.lookedLine, style = Design.Style.label, color = Design.Palette.inkDim.now)
        watch.user?.let { Text(Manage.Words.limitedUser(it), style = Design.Style.label, color = Design.Palette.inkDim.now) }
        if (canLookAgain) {
            OutlinedButton(onClick = { scope.launch { watch.start() } }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(Manage.Words.lookAgain)
            }
        }
    }
}

/** How the pool's edge routers are, as the machine reading them last did. */
@Composable
private fun EdgeCard(e: Fleet.VmEdges?, failed: Boolean) {
    Column(
        Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Text(Manage.Words.edgeHeading, style = Design.Style.section, color = Design.Palette.ink.now, modifier = Modifier.semantics { heading() })
        if (e == null) {
            Text(if (failed) Manage.Words.edgeUnasked else Manage.Words.edgeNobody, style = Design.Style.label, color = Design.Palette.inkDim.now)
        } else {
            EdgeReport(e)
        }
    }
}

/** What the machine read: when, each router, and what they logged lately. */
@Composable
private fun EdgeReport(e: Fleet.VmEdges) {
    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        Text(Manage.Words.edgeRead(e.hostId, relative(e.at).toString()), style = Design.Style.label, color = Design.Palette.inkDim.now)
        e.routers.forEach { r -> RouterRows(r) }
        if (e.events.isNotEmpty()) {
            Text(Manage.Words.edgeEvents, style = Design.Style.label, color = Design.Palette.inkDim.now)
            // Newest first, eight of them: what changed last is read first.
            val fmt = java.text.DateFormat.getTimeInstance(java.text.DateFormat.MEDIUM)
            e.events.takeLast(8).reversed().forEach { ev ->
                Text(
                    "${fmt.format(java.util.Date(ev.at))}  ${ev.router}  ${ev.text}",
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = if (ev.kind == "carp") Design.Palette.ink.now else Design.Palette.inkDim.now,
                )
            }
        }
    }
}

/** One router: its name, then each thing known of it. What is wrong is the one thing in the attention tone. */
@Composable
private fun RouterRows(r: Fleet.VmEdges.Router) {
    Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
        Text(r.name, style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
        val problem = r.problem
        when {
            r.reached == false && problem != null -> Text(Manage.Words.edgeUnreached(problem), style = Design.Style.label, color = Design.Palette.attention.now)
            r.reached == null && problem != null -> Text(problem, style = Design.Style.label, color = Design.Palette.inkDim.now)
            else -> {
                Manage.Words.edgeRole(r.role)?.let { Text(it, style = Design.Style.label, color = Design.Palette.ink.now) }
                Text(Manage.Words.edgeDns(r.dns), style = Design.Style.label, color = if (r.dns == false) Design.Palette.attention.now else Design.Palette.ink.now)
                Text(Manage.Words.edgeGateway(r.gateway), style = Design.Style.label, color = if (r.gateway == false) Design.Palette.attention.now else Design.Palette.ink.now)
                r.leases?.let { Text(Manage.Words.edgeLeases(it), style = Design.Style.label, color = Design.Palette.inkDim.now) }
            }
        }
        Text(Manage.Words.edgeHeard(r.heardAt?.let { relative(it).toString() }), style = Design.Style.micro, color = Design.Palette.inkDim.now)
    }
}

/** One component, as every row on this page is: the same shape whatever it is. */
@Composable
private fun ComponentRow(c: Manage.Component, s: Manage.Snapshot, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall)
            .clickable(onClickLabel = "Opens its page", role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(c.name, style = Design.Style.bodyStrong, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
            Manage.stateWords(c)?.let { word -> StateWord(word, c.state) }
        }
        Text(Manage.what(c, s), style = Design.Style.label, color = Design.Palette.inkDim.now)
        Text(Manage.numbers(c, s), style = Design.Style.micro, color = Design.Palette.inkDim.now)
    }
}

/** A state word that crossfades when it changes: news, so it moves, and nothing else about it does. */
@Composable
private fun StateWord(word: String, state: Manage.State?) {
    val tone = manageTone(state)
    AnimatedContent(
        targetState = word,
        transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
        label = "state word",
    ) { w ->
        Text(w, style = Design.Style.label, color = tone)
    }
}

/**
 * The tone a state word is set in. It agrees with the word and never carries
 * it: running is well, maintenance mode is something somebody chose and
 * should not forget, stopped is quiet, and not knowing is its own colour. Not
 * `idle` for stopped: as text on a card it does not clear AA.
 */
@Composable
internal fun manageTone(state: Manage.State?): Color = when (state) {
    Manage.State.RUNNING -> Design.Palette.ok.now
    Manage.State.MAINTENANCE -> Design.Palette.attention.now
    null -> Design.Palette.unsure.now
    Manage.State.STOPPED, Manage.State.SUSPENDED, Manage.State.PAUSED -> Design.Palette.inkDim.now
}

/** What is waiting on a yes. */
private class Asking(val title: String, val name: String, val button: String, val run: Run)

private sealed interface Run {
    class Act(val action: Manage.Action) : Run
    class Resize(val cpus: Int, val memoryGib: Int) : Run
    class Grow(val disk: Manage.Disk, val toGib: Int) : Run
}

/**
 * One component's page: what it is, how it is, and what it can do, in that
 * order, the same three parts every row has. What it can do is what the
 * server lists (C-2), in the order Manage.offered gives, and each is
 * confirmed by what it costs to undo: one tap, a question naming what it
 * interrupts, or the name typed back.
 */
@Composable
private fun ComponentPage(watch: PoolWatch, id: String, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<Asking?>(null) }
    var typing by remember { mutableStateOf<Asking?>(null) }
    var cpus by remember(id) { mutableStateOf(1) }
    var memoryGib by remember(id) { mutableStateOf(1) }
    var sized by remember(id) { mutableStateOf(false) }
    // What each disk is to grow to, by its id, once a person has moved it.
    val growTo = remember(id) { mutableStateMapOf<String, Int>() }
    val c = watch.snapshot.components[id]

    // The size controls start from what the VM has, once.
    LaunchedEffect(id, c != null) {
        if (!sized && c != null) {
            c.cpus?.let { cpus = maxOf(1, it) }
            c.memory?.let { memoryGib = maxOf(1, Math.round(it.toDouble() / Manage.GIB).toInt()) }
            sized = true
        }
    }

    fun perform(run: Run) {
        val now = watch.snapshot.components[id] ?: return
        scope.launch {
            busy = true
            message = ""
            val (ok, text) = when (run) {
                is Run.Act -> watch.run(run.action.method, Manage.params(run.action, now, System.currentTimeMillis()), Manage.done(run.action, now))
                is Run.Resize -> watch.run("vm.set", Manage.resizeParams(now, run.cpus, run.memoryGib), Manage.resized(now, run.cpus, run.memoryGib))
                is Run.Grow -> {
                    val method = Manage.growMethod(now, watch.methods)
                    if (method == null) false to Manage.Words.nothingOffered
                    else watch.run(method, Manage.growParams(run.disk, run.toGib), Manage.grown(run.disk, run.toGib))
                }
            }
            failed = !ok
            message = text
            busy = false
        }
    }

    /** One tap, a question, or the name typed back, by what it costs. */
    fun tap(a: Manage.Action, on: Manage.Component) {
        when (val ask = Manage.confirmation(a, on, watch.snapshot)) {
            Manage.Confirmation.None -> perform(Run.Act(a))
            is Manage.Confirmation.Ask -> asking = Asking(ask.title, on.name, ask.button, Run.Act(a))
            is Manage.Confirmation.TypeName -> typing = Asking(ask.title, ask.name, ask.button, Run.Act(a))
        }
    }

    FullScreen(c?.name ?: "", onDismiss) {
        if (c == null) {
            Hint(Manage.Words.gone)
            return@FullScreen
        }
        val s = watch.snapshot

        SectionHead(Manage.Words.whatItIs)
        Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
            Fact("Kind", Manage.Words.kindTitle(c.kind))
            Fact("Where", Manage.what(c, s))
            if (c.kind == Manage.Kind.VM || c.kind == Manage.Kind.HOST) Fact("Address", c.address ?: "cannot tell")
        }

        SectionHead(Manage.Words.howItIs)
        Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
            Manage.stateWords(c)?.let { Fact("State", it, manageTone(c.state)) }
            Text(
                Manage.numbers(c, s),
                style = Design.Style.label,
                color = Design.Palette.ink.now,
                modifier = Modifier.heightIn(min = 48.dp).padding(vertical = Design.Space.inside),
            )
            if (c.kind == Manage.Kind.VM) s.attachedDisks(c.id).forEach { d -> Fact(d.name, Manage.diskLine(d, s)) }
        }
        Hint(watch.currentLine)

        SectionHead(Manage.Words.whatItCanDo)
        val methods = watch.methods
        val offered = Manage.offered(c, methods)
        val resize = Manage.canResize(c, methods)
        val needsStopped = Manage.resizeNeedsStopped(c, methods)
        val grow = Manage.growMethod(c, methods)
        val disks = if (grow == null) emptyList() else s.attachedDisks(c.id).filter { it.size != null }
        when {
            watch.phase != PoolWatch.Phase.Live -> Hint(Manage.Words.lost("this phone is not connected"))
            methods == null -> Hint(Manage.Words.methodsUnknown)
            offered.isEmpty() && !resize && !needsStopped && disks.isEmpty() -> Hint(Manage.Words.nothingOffered)
            else -> {
                offered.forEach { a ->
                    OutlinedButton(onClick = { tap(a, c) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(a.label, color = if (a.cost == Manage.Cost.DESTRUCTIVE) Design.Palette.bad.now else Design.Palette.accent.now)
                    }
                }
                if (resize) {
                    // One tap: a size can be set back.
                    Counter("$cpus vCPU${if (cpus == 1) "" else "s"}", !busy, cpus > 1, cpus < 64, { cpus-- }, { cpus++ })
                    Counter("$memoryGib GiB of memory", !busy, memoryGib > 1, memoryGib < 512, { memoryGib-- }, { memoryGib++ })
                    OutlinedButton(
                        onClick = { perform(Run.Resize(cpus, memoryGib)) },
                        enabled = !busy && !(cpus == c.cpus && memoryGib.toLong() * Manage.GIB == c.memory),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(Manage.Words.resizeButton(cpus, memoryGib)) }
                } else if (needsStopped) {
                    Hint(Manage.Words.tuneNeedsStopped)
                }
                // A disk is never shrunk here, so each starts one GiB above itself.
                disks.forEach { d ->
                    val least = (((d.size ?: 0L) + Manage.GIB - 1) / Manage.GIB).toInt() + 1
                    val to = maxOf(growTo[d.id] ?: least, least)
                    Counter("${d.name}: $to GiB", !busy, to > least, to < 16_384, { growTo[d.id] = to - 1 }, { growTo[d.id] = to + 1 })
                    OutlinedButton(
                        onClick = {
                            val ask = Manage.growConfirmation(d, to)
                            if (ask is Manage.Confirmation.Ask) asking = Asking(ask.title, d.name, ask.button, Run.Grow(d, to))
                        },
                        enabled = !busy,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(Manage.Words.growButton(d.name, to)) }
                }
            }
        }
        if (message.isNotBlank()) Hint(message, if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        if (offered.isNotEmpty() || resize || disks.isNotEmpty()) {
            Hint(if (disks.isEmpty()) Manage.Words.actionsFooter else "${Manage.Words.actionsFooter} ${Manage.Words.growNote}")
        }
    }

    asking?.let { ask ->
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text(ask.title) },
            confirmButton = {
                TextButton(onClick = { asking = null; perform(ask.run) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(ask.button, color = Design.Palette.accent.now)
                }
            },
            dismissButton = { TextButton(onClick = { asking = null }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } },
        )
    }
    typing?.let { ask -> TypedConfirm(ask, onConfirm = { perform(ask.run) }, onDismiss = { typing = null }) }
}

/**
 * A destructive action, asked as its name typed back: forcing a VM off or to
 * restart, or deleting one. In a list of many VMs the wrong one is the mistake
 * worth preventing, and typing the name is what makes it impossible. The
 * button stays off until the name matches.
 */
@Composable
private fun TypedConfirm(ask: Asking, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    var typed by remember(ask) { mutableStateOf("") }
    val matches = typed.trim() == ask.name
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(ask.title) },
        text = {
            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it },
                singleLine = true,
                label = { Text(Manage.Words.typePrompt(ask.name)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onConfirm() }, enabled = matches, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(ask.button, color = if (matches) Design.Palette.bad.now else Design.Palette.inkDim.now)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } },
    )
}

@Composable
private fun Fact(label: String, value: String, tone: Color = Design.Palette.ink.now) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = Design.Style.label, color = Design.Palette.inkDim.now, modifier = Modifier.weight(1f))
        Text(value, style = Design.Style.label, color = tone, textAlign = TextAlign.End, modifier = Modifier.weight(2f))
    }
}

/** A number with a less and a more, each 48dp. */
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
