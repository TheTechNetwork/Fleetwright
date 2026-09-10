package network.thetech.fleetwright

import android.net.Uri
import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * Everything about this device and this fleet that is not a session.
 *
 * WHY IT IS ITS OWN FILE NOW. It lived at the bottom of MainActivity.kt, which
 * had grown to 1883 lines — the screen, the session card, this panel and seven
 * free helper functions, while every other screen in this app (StartSheet,
 * HostSheet, CredentialsSheet, FilesSheet, PeopleSheet, RunnerTokensSheet,
 * KindsSheet, RecycleBinSheet) already had a file of its own. This is over half
 * of what was in there and it shares nothing with the session list but the
 * settings object.
 *
 * A PURE MOVE. No composable, string or helper changed on the way across; the
 * only edit is `private` becoming `internal` on the panel itself, because
 * top-level `private` in Kotlin means file-private and FleetScreen calls this
 * from the file it just left. The helpers below stay private: after the move
 * every one of their call sites is in here.
 */
/**
 * The enrolled hosts, or nothing when this device has no credential.
 *
 * A top-level function rather than a local one inside the composable: local
 * suspend functions that capture composable state are the kind of thing that
 * compiles until the Compose compiler decides otherwise, and there is nothing
 * here that needs to be inside.
 */
private suspend fun enrolledHosts(settings: Settings): List<Fleet.Host> =
    if (settings.credential.isNotBlank()) Fleet(settings).enrolledHosts() else emptyList()

