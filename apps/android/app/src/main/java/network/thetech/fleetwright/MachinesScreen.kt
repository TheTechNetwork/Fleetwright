package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.InputChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * The Machines tab: every machine in the fleet, one card each, and a way to
 * add one.
 *
 * WHAT THIS SCREEN IS FOR. Somebody opens it because a machine might be
 * unwell, often at night, often from a notification. On this phone that meant
 * Settings, a panel in place of the session list, scrolled past the build
 * number, the coordinator URL, Siri, People and You to a card carrying six
 * buttons, channel chips and an inline reboot form, with the same machines
 * listed again under Hosts and again under the vault's Boxes. Now the list is
 * the whole screen, every card is facts only and the same shape (RHYTHM 1),
 * and everything you can do about a machine is on its page.
 *
 * @param opening a machine somebody asked to see from elsewhere: a
 *   notification about it, or the reassurance line naming it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(
    settings: Settings,
    admin: Boolean?,
    /** Keyed on, so switching view re-asks the fleet as the other person. */
    viewAsMember: Boolean,
    opening: String?,
    onOpened: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val reduced = Design.Motion.reduced()
    var fleetHosts by remember { mutableStateOf(listOf<Fleet.FleetHost>()) }
    var hosts by remember { mutableStateOf(listOf<Fleet.Host>()) }
    // HAS THE FIRST ANSWER ARRIVED? "No machines yet" before the fleet has
    // replied is a confident statement about a question nobody has asked.
    var loaded by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var showing by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }

    suspend fun loadHosts() {
        if (!settings.configured) return
        // TWO ANSWERS, ONE WAIT. Enrolled is the membership (keys,
        // revocation); reporting is what each machine is saying now.
        coroutineScope {
            val reporting = async { runCatching { Fleet(settings).fleetHosts() } }
            val members = async { runCatching { Fleet(settings).enrolledHosts() } }
            // A FAILED REQUEST IS NOT AN EMPTY FLEET: keep what was there.
            reporting.await().onSuccess { fleetHosts = it }
            members.await().onSuccess { hosts = it }
        }
        loaded = true
    }

    LaunchedEffect(settings.configured, viewAsMember) { loadHosts() }
    // Push the page asked for, once this list knows the machine.
    LaunchedEffect(opening, loaded, fleetHosts, hosts) {
        val wanted = opening ?: return@LaunchedEffect
        if (fleetHosts.any { it.hostId == wanted } || hosts.any { it.hostId == wanted }) {
            showing = wanted
            onOpened()
        } else if (loaded) {
            onOpened()
        }
    }

    showing?.let { id ->
        MachinePage(
            settings = settings,
            hostId = id,
            reporting = fleetHosts.firstOrNull { it.hostId == id },
            member = hosts.firstOrNull { it.hostId == id },
            admin = admin,
            onDismiss = { showing = null },
            onChanged = { scope.launch { loadHosts() } },
        )
    }
    if (adding) AddMachineSheet(settings, onDismiss = { adding = false })

    // Enrolled, and not saying anything: membership with no report.
    val silent = hosts.filter { h -> fleetHosts.none { it.hostId == h.hostId } }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                loadHosts()
                refreshing = false
            }
        },
        modifier = modifier,
    ) {
        LazyColumn(
            Modifier.padding(horizontal = Design.Space.page),
            verticalArrangement = Arrangement.spacedBy(Design.Space.groupTight),
        ) {
            item { Spacer(Modifier.heightIn(min = Design.Space.hair)) }
            when {
                !settings.configured -> item {
                    Hint("Sign in to a fleet under You, and its machines are listed here.")
                }
                !loaded -> item { Hint("Asking the fleet…") }
                fleetHosts.isEmpty() && hosts.isEmpty() -> item {
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        Text("No machines yet", style = Design.Style.section, color = Design.Palette.ink.now)
                        Hint("A machine joins with a pin from Add a machine and one line typed on it.")
                    }
                }
            }
            // A machine that stops reporting moves to the silent cards below,
            // and one that joins arrives, rather than the list becoming another.
            items(fleetHosts, key = { it.hostId }) { host ->
                Box(Modifier.animateItem(fadeInSpec = Design.Motion.change(), placementSpec = Design.Motion.settle(reduced), fadeOutSpec = Design.Motion.change())) {
                    MachineCard(host = host, onClick = { showing = host.hostId })
                }
            }
            // THE MACHINES THAT ARE NOT SAYING ANYTHING, in the same list. A box
            // that has gone quiet is still enrolled and still holds a key, which
            // is what a reinstalled box is refused for — so it needs its page.
            items(silent, key = { "silent/" + it.hostId }) { host ->
                Box(Modifier.animateItem(fadeInSpec = Design.Motion.change(), placementSpec = Design.Motion.settle(reduced), fadeOutSpec = Design.Motion.change())) {
                    SilentCard(host = host, onClick = { showing = host.hostId })
                }
            }
            if (settings.configured) {
                // ONE ROW, AFTER THE LIST. Adding a machine is something done
                // once per machine; the list is read every time.
                item {
                    Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall).padding(horizontal = Design.Space.groupTight)) {
                        OpenRow("Add a machine") { adding = true }
                    }
                }
            }
            item { Spacer(Modifier.heightIn(min = Design.Space.group)) }
        }
    }
}

