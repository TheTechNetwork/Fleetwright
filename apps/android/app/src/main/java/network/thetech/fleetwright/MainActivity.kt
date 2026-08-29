package network.thetech.fleetwright

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.launch

/**
 * The whole app.
 *
 * One screen: what is running, and the three things you would want to do about
 * it from a phone. Everything it knows comes from the coordinator, and every
 * action it takes is an intent — the app never talks to a host directly, so it
 * never has to know which box holds which session.
 */
class MainActivity : ComponentActivity() {

    private val askForNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* declined is fine */ }

    /**
     * Tell the coordinator where to send notifications.
     *
     * On every launch rather than once: registration is keyed by the token, so
     * repeating it is an update rather than a duplicate, and "once" would mean
     * a phone that was configured after its first launch never registers at
     * all. Messaging.onNewToken covers rotation in between.
     *
     * Silent when the app has no coordinator yet — there is nowhere to send it,
     * and an error about that on first launch would be noise in front of the
     * settings screen the person is about to fill in.
     */
    private fun registerForPush() {
        val settings = Settings(applicationContext)
        if (!settings.configured) return
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            val token = task.result
            if (!task.isSuccessful || token.isNullOrBlank()) {
                Log.w("Fleetwright", "no FCM token: ${task.exception?.message}")
                return@addOnCompleteListener
            }
            lifecycleScope.launch {
                runCatching { Fleet(settings).registerDevice(token) }
                    .onFailure { Log.w("Fleetwright", "could not register for push: ${it.message}") }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 13+ will not show a notification until this is granted, and a
        // fleet app that cannot tell you a session is waiting has lost its main
        // reason to exist.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        registerForPush()

        setContent {
            // MaterialTheme with no argument is lightColorScheme() forever, which
            // is how this app had a dark theme in the manifest and a white screen
            // in the hand. dynamicColorScheme picks up the wallpaper palette on
            // Android 12+, which every device running minSdk 36 is.
            val dark = isSystemInDarkTheme()
            val context = LocalContext.current
            MaterialTheme(
                colorScheme = if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context),
            ) {
                FleetScreen(
                    onSignedIn = ::registerForPush,
                    // Read once, from the intent that started this activity. A
                    // shortcut tap is the only thing that sets it.
                    launchKindId = intent?.getStringExtra(SessionKinds.EXTRA_KIND_ID),
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(onSignedIn: () -> Unit = {}, launchKindId: String? = null) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val fleet = remember { Fleet(settings) }
    val scope = rememberCoroutineScope()

    // rememberSaveable, not remember: a rotation destroys and recreates the
    // activity, and plain `remember` state does not survive that. It used to
    // take you out of the settings panel mid-edit and throw away the URL and
    // token you had typed — on the one screen where losing input costs the
    // most, because nothing is saved until you press Save.
    var showSettings by rememberSaveable { mutableStateOf(!settings.configured) }
    var showStart by rememberSaveable { mutableStateOf(false) }
    // The kind a launcher shortcut asked for, consumed once. Held here rather
    // than read inside the sheet so that dismissing and reopening by hand does
    // not silently re-apply a kind nobody chose the second time.
    var pendingKindId by rememberSaveable { mutableStateOf<String?>(null) }
    var status by rememberSaveable { mutableStateOf("") }
    // The session list is deliberately NOT saved: it is a cache of what the
    // coordinator said, it is refetched on the way back, and a stale list
    // restored across a rotation would show sessions that may since have
    // stopped.
    var sessions by remember { mutableStateOf(listOf<Fleet.Session>()) }
    // Hosts, for the bin — which is fleet-wide and therefore needs them all.
    var binHosts by remember { mutableStateOf(listOf<Fleet.FleetHost>()) }
    var showBin by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    /**
     * @param keepStatus keep whatever is already on screen if the list call
     *   succeeds. Set after an action, whose reply text is the only
     *   confirmation the coordinator ever gives — a plain refresh would wipe
     *   "Started cc-brave-otter." a few hundred milliseconds after it appeared.
     */
    fun refresh(keepStatus: Boolean = false) {
        if (!settings.configured) return
        scope.launch {
            busy = true
            val reply = fleet.list()
            sessions = reply.sessions
            // A failure is shown, never swallowed: "nothing here" and "I could
            // not reach the coordinator" look identical otherwise, and they are
            // completely different problems.
            status = if (!reply.ok) reply.text else if (keepStatus) status else ""
            // THE BIN'S CONTENTS, which `list` does not carry: a bin entry is
            // not a session, it is a session that stopped being one. Kept in a
            // separate assignment that falls back to what we already had — a
            // fleet call that fails must not blank the session list that
            // already arrived.
            binHosts = runCatching { fleet.fleetHosts() }.getOrDefault(binHosts)
            busy = false
        }
    }

    /**
     * Start a session without making anybody watch it happen.
     *
     * THE SHEET CLOSES ON TAP. Starting takes the host up to a minute — a
     * container, a fresh volume, credentials, and the Remote Control check —
     * and two earlier attempts at this were wrong in the same direction: a
     * disabled button, then a spinner explaining the wait. Explaining a wait is
     * still a wait, and nobody needs to be present for it.
     *
     * The coroutine is owned HERE, not in the dialog, because a job scoped to a
     * dismissed composable is one that may not finish — and this is a mutating
     * request that has already left.
     */
    fun startInBackground(request: StartRequest) {
        status = "Starting a session. You will get a notification when it is ready."
        scope.launch {
            val text = try {
                val reply = fleet.start(
                    title = request.title,
                    brief = request.brief,
                    mode = request.mode,
                    host = request.host,
                )
                LocalNotice.post(context, "Session ready", reply.text.ifBlank { "Started." })
                reply.text.ifBlank { "Started." }
            } catch (e: Exception) {
                // A TIMEOUT IS NOT A FAILURE: `start` is mutating and carries
                // an idempotency key, so the session may well exist. Saying
                // "failed" would send somebody to start a second one — and the
                // second would be a second session, because a retry mints a
                // new key.
                val message = e.message.orEmpty()
                val timedOut = e is java.net.SocketTimeoutException || message.contains("timeout", true)
                val out = if (timedOut) {
                    "Still starting, or started — the answer did not come back in time. Pull to refresh to see."
                } else {
                    message.ifBlank { "could not start" }
                }
                LocalNotice.post(context, if (timedOut) "Session may be starting" else "Could not start a session", out)
                out
            }
            status = text
            refresh(keepStatus = true)
        }
    }

    // Launched from a shortcut: open the sheet with that kind already chosen.
    // The sheet, not a silent start — a shortcut says WHAT kind of work, and the
    // brief still says what the work is. Skipping straight to a started session
    // would give back exactly the unnamed session this whole feature exists to
    // stop producing.
    LaunchedEffect(launchKindId) {
        if (launchKindId != null) {
            pendingKindId = launchKindId
            showStart = true
        }
    }

    if (showStart) {
        StartSheet(
            settings = settings,
            preselectedKindId = pendingKindId,
            onDismiss = {
                showStart = false
                pendingKindId = null
            },
            onStart = { request -> startInBackground(request) },
        )
    }

    if (showBin) {
        RecycleBinSheet(
            settings = settings,
            hosts = binHosts,
            onDismiss = { showBin = false },
            onChanged = { refresh(keepStatus = true) },
        )
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Fleetwright") },
                actions = {
                    TextButton(onClick = { refresh() }, enabled = !busy) { Text("Refresh") }
                    // THE BIN, WITH THE SESSIONS. It sat under each host's row
                    // in settings, because that is where the volumes live — an
                    // implementation detail leaking into the layout. Reachable
                    // when EMPTY too: a safety net nobody can find until they
                    // need it does not reassure anybody, and this one looked
                    // for a while like it did not exist.
                    val bin = binHosts.sumOf { it.bin.size }
                    TextButton(onClick = { showBin = true }) {
                        Text(if (bin > 0) "Bin ($bin)" else "Bin")
                    }
                    TextButton(onClick = { showSettings = !showSettings }) { Text("Settings") }
                },
            )
        },
        floatingActionButton = {
            if (settings.configured && !showSettings) {
                ExtendedFloatingActionButton(
                    text = { Text("New session") },
                    icon = {},
                    // Opens the sheet rather than starting immediately. The
                    // one-tap start is still there — leave it blank and press
                    // Start — but a session nobody described is one nobody
                    // recognises a week later.
                    onClick = { showStart = true },
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).fillMaxSize()) {

            if (showSettings) {
                SettingsPanel(settings) {
                    showSettings = false
                    // Signing in is what makes push registration possible at
                    // all — before it there is no credential to POST with — so
                    // this runs on the way out of settings rather than only at
                    // launch, which would leave a phone that signed in on its
                    // first run unregistered until its second.
                    onSignedIn()
                    refresh()
                }
                return@Column
            }

            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())

            if (status.isNotBlank()) {
                Card(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(status, Modifier.padding(12.dp), fontFamily = FontFamily.Monospace)
                }
            }

            if (sessions.isEmpty() && !busy) {
                Text(
                    "No sessions. Tap “New session” to start one.",
                    Modifier.padding(top = 24.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(sessions, key = { "${it.hostId}/${it.name}" }) { session ->
                    SessionCard(
                        session = session,
                        busy = busy,
                        onStop = {
                            scope.launch {
                                busy = true
                                status = fleet.stop(session.name).text
                                busy = false
                                refresh(keepStatus = true)
                            }
                        },
                        onForget = {
                            scope.launch {
                                busy = true
                                status = fleet.forget(session.name).text
                                busy = false
                                refresh(keepStatus = true)
                            }
                        },
                        onAnswer = { option ->
                            scope.launch {
                                busy = true
                                status = fleet.answer(session.name, option, session.prompt?.id).text
                                busy = false
                                refresh(keepStatus = true)
                            }
                        },
                        // Peek deliberately does NOT refresh afterwards: the
                        // pane output IS the answer, and a refresh a moment
                        // later would wipe it off the screen.
                        onPeek = {
                            scope.launch {
                                busy = true
                                status = fleet.peek(session.name).text
                                busy = false
                            }
                        },
                        onResume = {
                            scope.launch {
                                busy = true
                                status = fleet.resume(session.name, "summary").text
                                busy = false
                                refresh(keepStatus = true)
                            }
                        },
                        onOpen = { url ->
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionCard(
    session: Fleet.Session,
    busy: Boolean,
    onStop: () -> Unit,
    onResume: () -> Unit,
    onForget: () -> Unit,
    onAnswer: (Int) -> Unit,
    onPeek: () -> Unit,
    onOpen: (String) -> Unit,
) {
    var confirmingForget by remember { mutableStateOf(false) }
    if (confirmingForget) {
        AlertDialog(
            onDismissRequest = { confirmingForget = false },
            title = { Text("Forget ${session.label}?") },
            // Confirmed where stop is not, because stop is reversible by
            // resume and forget is reversible by nothing: the conversation and
            // the workspace are both deleted.
            text = { Text("This deletes its conversation and workspace. It cannot be undone.") },
            confirmButton = {
                TextButton(onClick = { confirmingForget = false; onForget() }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { confirmingForget = false }) { Text("Cancel") } },
        )
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // The title is what a person recognises; the name is the
                // identity everything else keys on, so both are shown when they
                // differ rather than hiding one.
                Text(session.label, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.weight(1f))
                // Colour AND the word, never colour alone: the label is what
                // carries the meaning and the tint only reinforces it, which is
                // what "differentiate without colour" asks for and is also just
                // legible to everybody else.
                val tint = statusColour(session.status)
                AssistChip(
                    onClick = {},
                    label = { Text(session.status) },
                    colors = AssistChipDefaults.assistChipColors(
                        labelColor = tint,
                        leadingIconContentColor = tint,
                    ),
                )
            }
            if (session.label != session.name) {
                Text(session.name, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
            // Where, how long, and whose account — the three questions about a
            // session somebody started yesterday. One line, secondary: context
            // rather than the point. The account is hidden when it is
            // "shared", because on a fleet where nobody has linked one it
            // would say the same thing on every row and mean nothing.
            val context = listOfNotNull(
                session.hostId?.let { "on $it" },
                session.workspace,
                session.age,
                session.account?.takeIf { it != "shared" },
            )
            if (context.isNotEmpty()) {
                Text(context.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            }
            // WHAT IT IS ASKING, and the answer as buttons. Reading a
            // question on a phone and being unable to answer it is the shape
            // of the problem, not a smaller version of it. The options are the
            // ones the HOST published; an ordinal is sent, never text.
            session.prompt?.let { prompt ->
                if (prompt.options.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        prompt.question?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        prompt.options.forEach { option ->
                            TextButton(onClick = { onAnswer(option.index) }, enabled = !busy) {
                                Text("${option.index}  ${option.label}")
                            }
                        }
                    }
                } else {
                    Text(
                        "Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onPeek, enabled = !busy) { Text("Peek") }
                if (session.status == "running") {
                    TextButton(onClick = onStop, enabled = !busy) { Text("Stop") }
                    session.rcUrl?.let { url ->
                        // The reason Remote Control is worth surfacing at all:
                        // this is the button that turns a notification into
                        // actually driving the session.
                        TextButton(onClick = { onOpen(url) }) { Text("Open") }
                    }
                } else if (session.resumable) {
                    TextButton(onClick = onResume, enabled = !busy) { Text("Resume") }
                }
                if (session.status != "running") {
                    TextButton(onClick = { confirmingForget = true }, enabled = !busy) { Text("Forget") }
                }
            }
        }
    }
}

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
private fun SettingsPanel(settings: Settings, onDone: () -> Unit) {
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
    var hosts by remember { mutableStateOf(listOf<Fleet.Host>()) }
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

    LaunchedEffect(signedIn) { hosts = enrolledHosts(settings) }

    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Coordinator", style = MaterialTheme.typography.titleMedium)
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

        HorizontalDivider(Modifier.padding(vertical = 12.dp))

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
        var rebootTarget by remember { mutableStateOf<String?>(null) }
        // Deleting for good is the one action here with no undo left, so it
        // asks once. `forget` deliberately does not ask, because it is now
        // reversible — a confirmation on the reversible action and none on the
        // permanent one is how people learn to tap through both.
        var rebootPin by remember { mutableStateOf("") }
        var rebootConfirm by remember { mutableStateOf("") }
        var credentialsFor by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(settings.configured) {
            if (settings.configured) fleetHosts = Fleet(settings).fleetHosts()
        }
        credentialsFor?.let { target ->
            CredentialsSheet(settings, target, onDismiss = { credentialsFor = null })
        }
        if (fleetHosts.isNotEmpty()) {
            Text("Fleet", style = MaterialTheme.typography.titleMedium)
            fleetHosts.forEach { host ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(host.hostId, fontFamily = FontFamily.Monospace)
                        // Colour reinforces the word; it never carries the
                        // meaning alone.
                        Text(
                            host.state ?: "unknown",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (host.state == "healthy") MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.error,
                        )
                    }
                    // The registry works to make "we don't know"
                    // unrepresentable as a benign value; rendering its
                    // sentence verbatim is what makes that visible.
                    host.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    if (host.accountEmail != null) {
                        val bits = listOfNotNull("signed in as ${host.accountEmail}", host.accountPlan, host.accountOrg)
                        Text(bits.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                    } else if (host.loggedIn == false) {
                        // The single most common cause of a session that
                        // starts and then does nothing.
                        Text(
                            "NOT signed in — sessions will not start",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    host.version?.let { head ->
                        val behind = host.behind ?: 0
                        val text = if (behind > 0) "running $head · $behind behind" else "running $head · up to date"
                        Text(text, style = MaterialTheme.typography.bodySmall)
                    }
                    // WHAT THE OS HAS WAITING. The host has been sending this
                    // since maintenance shipped and nothing displayed it, which
                    // is why upgrade looked like a verb that could only report.
                    host.systemUpdates?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
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
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            enabled = busyHost == null,
                            onClick = {
                                scope.launch {
                                    busyHost = host.hostId
                                    // The check is `upgrade` with apply off —
                                    // the verb's own reporting mode.
                                    hostActionResult = Fleet(settings).upgrade(host.hostId).text
                                    busyHost = null
                                    fleetHosts = Fleet(settings).fleetHosts()
                                }
                            },
                        ) { Text("Check") }
                        if (host.appPending) {
                            TextButton(
                                enabled = busyHost == null,
                                onClick = {
                                    scope.launch {
                                        busyHost = host.hostId
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
                    }
                }
            }
            // TWO STEPS, and the second one asks for the hostname typed out.
            // The pin is issued by the BOX: a coordinator that could mint it
            // could reboot the fleet. The button stays disabled until the typed
            // name matches, which is the only guard that survives being remote.
            rebootTarget?.let { target ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
        }

        // Assistant setup, above the account section: this is the thing people
        // come back to settings for, and sign-in is the thing they do once.
        var showKinds by remember { mutableStateOf(false) }
        Text("Siri and Assistant", style = MaterialTheme.typography.titleMedium)
        Text(
            "A kind is a word you can say — \"start a dev session\" — carrying its own defaults. "
                + "Adding one here is the whole setup: nothing else to install or paste.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedButton(onClick = { showKinds = true }) { Text("Session kinds") }
        if (showKinds) KindsSheet(onDismiss = { showKinds = false })

        HorizontalDivider(Modifier.padding(vertical = 12.dp))

        Text("You", style = MaterialTheme.typography.titleMedium)
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
            HorizontalDivider(Modifier.padding(vertical = 12.dp))

            // Adding a machine. This is the second thing anybody does after
            // signing in, and the pin is the whole of how a host joins now —
            // there is no shared token to copy onto the box.
            Text("Hosts", style = MaterialTheme.typography.titleMedium)
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        pin = runCatching { Fleet(settings).mintHostPin() }
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
                Text(
                    "On that box:  agent-fleet-sidecar enrol $pin\nGood for ten minutes, once.",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }

            for (host in hosts) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
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
        HorizontalDivider(Modifier.padding(vertical = 12.dp))
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
            Text(pushResult, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

/**
 * A colour per session state, as reinforcement only.
 *
 * Every caller shows the status word beside it. Nothing in this app is
 * distinguishable by colour alone, which matters for the eight percent of men
 * with a colour vision deficiency and for anybody using the phone outdoors.
 */
@Composable
private fun statusColour(status: String): Color = when (status) {
    "running" -> MaterialTheme.colorScheme.primary
    "awaiting-input" -> MaterialTheme.colorScheme.error
    "stopped" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