@Composable
internal fun SettingsPanel(settings: Settings, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Saved, so a rotation mid-typing does not silently reset the field to
    // whatever was last persisted.
    var url by rememberSaveable { mutableStateOf(settings.coordinatorUrl) }
    var signedIn by rememberSaveable { mutableStateOf(settings.credential.isNotBlank()) }
    var identity by rememberSaveable { mutableStateOf(settings.signedInAs) }
    var signInResult by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var pin by rememberSaveable { mutableStateOf("") }
    // WHICH HOST THE PIN IN HAND IS FOR, or empty for an unbound one. A bound
    // pin only works on the machine it names, and the refusal for using it
    // elsewhere arrives on the box rather than here — so a screen showing six
    // digits without saying whose they are is one somebody types the wrong pin
    // from.
    var pinBoundTo by rememberSaveable { mutableStateOf("") }
    var ephemeralPin by rememberSaveable { mutableStateOf(false) }
    var hosts by remember { mutableStateOf(listOf<Fleet.Host>()) }
    // Where a temporary machine would come from, or null when this fleet
    // cannot start one. The control below is drawn from this and only this.
    var runnerRepo by remember { mutableStateOf<String?>(null) }
    var runnerPlatform by rememberSaveable { mutableStateOf("linux") }
    var runnerMinutes by rememberSaveable { mutableStateOf("60") }
    var runnerResult by rememberSaveable { mutableStateOf("") }
    var confirming by rememberSaveable { mutableStateOf<String?>(null) }

    confirming?.let { hostId ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("Revoke $hostId?") },
            text = {
                Text(
                    "It is disconnected immediately, and its sessions keep running without it. " +
                        "Getting it back means a new pin, typed on that box.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    scope.launch {
                        busy = true
                        signInResult = Fleet(settings).revokeHost(hostId).text
                        hosts = enrolledHosts(settings)
                        busy = false
                    }
                }) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }

    LaunchedEffect(signedIn) {
        // TWO ANSWERS, ONE WAIT, like the devices section below: they do not
        // depend on each other.
        coroutineScope {
            val members = async { enrolledHosts(settings) }
            val runners = async { if (settings.credential.isNotBlank()) Fleet(settings).runners() else null }
            hosts = members.await()
            // A NULL INSIDE A SUCCESS IS THE ANSWER "no runner repository"; a
            // failed request keeps what was there.
            runners.await()?.onSuccess { runnerRepo = it }
        }
    }

    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Design.Space.inside)) {
        // WHICH BUILD THIS IS, WHERE A PERSON CAN READ IT.
        //
        // versionName is a constant per release, so every build Play has ever
        // shipped looks identical in the store listing and in Android's own app
        // settings. versionCode is the number that actually differs, and until
        // now it was in the APK and nowhere a human could see.
        //
        // The cost of that was a whole round trip: "it is still broken" and
        // "you do not have the fix yet" are the same sentence when nobody can
        // name the build, and the conversation goes in circles rather than
        // anywhere. One line ends it.
        Text(
            "Fleetwright ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text("Coordinator", style = Design.Style.section, color = Design.Palette.ink.now)
        Text(
            "The one origin this app will talk to.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Coordinator URL") },
            placeholder = { Text("https://fleet.thetech.network") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                settings.coordinatorUrl = url
                if (!signedIn) signInResult = "Now sign in."
                onDone()
            },
            enabled = url.isNotBlank(),
        ) { Text("Save") }

        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))

        // Signing in. There is no password here and no account to make: the
        // phone proves who its owner is to Google, and the coordinator issues
        // this device a credential of its own — revocable without disturbing
        // any other phone, and named after the person holding it.
        // WHAT EACH BOX SAYS ABOUT ITSELF. Asked for directly — the sign-in
        // status on the app — and this is it: whether that box is logged in,
        // on what plan, running what code, without SSH.
        var fleetHosts by remember { mutableStateOf(listOf<Fleet.FleetHost>()) }
        var busyHost by remember { mutableStateOf<String?>(null) }
        var hostActionResult by remember { mutableStateOf("") }
        // WHICH host that answer is about. It was one string at the bottom of
        // the list, so an answer about one machine was rendered below four.
        var resultHost by remember { mutableStateOf<String?>(null) }
        var rebootTarget by remember { mutableStateOf<String?>(null) }
        // Deleting for good is the one action here with no undo left, so it
        // asks once. `forget` deliberately does not ask, because it is now
        // reversible — a confirmation on the reversible action and none on the
        // permanent one is how people learn to tap through both.
        var rebootPin by remember { mutableStateOf("") }
        var rebootConfirm by remember { mutableStateOf("") }
        var credentialsFor by remember { mutableStateOf<String?>(null) }
        var settingsFor by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(settings.configured) {
            if (settings.configured) fleetHosts = Fleet(settings).fleetHosts()
        }
        credentialsFor?.let { target ->
            CredentialsSheet(settings, target, onDismiss = { credentialsFor = null })
        }
        // FROM THE LIST'S OWN RECORD, so the sheet opens already knowing what
        // the machine is set to rather than blanking to ask a question it was
        // handed the answer to. Nothing to show if that host has gone since the
        // tap, which is a refresh landing between two frames and not a fault.
        settingsFor?.let { target ->
            fleetHosts.firstOrNull { it.hostId == target }?.let { host ->
                HostSheet(
                    settings,
                    host,
                    onDismiss = { settingsFor = null },
                    // Re-read rather than assume: what the row shows afterwards
                    // is what the box reported, not what a tap hoped for.
                    onChanged = { scope.launch { fleetHosts = Fleet(settings).fleetHosts() } },
                )
            }
        }
        if (fleetHosts.isNotEmpty()) {
            Text("Fleet", style = Design.Style.section, color = Design.Palette.ink.now)
            fleetHosts.forEach { host ->
                Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair / 2)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(host.hostId, fontFamily = FontFamily.Monospace)
                        // Colour reinforces the word; it never carries the
                        // meaning alone.
                        Text(
                            host.state ?: "unknown",
                            style = MaterialTheme.typography.bodySmall,
                            // A status, so a status colour. It was the accent,
                            // which Design.kt spends on things you can tap —
                            // and a healthy host is not a button.
                            color = if (host.state == "healthy") Design.Palette.ok.now
                            else MaterialTheme.colorScheme.error,
                        )
                    }
                    // The registry works to make "we don't know"
                    // unrepresentable as a benign value; rendering its
                    // sentence verbatim is what makes that visible.
                    host.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    // WHO CAN START A SESSION HERE, AND AS WHOM — one line out
                    // of two that overlapped. The row printed "signed in as
                    // eli@x.com · max · eli@x.com's Organization" above "2
                    // people can start sessions here": the org repeating the
                    // address with a suffix, and the count repeating the point
                    // in a full sentence.
                    //
                    // Zero is the real fault and the only thing worth
                    // colouring. Null means an older host and says nothing.
                    host.claudeAccounts?.let { accounts ->
                        Text(
                            describeWhoCanStart(accounts, host),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (accounts == 0) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    // WHAT IT IS RUNNING, WHAT IS WAITING, AND WHICH RELEASES
                    // IT TAKES — one line, read left to right in the order
                    // somebody asks the questions. The channel had a line of
                    // its own on every row, eleven words saying the same thing
                    // about every machine.
                    Text(
                        describeRunning(host),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (host.appPending) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // THE SECOND WAY TO BE SIGNED OUT, and the one that was
                    // invisible. `loggedIn` above reports on the box's own home
                    // directory; this reports on the credential file a session
                    // is handed a copy of. They came apart in production — a
                    // box saying "signed in" while every session started on it
                    // came up logged out — and the only visible symptom was
                    // that a brand new session worked and a resumed one did
                    // not.
                    //
                    // Shown only when it is DEAD. An expired token that can
                    // renew itself is the ordinary state of a box nobody has
                    // touched for an hour, and a warning that fires on the
                    // ordinary case is one people stop reading.
                    host.credential?.takeIf { it.isDead }?.let { credential ->
                        Text(
                            credential.summary ?: "Sessions started here will come up signed out.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    // WHAT THE OS HAS WAITING. The host has been sending this
                    // since maintenance shipped and nothing displayed it, which
                    // is why upgrade looked like a verb that could only report.
                    host.systemUpdates?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    // A PACKAGED BOX'S ANSWER, and until now the only screen it
                    // reached was a terminal. The version line counts commits,
                    // which a release has none of, so a packaged host reported
                    // null — cannot tell — and this row said nothing about
                    // updates while the pipeline that built them ran on every
                    // merge.
                    //
                    // The host's own sentence, verbatim: it is the only thing
                    // that knows which answer this is.
                    host.release?.message?.let { message ->
                        Text(
                            message,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (host.release.available != null || !host.release.configured) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    if (host.rebootRequired) {
                        Text("reboot required", style = MaterialTheme.typography.bodySmall)
                    }
                    // MAINTENANCE, which used to need SSH. Update is safe and
                    // idempotent so it is one tap; reboot is two steps and asks
                    // for the hostname, exactly as it does in chat — a remote
                    // reboot should be harder than a local one, not easier.
                    //
                    // This is the half of #171 that shipped to iOS and not to
                    // here. Both phones now carry the same six verbs, which was
                    // the point of that round.
                    // CHECK ALWAYS; APPLY ONLY WHEN THERE IS SOMETHING TO
                    // APPLY. The app had this backwards in two directions:
                    // Update always restarted (apply with no check) and Upgrade
                    // never applied (check with no apply). A button that is
                    // always offered teaches people to press it without
                    // reading, which is the opposite of what this screen is for.
                    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        TextButton(
                            enabled = busyHost == null,
                            onClick = {
                                scope.launch {
                                    busyHost = host.hostId
                                    // ONE VERB, BOTH SUBJECTS. This was
                                    // `upgrade` alone — the operating system —
                                    // while the button sits between two things
                                    // that can be out of date, and it produced
                                    // a screen contradicting itself: "The box
                                    // is up to date." directly above "1 commit
                                    // behind". Two verbs would be two round
                                    // trips and two chances to render them
                                    // apart; one answer cannot disagree with
                                    // itself.
                                    resultHost = host.hostId
                                    val r = Fleet(settings).updates(host.hostId)
                                    hostActionResult = r.text
                                    busyHost = null
                                    fleetHosts = Fleet(settings).fleetHosts()
                                    // BELIEVE THE REPLY, AFTER the refresh
                                    // rather than before it — the refresh is
                                    // what would otherwise overwrite it. This
                                    // is the freshest thing anybody has about
                                    // this box: it was computed a moment ago
                                    // because somebody pressed a button, while
                                    // the row renders from a cache the host
                                    // refreshes every fifteen minutes.
                                    r.waiting?.let { w ->
                                        fleetHosts = fleetHosts.map {
                                            if (it.hostId != host.hostId) it
                                            else it.copy(
                                                behind = if (w.appKind == "checkout") w.appBehind else null,
                                                // `systemText` is a sentence either
                                                // way — "No system packages are
                                                // waiting." is a fine answer and a
                                                // bad value for a field whose
                                                // emptiness hides a button.
                                                systemUpdates = if (w.systemPending) w.systemText else null,
                                                release = if (w.appKind == "release") {
                                                    Fleet.Release(
                                                        available = w.appAvailable,
                                                        // Unreachable in practice: only a
                                                        // host new enough to send `waiting`
                                                        // gets here, and those always send
                                                        // `configured` beside it.
                                                        configured = w.appConfigured ?: true,
                                                        message = w.appText,
                                                    )
                                                } else {
                                                    null
                                                },
                                                appPendingReported = w.appPending,
                                            )
                                        }
                                    }
                                }
                            },
                        ) { Text("Check") }
                        if (host.appPending) {
                            TextButton(
                                enabled = busyHost == null,
                                onClick = {
                                    scope.launch {
                                        busyHost = host.hostId
                                        resultHost = host.hostId
                                    hostActionResult = Fleet(settings).update(host.hostId, restart = true).text
                                        busyHost = null
                                        fleetHosts = Fleet(settings).fleetHosts()
                                    }
                                },
                            ) { Text("Apply update") }
                        }
                        if (host.systemPending) {
                            TextButton(
                                enabled = busyHost == null,
                                onClick = {
                                    scope.launch {
                                        busyHost = host.hostId
                                        resultHost = host.hostId
                                    hostActionResult = Fleet(settings).upgrade(host.hostId, apply = true).text
                                        busyHost = null
                                        fleetHosts = Fleet(settings).fleetHosts()
                                    }
                                },
                            ) { Text("Apply upgrade") }
                        }
                        TextButton(
                            enabled = busyHost == null,
                            onClick = { rebootTarget = host.hostId; rebootPin = ""; rebootConfirm = "" },
                        ) { Text("Reboot") }
                        TextButton(onClick = { credentialsFor = host.hostId }) { Text("Credentials") }
                        // SETTINGS, BEHIND A TAP, because the two behind it are
                        // a segmented choice and a list that grows — and putting
                        // them in this card would rebuild the wall iOS has just
                        // taken apart. What lands on this machine, and what makes
                        // work land on it at all.
                        TextButton(onClick = { settingsFor = host.hostId }) { Text("Settings") }
                    }
                    // THE UPDATE CHANNEL, beside the button it decides the
                    // meaning of: "Apply update" installs whatever this says is
                    // eligible. It used to be a line in /etc/agent-hub.env,
                    // which meant SSH — the one thing somebody holding only a
                    // phone does not have.
                    //
                    // Absent on a host that predates the verb, which is null
                    // and NOT "stable": an app that guessed would label a box
                    // confidently and wrongly.
                    host.channel?.let { current ->
                    // THIS HOST'S ANSWER, IN THIS HOST'S ROW. It used to be one
                    // string at the bottom of the whole screen, below every
                    // machine, belonging to none of them — and directly under a
                    // row that could be saying the opposite.
                    if (resultHost == host.hostId && hostActionResult.isNotBlank()) {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            shape = MaterialTheme.shapes.small,
                        ) {
                            Text(
                                hostActionResult,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier
                                    .padding(Design.Space.insideTight)
                                    .heightIn(max = 180.dp)
                                    .verticalScroll(rememberScrollState()),
                            )
                        }
                    }
                        // ONLY WHEN IT IS A CHOICE. A pinned box used to render
                        // "Channel: stable — set on the box" as a line of its
                        // own, on every row, saying the same eleven words about
                        // every machine. The fact still travels —
                        // describeRunning puts it at the end of the version
                        // line, where it is three words and in context.
                        if (host.channelPinned) {
                            // Nothing: said above, in context.
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                                listOf("stable", "rolling").forEach { option ->
                                    FilterChip(
                                        selected = current == option,
                                        enabled = busyHost == null && current != option,
                                        onClick = {
                                            scope.launch {
                                                busyHost = host.hostId
                                                resultHost = host.hostId
                                                // BELIEVE THE REPLY, NOT THE
                                                // NEXT REFRESH — see the iOS
                                                // note. The host pushes a
                                                // health frame after a mutating
                                                // verb now, and the refresh
                                                // below races it; losing that
                                                // race shows the old channel a
                                                // second after confirming the
                                                // new one.
                                                hostActionResult =
                                                    Fleet(settings).channel(host.hostId, to = option).let { r ->
                                                        r.channel?.let { now ->
                                                            fleetHosts = fleetHosts.map {
                                                                if (it.hostId == host.hostId) {
                                                                    it.copy(channel = now, channelPinned = r.channelPinned)
                                                                } else it
                                                            }
                                                        }
                                                        r.text
                                                    }
                                                busyHost = null
                                                // Re-read rather than assume:
                                                // what the row shows afterwards
                                                // is what the box reported, not
                                                // what this tap hoped for.
                                                fleetHosts = Fleet(settings).fleetHosts()
                                            }
                                        },
                                        label = { Text(option) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
            // TWO STEPS, and the second one asks for the hostname typed out.
            // The pin is issued by the BOX: a coordinator that could mint it
            // could reboot the fleet. The button stays disabled until the typed
            // name matches, which is the only guard that survives being remote.
            rebootTarget?.let { target ->
                Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    Text("Reboot $target", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Every session on this box dies — a reboot takes the tmux server with it.",
                        style = MaterialTheme.typography.bodySmall,
                    )
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
                        label = { Text("Type $target to confirm") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        TextButton(
                            enabled = busyHost == null,
                            onClick = {
                                scope.launch {
                                    busyHost = target
                                    hostActionResult = Fleet(settings).reboot(target).text
                                    busyHost = null
                                }
                            },
                        ) { Text("Ask for a pin") }
                        TextButton(
                            enabled = rebootPin.isNotBlank() && rebootConfirm == target && busyHost == null,
                            onClick = {
                                scope.launch {
                                    busyHost = target
                                    hostActionResult =
                                        Fleet(settings).reboot(target, rebootPin, rebootConfirm).text
                                    rebootTarget = null
                                    busyHost = null
                                }
                            },
                        ) { Text("Reboot") }
                        TextButton(onClick = { rebootTarget = null }) { Text("Cancel") }
                    }
                }
            }
            if (hostActionResult.isNotBlank()) {
                // MONOSPACED AND ALLOWED TO BE TALL. This is a host's own
                // output — several lines, with paths and commit ids in — and it
                // was rendered as a squeezed caption that ran together into one
                // paragraph.
                Text(
                    hostActionResult,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier
                        .heightIn(max = 220.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
            HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))
        }

        // Assistant setup, above the account section: this is the thing people
        // come back to settings for, and sign-in is the thing they do once.
        var showKinds by remember { mutableStateOf(false) }
        Text("Siri and Assistant", style = Design.Style.section, color = Design.Palette.ink.now)
        Text(
            "A kind is a word you can say — \"start a dev session\" — carrying its own defaults. "
                + "Adding one here is the whole setup: nothing else to install or paste.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedButton(onClick = { showKinds = true }) { Text("Session kinds") }
        if (showKinds) KindsSheet(settings = settings, onDismiss = { showKinds = false })

        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))

        // Who may sign in. The iOS app has had this screen since invitations
        // shipped; this one rendered the same fleet with no way to let anybody
        // into it, and the roadmap said both phones had it.
        var showPeople by remember { mutableStateOf(false) }
        Text("People", style = Design.Style.section, color = Design.Palette.ink.now)
        Text(
            "Invite somebody by address. They sign in as themselves and see only the sessions they start.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedButton(onClick = { showPeople = true }) { Text("People") }
        if (showPeople) PeopleSheet(settings = settings, onDismiss = { showPeople = false })

        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))

        Text("You", style = Design.Style.section, color = Design.Palette.ink.now)
        if (signedIn && Demo.isActive(settings.coordinatorUrl)) {
            // Said plainly, and never as "signed in". Every reply from this
            // fleet carries `demo: true`, and somebody wondering why their
            // machines are missing deserves the answer on the screen rather
            // than in a support thread.
            Text("Demo — invented hosts and sessions", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = {
                settings.credential = ""
                settings.signedInAs = ""
                settings.coordinatorUrl = settings.urlBeforeDemo
                url = settings.urlBeforeDemo
                settings.urlBeforeDemo = ""
                signedIn = false
                identity = ""
                hosts = emptyList()
            }) { Text("Leave the demo") }
        } else if (signedIn) {
            Text(
                "Signed in as ${identity.ifBlank { "this device" }}",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = {
                settings.credential = ""
                settings.signedInAs = ""
                signedIn = false
                identity = ""
                hosts = emptyList()
            }) { Text("Sign out") }
        } else {
            Text(
                "This device gets a credential of its own, kept encrypted with a key that never leaves " +
                    "the phone's keystore. A fleet allows people by email address.",
                style = MaterialTheme.typography.bodySmall,
            )
            // WHY IT IS GREY, SAID OUT LOUD. Sign-in needs somewhere to sign in
            // TO — the button posts an ID token to a coordinator, and without a
            // URL there is nowhere to post it. That was true and invisible: a
            // disabled control with no reason beside it reads as a broken app,
            // and the person's next move is to tap it repeatedly rather than to
            // fill in the field above.
            //
            // Only while it IS disabled, and only for the reason that is a
            // person's to fix. "Busy" needs no explanation — the button says
            // "signing in…" already.
            if (url.isBlank()) {
                Text(
                    "Add a coordinator URL above first — signing in means signing in to a fleet.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(
                enabled = url.isNotBlank() && !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        signInResult = "signing in…"
                        // Save first: signing in against a URL that has been
                        // typed but not saved would sign in to the wrong fleet.
                        settings.coordinatorUrl = url
                        try {
                            val idToken = SignIn.googleIdToken(context)
                            val (token, email) = Fleet(settings).signIn(
                                idToken = idToken,
                                deviceName = "${Build.MANUFACTURER} ${Build.MODEL}",
                            )
                            settings.credential = token
                            settings.signedInAs = email
                            signedIn = true
                            identity = email
                            signInResult = ""
                            hosts = enrolledHosts(settings)
                        } catch (e: SignIn.Cancelled) {
                            signInResult = ""
                        } catch (e: Exception) {
                            signInResult = e.message ?: "sign-in failed"
                        }
                        busy = false
                    }
                },
            ) { Text("Sign in with Google") }
            // A disabled button that says nothing is "the button does nothing",
            // which SignIn.kt takes trouble to avoid one file away and then this
            // reproduced. Sign-in is per-fleet — the ID token is exchanged with a
            // particular coordinator — so the URL genuinely has to come first;
            // that is a thing to say, not a thing to grey out in silence.
            if (url.isBlank()) {
                Text(
                    "Set the coordinator URL above first — signing in exchanges your Google " +
                        "identity with one specific fleet.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // ONE TAP INTO A FLEET THAT ISN'T REAL.
            //
            // The demo credential has existed since store review needed one,
            // and reaching it meant finding a token in a deployment document
            // and pasting it into a field labelled "credential" — which is a
            // fair description of no demo at all for anybody not already
            // reading the repo.
            //
            // The real coordinator is REMEMBERED rather than discarded:
            // somebody who has already pointed this app at their own fleet and
            // taps out of curiosity gets it back when they leave.
            TextButton(onClick = {
                if (settings.coordinatorUrl.isNotBlank() && !Demo.isActive(settings.coordinatorUrl)) {
                    settings.urlBeforeDemo = settings.coordinatorUrl
                }
                settings.coordinatorUrl = Demo.COORDINATOR_URL
                url = Demo.COORDINATOR_URL
                settings.signedInAs = Demo.LABEL
                settings.credential = Demo.CREDENTIAL
                identity = Demo.LABEL
                signedIn = true
                onDone()
            }) { Text("Look around the demo fleet") }
        }
        if (signInResult.isNotBlank()) {
            Text(signInResult, style = MaterialTheme.typography.bodySmall)
        }

        if (signedIn) {
            HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))

            // Adding a machine. This is the second thing anybody does after
            // signing in, and the pin is the whole of how a host joins now —
            // there is no shared token to copy onto the box.
            Text("Hosts", style = Design.Style.section, color = Design.Palette.ink.now)
            // TEMPORARY IS A PROPERTY OF THE PIN, not of the box. The
            // coordinator has been able to admit a host that is expected to
            // vanish since the framework was built, and nothing could ask it to
            // — so every CI runner enrolled as permanent and left its entry
            // behind when the job ended. One corpse per build.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = ephemeralPin, onCheckedChange = { ephemeralPin = it }, enabled = !busy)
                Spacer(Modifier.width(Design.Space.insideTight))
                Text("Temporary host (CI runner)", style = MaterialTheme.typography.bodyMedium)
            }
            if (ephemeralPin) {
                Text(
                    "Retired the moment it disconnects, and its key revoked. Never chosen " +
                        "automatically for work — it has the most free capacity in the fleet " +
                        "precisely because it is about to disappear.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        pinBoundTo = ""
                        pin = runCatching { Fleet(settings).mintHostPin(ephemeralPin) }
                            .getOrElse { signInResult = it.message ?: "could not mint a pin"; "" }
                        busy = false
                    }
                },
            ) { Text("Mint a pin for a new host") }

            if (pin.isNotBlank()) {
                // 123 456 — read down a phone, typed into a terminal.
                Text(
                    if (pin.length == 6) "${pin.take(3)} ${pin.takeLast(3)}" else pin,
                    style = MaterialTheme.typography.headlineMedium,
                    fontFamily = FontFamily.Monospace,
                )
                if (pinBoundTo.isNotBlank()) {
                    Text(
                        "for $pinBoundTo only",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                Text(
                    "On that box: agent-fleet-sidecar enrol $pin\nGood for ten minutes, once.",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }

            // A MACHINE THAT DOES NOT EXIST YET, beside the pin for one that
            // does. `provision` has been on this phone since runner central
            // shipped and nothing offered it, because nothing could tell
            // whether the button would do anything: the coordinator refuses a
            // fleet with no runner repository with a sentence naming an
            // environment variable, which is right for an agent that asked and
            // a dead control on every fleet that has not set one. The snapshot
            // says now, and this is drawn from that and only that.
            runnerRepo?.let { repo ->
                Text("Temporary machine", style = MaterialTheme.typography.titleSmall)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    listOf("linux" to "Linux", "macos" to "macOS", "windows" to "Windows", "android" to "Android emulator")
                        .forEach { (value, label) ->
                            FilterChip(
                                selected = runnerPlatform == value,
                                enabled = !busy,
                                onClick = { runnerPlatform = value },
                                label = { Text(label) },
                            )
                        }
                }
                OutlinedTextField(
                    value = runnerMinutes,
                    onValueChange = { runnerMinutes = it.filter { c -> c.isDigit() }.take(3) },
                    label = { Text("Minutes, 5 to 350") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                OutlinedButton(
                    // THE PROTOCOL'S OWN BOUNDS, checked here so the refusal
                    // for 4 and for 351 is not written twice. Outside them the
                    // button is not offered, which is what the field's label
                    // is for.
                    enabled = !busy && (runnerMinutes.toIntOrNull() ?: 0) in 5..350,
                    onClick = {
                        scope.launch {
                            busy = true
                            runnerResult = runCatching {
                                Fleet(settings).provision(runnerPlatform, minutes = runnerMinutes.toInt()).text
                            }.getOrElse { it.message ?: "that did not work" }
                            busy = false
                        }
                    },
                ) { Text("Ask for a temporary machine") }
                // IT DOES NOT RETURN A HOST, and the reply says so too, because
                // a person who reads "started" as "ready" goes looking for a
                // machine that is still being built.
                Text(
                    "From $repo. It takes a few minutes to boot and then appears in the fleet as a host " +
                        "of yours, for the time you asked. Sessions on it are lost when it goes, and it " +
                        "spends Actions minutes.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (runnerResult.isNotBlank()) {
                    Text(
                        runnerResult,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }

            // AND THE THIRD WAY A MACHINE ARRIVES: a repository's own
            // workflow, started by hand, joining a runner as you. Minted with
            // curl since it shipped; a screen now.
            var showRunnerTokens by remember { mutableStateOf(false) }
            OutlinedButton(onClick = { showRunnerTokens = true }, enabled = !busy) { Text("Runner tokens") }
            if (showRunnerTokens) RunnerTokensSheet(settings = settings, onDismiss = { showRunnerTokens = false })

            for (host in hosts) {
                // The design's card, not Material's: the one place in the app
                // that still drew a bare Card, on the screen that lists the
                // machines the rest of the app is careful to render alike.
                Column(Modifier.fillMaxWidth().fleetCard(radius = Design.Radius.cardSmall)) {
                    Column(Modifier.padding(Design.Space.inside)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(host.hostId, style = MaterialTheme.typography.titleSmall)
                            Spacer(Modifier.weight(1f))
                            if (host.revoked) {
                                Text("revoked", style = MaterialTheme.typography.bodySmall)
                            } else {
                                // Asked first. Revoking is one tap next to a
                                // name in a list, it disconnects a machine
                                // mid-session, and the only way back is a new
                                // pin typed on the box — which is exactly the
                                // errand this app exists to avoid.
                                TextButton(
                                    enabled = !busy,
                                    onClick = { confirming = host.hostId },
                                ) { Text("Revoke") }
                            }
                            // THE TWO CASES AN UNBOUND PIN IS REFUSED FOR, and
                            // until now the only way through either was a curl
                            // carrying the break-glass admin token — the
                            // credential this whole design exists to stop
                            // needing. Both refusals name the remedy, and
                            // neither was reachable from here.
                            //
                            // /api/enroll takes any signed-in credential, so
                            // this is a screen that was missing rather than a
                            // permission that was.
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        pinBoundTo = ""
                                        pin = runCatching {
                                            Fleet(settings).mintHostPin(hostId = host.hostId, readmit = host.revoked)
                                        }.getOrElse { signInResult = it.message ?: "could not mint a pin"; "" }
                                        // Set only on success, so a failed mint
                                        // cannot leave the previous pin on
                                        // screen wearing a new host's name.
                                        if (pin.isNotBlank()) pinBoundTo = host.hostId
                                        busy = false
                                    }
                                },
                            ) { Text(if (host.revoked) "Readmit" else "Replace key") }
                        }
                        // The fingerprint is here so it can be compared with
                        // what the box itself prints. Two machines claiming one
                        // name is exactly when you need to know which key is
                        // which.
                        Text(
                            host.fingerprint,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }

        // "Use a credential instead" WAS HERE, and is gone.
        //
        // It existed for two things. The first was store review, which needed
        // a way in that no allowlist could grant — now a button in the section
        // above, because asking a reviewer to find a token in a deployment
        // document and paste it into a field labelled "credential" is a fair
        // description of no demo at all.
        //
        // The second was getting back in when sign-in itself is broken. That
        // is a real need and it is now served by curl with the API token
        // rather than by a field in everybody's settings. A box that asks for
        // a token, in front of every user, is how the shared-secret habit
        // comes back — and a recovery path only the operator needs does not
        // belong on the operator's users' screens.

        // Push is the one feature that fails silently: a registration that
        // never arrived and a coordinator with no sender configured look
        // identical from here, which is to say they look like nothing at all.
        // This asks the coordinator to send one now and reports what happened,
        // so the answer arrives before the notification that matters does.
        // WHO CAN REACH THIS FLEET, AND WHAT HAPPENED WHILE THIS WAS CLOSED.
        // Both routes are in openapi.json and served by both coordinators, and
        // neither app ever asked for either. Signing in mints one credential
        // per device precisely so that revoking one leaves the others alone,
        // and that property was worth nothing while nobody could see the list:
        // a lost phone could be revoked only from a terminal.
        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))
        var clients by remember { mutableStateOf<List<Fleet.Client>>(emptyList()) }
        var events by remember { mutableStateOf<List<Fleet.Event>>(emptyList()) }
        var clientResult by rememberSaveable { mutableStateOf("") }
        var confirmRevoke by remember { mutableStateOf<Fleet.Client?>(null) }
        LaunchedEffect(signedIn) {
            if (!signedIn) return@LaunchedEffect
            // TWO ANSWERS, ONE WAIT. These were sequential, so the section sat
            // empty for two round trips one after another before it drew
            // anything. They do not depend on each other.
            coroutineScope {
                val devices = async { Fleet(settings).clients() }
                val happened = async { Fleet(settings).events() }
                clients = devices.await()
                events = happened.await()
            }
        }

        Text("Devices", style = Design.Style.section, color = Design.Palette.ink.now)
        Text(
            "Each sign-in mints a credential for that device alone, so revoking one leaves the " +
                "others working.",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(bottom = Design.Space.insideTight),
        )
        if (clients.isEmpty()) {
            Text("No devices reported.", style = MaterialTheme.typography.bodySmall)
        }
        for (c in clients) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(vertical = Design.Space.hair),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(c.name ?: "unnamed device")
                    Text(describeClient(c), style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { confirmRevoke = c }) { Text("Revoke") }
            }
        }
        if (clientResult.isNotBlank()) {
            Text(clientResult, style = MaterialTheme.typography.bodySmall)
        }
        confirmRevoke?.let { c ->
            AlertDialog(
                onDismissRequest = { confirmRevoke = null },
                title = { Text("Revoke ${c.name ?: "this device"}?") },
                text = {
                    Text(
                        "That device stops being able to reach this fleet, and its push " +
                            "notifications stop. Every other device keeps working. Signing in " +
                            "again on it mints a new one.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        val target = c
                        confirmRevoke = null
                        scope.launch {
                            // The refusal reaches the screen. A discarded error
                            // reads as "it came back", which cost an evening on
                            // the host revocation this mirrors.
                            clientResult = Fleet(settings).revokeClient(target.id).text
                            clients = Fleet(settings).clients()
                        }
                    }) { Text("Revoke") }
                },
                dismissButton = { TextButton(onClick = { confirmRevoke = null }) { Text("Cancel") } },
            )
        }

        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))
        Text("Recent activity", style = Design.Style.section, color = Design.Palette.ink.now)
        Text(
            "What happened while this app was closed. A notification wakes the phone; this is " +
                "the rest of it.",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(bottom = Design.Space.insideTight),
        )
        if (events.isEmpty()) {
            Text("Nothing recorded yet.", style = MaterialTheme.typography.bodySmall)
        }
        // NEWEST FIRST HERE, oldest-first on the wire. The coordinator returns
        // them in the order they happened, which is right for a log and wrong
        // for a screen somebody opens to find out what they missed.
        for (e in events.reversed()) {
            Column(Modifier.fillMaxWidth().padding(vertical = Design.Space.hair)) {
                Text(describeEvent(e))
                Text(describeEventWho(e), style = MaterialTheme.typography.bodySmall)
            }
        }

        HorizontalDivider(Modifier.padding(vertical = Design.Space.inside))
        var pushResult by rememberSaveable { mutableStateOf("") }
        OutlinedButton(
            onClick = {
                scope.launch {
                    pushResult = "sending…"
                    pushResult = Fleet(settings).testPush(null).text
                }
            },
            enabled = signedIn,
        ) { Text("Send a test notification") }
        if (pushResult.isNotBlank()) {
            Text(pushResult, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = Design.Space.insideTight))
        }
    }
}