/**
 * One machine, facts only. The whole card is the way in: Role.Button and 48dp
 * at least, so TalkBack says it can be activated and a thumb can hit it.
 */
@Composable
private fun MachineCard(host: Fleet.FleetHost, onClick: () -> Unit) {
    // A machine that wants something wears the attention ring: not healthy, an
    // update waiting, or nobody able to start a session on it.
    val wants = host.state != "healthy" || host.appPending || host.claudeAccounts == 0
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = if (wants) Design.Palette.attention.now else Design.Palette.ring.now)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(host.hostId, style = Design.Style.bodyStrong, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
            Text("  ›", style = Design.Style.bodyStrong, color = Design.Palette.inkDim.now)
            Spacer(Modifier.weight(1f))
            // Colour reinforces the word; it never carries the meaning alone.
            Text(
                host.state ?: "unknown",
                style = Design.Style.label,
                color = if (host.state == "healthy") Design.Palette.ok.now else Design.Palette.attention.now,
            )
        }
        // ONLY WHEN IT IS NEWS. "reporting normally" under "healthy" is the
        // same fact twice.
        host.reason?.takeIf { it.isNotBlank() && host.state != "healthy" }?.let {
            Text(it, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
        HealthLines(host)
    }
}

/** An enrolled machine that is not reporting, in the same shape. */
@Composable
private fun SilentCard(host: Fleet.Host, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = Design.Palette.attention.now)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(host.hostId, style = Design.Style.bodyStrong, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
            Text("  ›", style = Design.Style.bodyStrong, color = Design.Palette.inkDim.now)
            Spacer(Modifier.weight(1f))
            Text(if (host.revoked) "revoked" else "not reporting", style = Design.Style.label, color = Design.Palette.attention.now)
        }
        // "never connected" is a box that enrolled and never came up; "last
        // seen" is one that went away, a reinstall usually.
        Text(
            host.lastSeenAt?.let { "last seen " + relative(it) } ?: "never connected",
            style = Design.Style.label,
            color = Design.Palette.inkDim.now,
        )
    }
}

/** What this box says about itself, as lines. Shared by the card and the page. */
@Composable
private fun HealthLines(host: Fleet.FleetHost) {
    // WHO CAN START A SESSION HERE, AND AS WHOM. Zero is the real fault and the
    // only thing worth colouring; null is an older host and says nothing.
    host.claudeAccounts?.let { accounts ->
        Text(
            describeWhoCanStart(accounts, host),
            style = Design.Style.micro,
            color = if (accounts == 0) Design.Palette.attention.now else Design.Palette.inkDim.now,
        )
    }
    // THE SECOND WAY TO BE SIGNED OUT: the credential file a session is
    // actually handed. Shown only when it is DEAD.
    host.credential?.takeIf { it.isDead }?.let { credential ->
        Text(
            credential.summary ?: "Sessions started here will come up signed out.",
            style = Design.Style.micro,
            color = Design.Palette.bad.now,
        )
    }
    Text(
        describeRunning(host),
        style = Design.Style.micro,
        color = if (host.appPending) Design.Palette.attention.now else Design.Palette.inkDim.now,
    )
    host.systemUpdates?.let {
        Text("OS: $it", style = Design.Style.micro, color = Design.Palette.attention.now)
    }
    // A PACKAGED BOX'S ANSWER: the host's own sentence, verbatim.
    host.release?.message?.let { message ->
        Text(
            message,
            style = Design.Style.micro,
            color = if (host.release.available != null || !host.release.configured) Design.Palette.attention.now
            else Design.Palette.inkDim.now,
        )
    }
    if (host.rebootRequired) {
        Text("reboot required", style = Design.Style.micro, color = Design.Palette.attention.now)
    }
}

