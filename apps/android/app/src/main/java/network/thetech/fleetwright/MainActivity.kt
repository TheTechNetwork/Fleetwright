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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.google.firebase.installations.FirebaseInstallations
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
     * all. Messaging.onRegistered covers rotation in between.
     *
     * THE FIREBASE INSTALLATION ID, not an FCM registration token. FCM is
     * moving to addressing a message by FID, and firebase-messaging 25.1.0
     * deprecated getToken along with onNewToken. FirebaseInstallations is where
     * that value comes from and is not deprecated.
     *
     * Silent when the app has no coordinator yet — there is nowhere to send it,
     * and an error about that on first launch would be noise in front of the
     * settings screen the person is about to fill in.
     */
    private fun registerForPush() {
        val settings = Settings(applicationContext)
        if (!settings.configured) return
        FirebaseInstallations.getInstance().id.addOnCompleteListener { task ->
            val token = task.result
            if (!task.isSuccessful || token.isNullOrBlank()) {
                Log.w("Fleetwright", "no Firebase installation ID: ${task.exception?.message}")
                return@addOnCompleteListener
            }
            lifecycleScope.launch {
                runCatching { Fleet(settings).registerDevice(token) }
                    .onFailure { Log.w("Fleetwright", "could not register for push: ${it.message}") }
            }
        }
    }

    /**
     * Coming back from a provider.
     *
     * `singleTask` means the redirect resumes THIS activity rather than
     * stacking a second copy, so the callback arrives here and not in
     * onCreate. The manifest has claimed `fleetwright://connected` since the
     * GitHub App round and nothing consumed it, which is why the screen that
     * started the flow needed a "Done" button: the app was being told by hand
     * about a callback it had already received and dropped.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        WebAuth.deliver(intent)
        notifiedSession.value = sessionNamedBy(intent)
    }

    /**
     * The session a tapped notification was about, or null.
     *
     * FCM delivers a tray notification's `data` keys as extras on the launcher
     * intent when the tap opens the app, so this needs no PendingIntent of its
     * own: the coordinator sends `event`, `name` and `hostId` beside every
     * notification for exactly this. Until this existed a tap opened the app
     * to whatever was on screen last — the settings, as often as not — and
     * the session that had just asked was two taps further on.
     *
     * A value, not a fact: the list is refreshed from the coordinator, and a
     * name that is no longer there is simply not there.
     */
    private val notifiedSession = mutableStateOf<String?>(null)

    private fun sessionNamedBy(intent: Intent?): String? {
        if (intent?.hasExtra("event") != true) return null
        return intent.getStringExtra("name")?.takeIf { it.isNotBlank() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // A SCREENSHOT RUN STARTS ON THE DEMO, so the pictures show a fleet
        // rather than an empty state with a Connect button. Debug builds only —
        // see Screenshots.kt for why Android has to be stricter here than iOS.
        //
        // ONLY HERE, not in onNewIntent, which carries the same two lines
        // below. Seeding is a launch-time act: doing it per Intent would
        // rewrite somebody's coordinator and credential every time a
        // notification opened the app.
        if (Screenshots.seedIfAsked(intent, Settings(this))) {
            Log.i("Fleetwright", "screenshots: seeded onto ${Demo.LABEL}")
        }

        // The cold-start case: the app was not running when the browser
        // redirected, so the callback is the launch Intent rather than a new
        // one. Same delivery, and the flow filters anything that is not ours.
        WebAuth.deliver(intent)
        notifiedSession.value = sessionNamedBy(intent)

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
            // in the hand. It was then dynamic colour — the wallpaper's palette —
            // which fixed the white screen and cost the app any colour of its
            // own: the same screen came out teal on one phone and mauve on
            // another, none of it agreed with the console, and "amber means
            // something is waiting for you" cannot be true when amber is
            // whatever the wallpaper had.
            //
            // FleetwrightTheme is the palette, the type scale and the radius
            // hierarchy from Design.kt, which is the same table the console and
            // the iOS app are built from.
            FleetwrightTheme {
                FleetScreen(
                    onSignedIn = ::registerForPush,
                    // Read once, from the intent that started this activity. A
                    // shortcut tap is the only thing that sets it.
                    launchKindId = intent?.getStringExtra(SessionKinds.EXTRA_KIND_ID),
                    notifiedSession = notifiedSession.value,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(onSignedIn: () -> Unit = {}, launchKindId: String? = null, notifiedSession: String? = null) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val outbox = remember { Outbox(context) }
    val fleet = remember { Fleet(settings, outbox) }
    // What is waiting, so the pending row can say how many.
    var pending by remember { mutableStateOf(outbox.held.size) }
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
    /** The session whose workspace is open, if any. */
    var browsing by remember { mutableStateOf<Fleet.Session?>(null) }

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
            // AFTER EVERY REFRESH, because a command held a moment ago must
            // show up without waiting for the next flush. Every action on this
            // screen refreshes when it finishes, so this is the one place that
            // sees both a queue that grew and a queue that drained.
            pending = outbox.held.size
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
        // SAID DIFFERENTLY WHEN IT HAS NOTHING TO DO, because "ready" reads as
        // "working" and only one of these is. A session with no profile is
        // waiting for a person, and somebody who walks away expecting output
        // comes back to an empty prompt.
        status = if (request.profile == null) {
            "Starting a session. It will come up idle, waiting for you."
        } else {
            "Starting a session. You will get a notification when it is ready."
        }
        scope.launch {
            val text = try {
                val reply = fleet.start(
                    title = request.title,
                    brief = request.brief,
                    mode = request.mode,
                    host = request.host,
                    profile = request.profile,
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

    // A tapped notification lands on the sessions, whatever was showing when
    // the phone was put down, and the list is the fleet now rather than the
    // fleet when it went in a pocket.
    LaunchedEffect(notifiedSession) {
        if (notifiedSession != null) {
            showSettings = false
            refresh()
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

    browsing?.let { session ->
        FilesSheet(
            fleet = fleet,
            session = session.name,
            // The host explicitly: a session lives on ONE box, and a browse
            // that fanned out would read a directory that exists on two
            // machines with different contents in it.
            host = session.hostId,
            onDismiss = { browsing = null },
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

    // FLUSHED ON EVERY REFRESH, which is the moment we have just learned the
    // fleet answers. Not on a timer: a timer retries into an outage, and the
    // refresh already happens when the app is opened, pulled, or comes back.
    LaunchedEffect(Unit) {
        refresh()
        val sent = outbox.flush { entry ->
            runCatching {
                val reply = fleet.resend(entry)
                // A REFUSAL COUNTS AS DELIVERED. The fleet answered — "that
                // session is gone", "you cannot stop that" — and holding a
                // command the fleet has already judged would retry it forever.
                if (!reply.ok) status = reply.text
            }
        }
        pending = outbox.held.size
        // One extra refresh if anything landed, and only here: flush is not
        // called from refresh on this side, so there is no recursion to break.
        if (sent > 0) refresh(keepStatus = true)
    }

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
        Column(
            Modifier
                .padding(padding)
                .padding(horizontal = Design.Space.page, vertical = Design.Space.groupTight)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(Design.Space.groupTight),
        ) {

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

            // FIRST, ALWAYS, ABOVE THE LIST. docs/psychology.md names
            // "nothing needs you" as the most important state in the system
            // and neither app said it: a list of rows is not that, because
            // reading five rows and concluding none of them is asking anything
            // is work somebody redoes every time they open the app — which is
            // the loop the anxiety runs in.
            ReassuranceBanner(Reassurance.of(sessions, binHosts))

            if (status.isNotBlank()) {
                // Evidence quoted from somewhere else, so it sits on an inner
                // surface rather than on a card of its own — it should not look
                // like something this screen said.
                Text(
                    status,
                    Modifier
                        .fillMaxWidth()
                        .fleetCard(radius = Design.Radius.row, fill = Design.Palette.inner.now)
                        .padding(Design.Space.inside),
                    fontFamily = FontFamily.Monospace,
                    style = Design.Style.label,
                    color = Design.Palette.ink.now,
                )
            }

            // WHAT IS WAITING, because a queue nobody can see is not a queue —
            // it is a surprise arriving later. The count is enough here: the
            // commands say what they are when they land, and a list of them on
            // the main screen would be a second inbox to read.
            if (pending > 0) {
                Text(
                    if (pending == 1) "1 command is held on this phone and will be sent when the fleet answers."
                    else "$pending commands are held on this phone and will be sent when the fleet answers.",
                    Modifier
                        .fillMaxWidth()
                        .fleetCard(radius = Design.Radius.row, fill = Design.Palette.inner.now)
                        .padding(Design.Space.inside),
                    style = Design.Style.bodySmall,
                    color = Design.Palette.inkDim.now,
                )
            }

            if (sessions.isEmpty() && !busy) {
                Column(
                    Modifier.padding(top = Design.Space.group),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    Text("No sessions", style = Design.Style.section, color = Design.Palette.ink.now)
                    Text(
                        "Nothing is running on any machine in this fleet. Tap “New session” to start one.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.inkDim.now,
                    )
                }
            }

            LazyColumn(verticalArrangement = Arrangement.spacedBy(Design.Space.groupTight)) {
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
                        onFiles = { browsing = session },
                        // Like Peek, and for the same reason: the output IS
                        // the answer, and a refresh a moment later would wipe
                        // it off the screen.
                        onOutput = {
                            scope.launch {
                                busy = true
                                status = fleet.logs(session.hostId, session = session.name).text
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
    onFiles: () -> Unit,
    /**
     * What the session SAID, as against what it looks like now: the
     * container's output, which outlives the pane. The reason a session died
     * is here and nowhere else once its window is gone.
     */
    onOutput: () -> Unit,
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
    // NO BORDER, AND A RING THAT MEANS SOMETHING. Material's Card draws a
    // filled box; the design says a card is separated by being lifted off the
    // page, not by being outlined. The one card that wears a tone is the one
    // asking a question — which is the only card on this screen a person has to
    // find in a hurry.
    val ring = if (session.prompt != null) Design.Palette.attention.now else Design.Palette.ring.now
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = ring)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // The title is what a person recognises; the name is the
            // identity everything else keys on, so both are shown when they
            // differ rather than hiding one.
            Text(
                session.label,
                style = Design.Style.bodyStrong,
                color = Design.Palette.ink.now,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            // Colour AND the word, never colour alone: the label is what
            // carries the meaning and the tint only reinforces it, which is
            // what "differentiate without colour" asks for and is also just
            // legible to everybody else.
            //
            // A chip drawn by hand rather than an AssistChip: the Material
            // chip is a 32dp pill with its own outline and its own idea of
            // padding, and three of the design's rules had to be argued
            // with to get one line of text out of it.
            Text(
                session.status,
                Modifier
                    .background(
                        Design.Palette.inner.now,
                        RoundedCornerShape(Design.Radius.chip),
                    )
                    .padding(horizontal = Design.Space.insideTight, vertical = Design.Space.hair),
                style = Design.Style.label,
                color = statusColour(session.status),
            )
        }
        if (session.label != session.name) {
            Text(
                session.name,
                style = Design.Style.micro,
                fontFamily = FontFamily.Monospace,
                color = Design.Palette.inkDim.now,
            )
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
            Text(
                context.joinToString(" · "),
                style = Design.Style.micro,
                color = Design.Palette.inkDim.now,
            )
        }
        // HOW LONG IT HAS BEEN QUIET. "Running" was doing two jobs: a
        // session mid-build and one that has not moved since Tuesday
        // looked identical, and the difference is the whole question
        // somebody opens this app to ask. Null under five minutes, so a
        // working session never wears it.
        session.quietFor?.let {
            Text(it, style = Design.Style.micro, color = Design.Palette.inkDim.now)
        }
        // WHAT IT IS ASKING, and the answer as buttons. Reading a
        // question on a phone and being unable to answer it is the shape
        // of the problem, not a smaller version of it. The options are the
        // ones the HOST published; an ordinal is sent, never text.
        session.prompt?.let { prompt ->
            if (prompt.options.isNotEmpty()) {
                Column(
                    Modifier.padding(top = Design.Space.insideTight),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    // THE QUESTION IS THE TITLE HERE. It is why the
                    // notification arrived and why this card is at the top
                    // of the list; setting it in the same size as the
                    // card's own metadata was the app burying its own
                    // headline.
                    prompt.question?.let {
                        Text(it, style = Design.Style.title, color = Design.Palette.ink.now)
                    }
                    prompt.options.forEach { option ->
                        // A row, not a TextButton: 48dp of target whatever
                        // the label's length, on the control this whole
                        // notification exists to offer.
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(Design.Radius.row))
                                .clickable(enabled = !busy) { onAnswer(option.index) }
                                .background(Design.Palette.inner.now)
                                .border(
                                    1.dp,
                                    Design.Palette.ring.now,
                                    RoundedCornerShape(Design.Radius.row),
                                )
                                .heightIn(min = 48.dp)
                                .padding(horizontal = Design.Space.inside),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            // The ordinal, because an ordinal is what is
                            // sent — the label never leaves the box.
                            Text(
                                "${option.index}",
                                Modifier
                                    .background(
                                        Design.Palette.track.now,
                                        RoundedCornerShape(Design.Radius.chip),
                                    )
                                    .padding(horizontal = Design.Space.insideTight),
                                style = Design.Style.label,
                                fontFamily = FontFamily.Monospace,
                                color = Design.Palette.inkDim.now,
                            )
                            Text(
                                option.label,
                                style = Design.Style.bodySmall,
                                color = Design.Palette.ink.now,
                            )
                        }
                    }
                }
            } else {
                Text(
                    "Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.inkDim.now,
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            TextButton(onClick = onPeek, enabled = !busy) { Text("Peek") }
            // THE WORKSPACE, on running and stopped sessions alike. The
            // volume survives a stop — that is what makes a session
            // resumable — so "collect what it produced" is a thing to do
            // AFTER the work has finished, which is most of the time.
            TextButton(onClick = onFiles, enabled = !busy) { Text("Files") }
            // ITS OUTPUT, on running and stopped sessions alike, and for the
            // same reason as Files: "why did it stop" is a question asked
            // after it has.
            TextButton(onClick = onOutput, enabled = !busy) { Text("Output") }
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

/**
 * A colour per session state, as reinforcement only.
 *
 * Every caller shows the status word beside it. Nothing in this app is
 * distinguishable by colour alone, which matters for the eight percent of men
 * with a colour vision deficiency and for anybody using the phone outdoors.
 */
@Composable
private fun statusColour(status: String): Color = when (status) {
    // `active`, not the accent: the accent means "you can tap this", and a
    // status is not an action. A badge that borrows it teaches it two meanings.
    "running" -> Design.Palette.active.now
    "awaiting-input" -> Design.Palette.attention.now
    "ended" -> Design.Palette.ok.now
    else -> Design.Palette.idle.now
}