/**
 * "2 people · eli@example.com · max", or the fault when it is nobody.
 *
 * ONE LINE OUT OF TWO THAT OVERLAPPED. The org is dropped when it is only the
 * address again — Google and Anthropic both name a personal organisation that
 * way, so on a single-person account it is guaranteed noise.
 */
private fun describeWhoCanStart(accounts: Int, host: Fleet.FleetHost): String {
    // THE ZERO CASE KEEPS ITS WORDS. It is the only real fault here, and
    // "Nobody" alone says what is wrong without saying what to do about it —
    // naming the Claude account is what makes it actionable.
    if (accounts == 0) return "Nobody has connected a Claude account here — sessions will not start"
    val parts = mutableListOf("$accounts ${if (accounts == 1) "person" else "people"}")
    host.accountEmail?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    host.accountPlan?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    host.accountOrg?.takeIf { it.isNotBlank() && !it.startsWith(host.accountEmail ?: "\u0000") }?.let { parts.add(it) }
    return parts.joinToString(" · ")
}

/**
 * "0223f94 · 1 commit behind · rolling", or as much of it as is known.
 *
 * Three lines collapsed into one, in the order somebody asks the questions:
 * what is it running, is that current, and what will it take next.
 */
/**
 * "someone@example.com · never used", or as much as is known.
 *
 * NEVER USED AND USED LONG AGO MUST LOOK DIFFERENT. `lastSeenAt` is null for a
 * credential that has never been spent, and rendering that as an epoch date is
 * the difference between spotting a credential somebody minted and never
 * collected and scrolling straight past it.
 */