/**
 * One machine, everything about it, on a page of its own.
 *
 * WHY THIS EXISTS. Android split a machine three ways: Check, Apply, Upgrade,
 * Reboot, Credentials, Settings and the channel chips on its card in the
 * settings panel; image, labels, house rules and logs in a dialog behind the
 * card's "Settings" button; and Revoke, Readmit and Replace key on a second
 * card for the same machine further down. This is iOS's HostView, in the same
 * order: what is wrong first, then its logs, then what can be done, then how
 * it is set up, and the dangerous things last.
 */
@Composable
private fun MachinePage(
    settings: Settings,
    hostId: String,
    reporting: Fleet.FleetHost?,
    member: Fleet.Host?,
    admin: Boolean?,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    // SEEDED FROM WHAT THE LIST ALREADY HAS, and moved by what each action
    // answers: a page that opened blank to ask a question it was handed the
    // answer to is the fault the fleet screen was rebuilt for.
    var host by remember(hostId) { mutableStateOf(reporting) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var variant by remember(hostId) { mutableStateOf(reporting?.sandboxVariant) }
    var pinned by remember(hostId) { mutableStateOf(reporting?.sandboxPinned ?: false) }
    var labels by remember(hostId) { mutableStateOf(reporting?.labels ?: emptyList()) }
    var setLabels by remember(hostId) { mutableStateOf(reporting?.setLabels ?: emptyList()) }
    var newLabel by remember { mutableStateOf("") }
    var claudeOpen by remember { mutableStateOf(false) }
    var rebooting by remember { mutableStateOf(false) }
    var rebootPin by remember { mutableStateOf("") }
    var rebootConfirm by remember { mutableStateOf("") }
    var confirmingRevoke by remember { mutableStateOf(false) }
    var pin by remember { mutableStateOf("") }

    /** Re-read this machine from the fleet. A failure keeps what was there. */
    suspend fun reload() {
        runCatching { Fleet(settings).fleetHosts() }.getOrNull()
            ?.firstOrNull { it.hostId == hostId }
            ?.let { now ->
                host = now
                now.sandboxVariant?.let { variant = it; pinned = now.sandboxPinned }
                labels = now.labels
                setLabels = now.setLabels
            }
    }

    /** One action, one place the busy flag and the answer are set. */
    fun run(work: suspend (Fleet) -> Fleet.Reply) {
        scope.launch {
            busy = true
            val r = try {
                work(Fleet(settings))
            } catch (e: Exception) {
                result = e.message ?: "that did not work"
                null
            }
            // EVERYTHING ELSE THIS MACHINE SAYS, re-read once the action has
            // landed: the reply is authoritative about what it changed and
            // silent about the rest.
            reload()
            if (r != null) {
                result = r.text.said()
                // BELIEVE THE REPLY, AFTER the refresh rather than before it —
                // the refresh is what would otherwise overwrite it. The host
                // pushes a health frame after a mutating verb, and the fleet's
                // snapshot races it; losing that race shows the value somebody
                // just changed away from.
                r.sandboxVariant?.let { variant = it; pinned = r.sandboxPinned }
                r.setLabels?.let { set ->
                    val derived = labels.filter { it !in setLabels }
                    labels = (derived + set).distinct().sorted()
                    setLabels = set.sorted()
                }
                r.channel?.let { now -> host = host?.let { it.copy(channel = now, channelPinned = r.channelPinned) } }
                r.waiting?.let { w -> host = host?.let { withWaiting(it, w) } }
            }
            busy = false
            onChanged()
        }
    }

    fun addLabel() {
        val wanted = newLabel.trim()
        if (wanted.isEmpty()) return
        // CLEARED THE MOMENT IT LEAVES, whether or not it worked.
        newLabel = ""
        run { it.labels(hostId, add = wanted) }
    }

    if (claudeOpen) {
        CredentialsSheet(settings, hostId, onDismiss = { claudeOpen = false }, onlyClaude = true)
    }
    if (confirmingRevoke) {
        AlertDialog(
            onDismissRequest = { confirmingRevoke = false },
            title = { Text("Revoke $hostId?") },
            text = {
                Text(
                    "It is disconnected immediately, and its sessions keep running without it. " +
                        "Getting it back means a new pin, typed on that box.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingRevoke = false
                    run { it.revokeHost(hostId) }
                }) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { confirmingRevoke = false }) { Text("Cancel") } },
        )
    }

    FullScreen(title = hostId, onDismiss = onDismiss) {
        val h = host
        // WHAT IT IS SAYING, FIRST.
        Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
            val state = h?.state ?: if (member?.revoked == true) "revoked" else "not reporting"
            Text(
                state,
                style = Design.Style.bodyStrong,
                color = if (state == "healthy") Design.Palette.ok.now else Design.Palette.attention.now,
            )
            val reason = h?.reason ?: if (member?.revoked == true) {
                "Its key was revoked. Readmit mints the pin that brings it back."
            } else {
                "Not connected to the fleet. Reinstalled? Replace key mints the pin its new key needs."
            }
            if (reason.isNotBlank() && state != "healthy") Hint(reason)
            if (h != null) HealthLines(h)
            // THE GAP, in the attention colour: the one line that says the box
            // is not running what it holds. Same sentence as iOS, held equal by
            // test/restart-waiting.test.js.
            h?.restartWaitingFor?.let { waiting ->
                Hint("$waiting is on this box and not yet running. A restart applies it.", color = Design.Palette.attention.now)
            }
            // ROOT'S HALF, in the same colour and for the same reason. What
            // still works comes first, so it reads as one command and not a
            // broken box. Same sentence as iOS.
            if (h?.rootHalfBehind == true) {
                Hint(
                    "The update helper on this box is older than the release it runs. Updates still land and the services restart, " +
                        "but nothing root owns is refreshed. Check shows the one command that fixes it, once.",
                    color = Design.Palette.attention.now,
                )
            }
        }

        if (h != null) {
            SectionHead("Software")
            // CHECK ALWAYS; APPLY ONLY WHEN THERE IS SOMETHING TO APPLY.
            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                OutlinedButton(enabled = !busy, onClick = { run { it.updates(hostId) } }) { Text("Check") }
                if (h.appPending) {
                    OutlinedButton(enabled = !busy, onClick = { run { it.update(hostId, restart = true) } }) { Text("Apply update") }
                }
            }
            // ONLY WHERE IT WOULD WORK. Null is cannot tell (an older host) and
            // keeps the button; the box's own refusal explains.
            if (h.systemPending && h.grantUpgrades != false) {
                OutlinedButton(enabled = !busy, onClick = { run { it.upgrade(hostId, apply = true) } }) { Text("Apply upgrade") }
            }
            // WHAT THIS BOX ALLOWS FROM THE APP, said only when it is off: the
            // allowed case is the ordinary one and not news. Same words as iOS,
            // held equal by test/grants-in-apps.test.js.
            h.grantUpgrades?.let { allowed ->
                if (!allowed) {
                    Hint("System upgrades from the app: not allowed")
                    GrantOff("Turning it on is one line on the box:", grantLine("upgrades"))
                }
            }

            // WHAT IT LOGGED, near the top. At night the order somebody asks is
            // what is it saying, what did it write down, and what can I do.
            SectionHead("Logs")
            val logs = h.logs
            when {
                // NULL IS CANNOT TELL: this page has not been told which of the
                // three journals exist here.
                logs == null -> Hint("This host has not said which logs it can read.")
                logs.isEmpty() -> Hint("None of the services this app knows are installed here.")
                else -> logs.forEach { source ->
                    OutlinedButton(onClick = { run { it.logs(hostId, service = source) } }, enabled = !busy) { Text(logName(source)) }
                }
            }
            Hint("The last forty lines of a service's journal. A session's own output is under the session, as Output.")
        }

        if (result.isNotBlank()) Quoted(result)

        SectionHead("Identity")
        if (h != null) {
            OutlinedButton(onClick = { claudeOpen = true }) { Text("Sign in to Claude") }
        }
        member?.fingerprint?.takeIf { it.isNotBlank() }?.let { fp ->
            // NEXT TO THE MACHINE IT IDENTIFIES, to be compared with what the
            // box itself prints.
            Text("Key", style = Design.Style.label, color = Design.Palette.inkDim.now)
            SelectionContainer {
                Text(fp, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
            }
        }
        // MAY THIS BOX HOLD YOUR CREDENTIALS, beside the Key it is decided by.
        if (member != null && !member.revoked && !member.ephemeral) VaultApproval(settings, member)

        if (h != null) {
            // THE UPDATE CHANNEL. Null on a host that predates the verb, which
            // is NOT "stable": an app that guessed would label a box wrongly.
            h.channel?.let { current ->
                SectionHead("Releases")
                if (h.channelPinned) {
                    Hint("$current, set on the box")
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        listOf("stable" to "Stable", "rolling" to "Rolling").forEach { (value, label) ->
                            FilterChip(
                                selected = current == value,
                                enabled = !busy && current != value,
                                onClick = { run { it.channel(hostId, to = value) } },
                                label = { Text(label) },
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                        }
                    }
                }
                Hint("Stable takes published releases. Rolling takes the newest build of main, on every merge.")
            }

            SectionHead("Session image")
            val v = variant
            when {
                // NULL IS CANNOT TELL. A control defaulted to "no browser" would
                // tell somebody their box has no Chromium when it might.
                v == null -> Hint("This host has not said which image it runs sessions in.")
                pinned || (v != "minimal" && v != "browser") -> Text(
                    (if (pinned) "Set on the box: " else "Not one of ours: ") + h.sandboxImage.orEmpty(),
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.inkDim.now,
                )
                else -> Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    listOf("minimal" to "No browser", "browser" to "Browser").forEach { (value, label) ->
                        FilterChip(
                            selected = v == value,
                            enabled = !busy && v != value,
                            onClick = { run { it.sandbox(hostId, to = value) } },
                            label = { Text(label) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
            }
            Hint("The browser image is the same one with Chromium in it, for a session that has to look at a page it built. Running sessions keep the image they started in.")

            SectionHead("Labels")
            if (labels.isEmpty()) Hint("No labels, so only work that names this host can land here.")
            labels.forEach { label ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    // REMOVE APPEARS ON EXACTLY THE ONES IT WORKS FOR. The host
                    // refuses to drop a label the machine derives itself.
                    if (label in setLabels) {
                        InputChip(
                            selected = false,
                            enabled = !busy,
                            onClick = { run { it.labels(hostId, remove = label) } },
                            label = { Text(label) },
                            trailingIcon = { Text("✕", Modifier.semantics { contentDescription = "Remove $label" }) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    } else {
                        InputChip(selected = false, enabled = false, onClick = {}, label = { Text(label) })
                        Hint("from the machine")
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newLabel,
                    onValueChange = { newLabel = it },
                    label = { Text("Add a label") },
                    singleLine = true,
                    // A LABEL IS COMPARED FOR EQUALITY by the scheduler, so a
                    // capitalised one could never be matched.
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(Design.Space.insideTight))
                TextButton(onClick = { addLabel() }, enabled = !busy && newLabel.isNotBlank()) { Text("Add") }
            }
            Hint("Labels are how work is aimed: a session asked for with a tag lands on a host carrying it. The ones the machine works out about itself cannot be removed.")

            // WHAT THIS BOX PUTS INTO EVERY SESSION, and what it costs. NULL
            // DRAWS NOTHING: the normal case and an older host. Same words as
            // iOS, held equal by test/house-rules-shown.test.js.
            h.houseRules?.let { houseRules ->
                SectionHead("House rules")
                if (houseRules == 0) {
                    Hint("A rules file is on this box and is not being used. The box's /profiles says why.", color = Design.Palette.attention.now)
                } else {
                    Hint("Every new session here starts with $houseRules characters of house rules, read on every turn.")
                }
                Hint("One file on the box, written into each new session as its CLAUDE.md. Changing it needs a shell there, and reaches the next session rather than a running one.")
            }
        }

        SectionHead("This machine")
        if (h != null) {
            // NO BUTTON FOR A THING THE BOX REFUSES. Same words as iOS, held
            // equal by test/grants-in-apps.test.js.
            if (h.grantReboot == false) {
                GrantOff("Reboot from the app is off on this box.", grantLine("reboot"))
            } else if (!rebooting) {
                OutlinedButton(enabled = !busy, onClick = { rebooting = true; rebootPin = ""; rebootConfirm = "" }) {
                    Text("Reboot", color = Design.Palette.bad.now)
                }
            } else {
                // TWO STEPS, and the second asks for the hostname typed out. The
                // pin is issued by the BOX: a coordinator that could mint it
                // could reboot the fleet.
                Hint("Every session on this box dies — a reboot takes the tmux server with it.")
                OutlinedButton(enabled = !busy, onClick = { run { it.reboot(hostId) } }) { Text("Ask for a pin") }
                OutlinedTextField(
                    value = rebootPin,
                    onValueChange = { rebootPin = it },
                    singleLine = true,
                    label = { Text("Pin from the box") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = rebootConfirm,
                    onValueChange = { rebootConfirm = it },
                    singleLine = true,
                    label = { Text("Type $hostId to confirm") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(
                        enabled = rebootPin.isNotBlank() && rebootConfirm == hostId && !busy,
                        onClick = {
                            run { it.reboot(hostId, rebootPin, rebootConfirm) }
                            rebooting = false
                        },
                    ) { Text("Reboot", color = Design.Palette.bad.now) }
                    TextButton(onClick = { rebooting = false }) { Text("Cancel") }
                }
            }
        }
        if (member != null) {
            // AN ADMIN'S, AND DRAWN FOR AN ADMIN. The coordinator refuses it to
            // anybody else, and the refusal used to arrive after the dialog.
            if (!member.revoked && admin == true) {
                TextButton(enabled = !busy, onClick = { confirmingRevoke = true }) { Text("Revoke this host", color = Design.Palette.bad.now) }
            }
            // THE TWO CASES AN UNBOUND PIN IS REFUSED FOR, each with its own
            // pin bound to this machine.
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        pin = runCatching { Fleet(settings).mintHostPin(hostId = hostId, readmit = member.revoked) }
                            .map { it.code }
                            .getOrElse { result = it.message ?: "could not mint a pin"; "" }
                        busy = false
                    }
                },
            ) { Text(if (member.revoked) "Readmit" else "Replace key") }
            if (pin.isNotBlank()) {
                SelectionContainer {
                    Text(
                        if (pin.length == 6) "${pin.take(3)} ${pin.takeLast(3)}" else pin,
                        style = Design.Style.title,
                        fontFamily = FontFamily.Monospace,
                        color = Design.Palette.ink.now,
                    )
                }
                // NAMED, because a bound pin is refused anywhere else and the
                // refusal arrives on the box rather than here.
                Hint("for $hostId only — on that box: fleetwright-sidecar enrol $pin", color = Design.Palette.attention.now)
            }
        }
    }
}

/**
 * A machine as a check just found it. The reply is the freshest thing anybody
 * has about this box: it was computed a moment ago because somebody pressed a
 * button, while the snapshot is a cache the host refreshes every fifteen
 * minutes.
 */
private fun withWaiting(host: Fleet.FleetHost, w: Fleet.Waiting): Fleet.FleetHost = host.copy(
    behind = if (w.appKind == "checkout") w.appBehind else null,
    // `systemText` is a sentence either way — "No system packages are
    // waiting." is a fine answer and a bad value for a field whose emptiness
    // hides a button.
    systemUpdates = if (w.systemPending) w.systemText else null,
    release = if (w.appKind == "release") {
        // Only a host new enough to send `waiting` gets here, and those always
        // send `configured` beside it.
        Fleet.Release(available = w.appAvailable, configured = w.appConfigured ?: true, message = w.appText)
    } else {
        null
    },
    appPendingReported = w.appPending,
    // Carried over when the reply does not say: an older host's check must not
    // clear what its frame reported.
    grantUpgrades = w.grantUpgrades ?: host.grantUpgrades,
    grantReboot = w.grantReboot ?: host.grantReboot,
)

/**
 * Adding a machine, by the three routes there are. Setup a route depends on
 * lives under You, once.
 *
 * THE STANDALONE TEMPORARY MACHINE IS GONE. It started a machine with nothing
 * on it, which spent Actions minutes until the person came back to start a
 * session, and it explained itself in different words from New session's,
 * which does the same thing with the work already attached.
 */
@Composable
private fun AddMachineSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var ephemeralPin by remember { mutableStateOf(false) }
    var pin by remember { mutableStateOf("") }
    // THE ONE LINE THAT INSTALLS A BOX AND JOINS IT with the pin in hand, or
    // empty when this coordinator publishes no installer.
    var pinInstall by remember { mutableStateOf("") }
    var result by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var runnerRepo by remember { mutableStateOf<String?>(null) }
    var runnersAnswered by remember { mutableStateOf(false) }
    var showRunnerTokens by remember { mutableStateOf(false) }
    var showTemporary by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        // NULL INSIDE A SUCCESS IS THE ANSWER "no runner repository"; a failed
        // request leaves the section undrawn rather than claiming either.
        Fleet(settings).runners().onSuccess {
            runnerRepo = it
            runnersAnswered = true
        }
    }

    if (showRunnerTokens) RunnerTokensSheet(settings = settings, onDismiss = { showRunnerTokens = false })
    if (showTemporary) TemporaryMachinesSheet(settings, onDismiss = { showTemporary = false })

    FullScreen(title = "Add a machine", onDismiss = onDismiss) {
        SectionHead("A box you have")
        // TEMPORARY IS A PROPERTY OF THE PIN, not of the box.
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp)) {
            Switch(checked = ephemeralPin, onCheckedChange = { ephemeralPin = it }, enabled = !busy)
            Spacer(Modifier.width(Design.Space.insideTight))
            Text("Temporary host (CI runner)", style = Design.Style.body, color = Design.Palette.ink.now)
        }
        if (ephemeralPin) {
            Hint(
                "Retired the moment it disconnects, and its key revoked. Never chosen " +
                    "automatically for work — it has the most free capacity in the fleet " +
                    "precisely because it is about to disappear.",
            )
        }
        OutlinedButton(
            enabled = !busy,
            onClick = {
                scope.launch {
                    busy = true
                    pinInstall = ""
                    pin = runCatching { Fleet(settings).mintHostPin(ephemeralPin) }
                        .onSuccess { pinInstall = it.install ?: "" }
                        .map { it.code }
                        .getOrElse { result = it.message ?: "could not mint a pin"; "" }
                    busy = false
                }
            },
        ) { Text("Mint a pin for a new host") }
        if (pin.isNotBlank()) {
            // 123 456 — read down a phone, typed into a terminal.
            SelectionContainer {
                Text(
                    if (pin.length == 6) "${pin.take(3)} ${pin.takeLast(3)}" else pin,
                    style = Design.Style.title,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.ink.now,
                )
            }
            if (pinInstall.isNotBlank()) {
                // THE LINE IS THE PRODUCT. On a fresh box this is the whole join.
                Hint("On a fresh box, as root — installs it and joins it:")
                SelectionContainer {
                    Text(pinInstall, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                }
                Text(
                    "Already installed: fleetwright-sidecar enrol $pin\nGood for ten minutes, once.",
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.inkDim.now,
                )
            } else {
                Text(
                    "On that box: fleetwright-sidecar enrol $pin\nGood for ten minutes, once.",
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = Design.Palette.ink.now,
                )
            }
        }
        if (result.isNotBlank()) Hint(result, color = Design.Palette.bad.now)
        Hint("A pin is good for ten minutes, once. It needs a shell on the box to type it.")

        if (runnersAnswered) {
            SectionHead("A machine for a while")
            val repo = runnerRepo
            if (repo != null) {
                // SAID ONCE, IN THE WORDS NEW SESSION USES.
                Hint(
                    "Under New session, pick a new machine in Where. It comes from $repo, boots in a few minutes, " +
                        "and the session starts on it when it joins.",
                    color = Design.Palette.ink.now,
                )
            } else {
                Hint("This fleet cannot start one yet. Set up temporary machines under You first.")
            }
            OpenRow("Temporary machines") { showTemporary = true }
        }

        SectionHead("A repository's workflow")
        OpenRow("Runner tokens") { showRunnerTokens = true }
        Hint("A machine started from New session needs no token. A workflow you start yourself needs one, minted here for its repository.")
    }
}

/**
 * What a journal is called on a button. The host's own words for each, from
 * LOG_SOURCES in logs.js, so a person who has read the CLI's answer recognises
 * the same service here.
 */
private fun logName(source: String): String = when (source) {
    "hub" -> "The session manager"
    "coordinator" -> "The fleet coordinator"
    "sidecar" -> "This box as a fleet host"
    else -> source
}