private fun describeClient(c: Fleet.Client): String {
    val parts = mutableListOf<String>()
    c.email?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    parts.add(c.lastSeenAt?.let { "last used ${relative(it)}" } ?: "never used")
    return parts.joinToString(" · ")
}

/**
 * The sentence for one event, with its subject named.
 *
 * The fleet records `text` for the events that have something to say and not
 * for the rest, so this falls back to the event's own name — a blank row in a
 * list of things that happened is worse than a terse one.
 */
private fun describeEvent(e: Fleet.Event): String = when {
    !e.text.isNullOrBlank() -> e.text
    !e.name.isNullOrBlank() -> "${e.event} — ${e.name}"
    else -> e.event
}

/** "on deb132 · elibrody2@gmail.com · 20 minutes ago". */
private fun describeEventWho(e: Fleet.Event): String {
    val parts = mutableListOf<String>()
    e.hostId?.takeIf { it.isNotBlank() }?.let { parts.add("on $it") }
    // NULL ACTOR IS NOT AN UNKNOWN PERSON — it is the fleet acting on its own,
    // which is a different kind of news and says so.
    parts.add(e.actor?.takeIf { it.isNotBlank() } ?: "the fleet")
    parts.add(relative(e.at).toString())
    return parts.joinToString(" · ")
}

/** Milliseconds since the epoch, as words. */
private fun relative(at: Long): CharSequence =
    android.text.format.DateUtils.getRelativeTimeSpanString(
        at,
        System.currentTimeMillis(),
        android.text.format.DateUtils.MINUTE_IN_MILLIS,
    )

private fun describeRunning(host: Fleet.FleetHost): String {
    val parts = mutableListOf<String>()
    host.version?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    val behind = host.behind ?: 0
    when {
        // FIRST, because it is the one thing on this line somebody can act on
        // right now, and because every branch below it is about downloads. A
        // box can have nothing left to fetch and still be running an old
        // release: the fleet said "main-88 · up to date" about exactly that.
        host.restartWaitingFor != null -> parts.add("${host.restartWaitingFor} installed, restart waiting")
        behind > 0 -> parts.add("$behind commit${if (behind == 1) "" else "s"} behind")
        host.release?.available != null -> parts.add("${host.release.available} waiting")
        // A migratable checkout counts no commits and names no release version,
        // so both branches above are silent on it — and it read as current
        // beside its own Apply button.
        host.appPending -> parts.add("update waiting")
        // "UP TO DATE" IS A CLAIM, AND THIS IS WHERE IT WAS INVENTED. Every
        // packaged box reports a null commit count, so the branch below fired
        // on all of them, and on any box that had never reached GitHub. Not
        // knowing is its own state and gets its own words.
        !host.appStatusKnown -> parts.add("update status unknown")
        host.version != null -> parts.add("up to date")
    }
    // BESIDE THE BRANCH ABOVE, NOT INSTEAD OF IT. A box can be up to date on
    // what it downloads and runs, and still be taking every update with a
    // helper the installer never refreshed, so nothing root owns follows the
    // release. Both are true at once and the row says both. Same words as
    // iOS, held equal by test/root-half-shown.test.js.
    if (host.rootHalfBehind) parts.add("update helper out of date")
    host.channel?.takeIf { it.isNotBlank() }?.let {
        // Pinned is worth a word, because it is why the picker is missing.
        parts.add(if (host.channelPinned) "$it, set on the box" else it)
    }
    return if (parts.isEmpty()) "version not reported" else parts.joinToString(" · ")
}
