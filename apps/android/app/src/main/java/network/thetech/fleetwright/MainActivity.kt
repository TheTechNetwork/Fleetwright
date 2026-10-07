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
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.ui.semantics.Role
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.google.firebase.FirebaseApp
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
     *
     * AND SILENT WHEN THERE IS NO FIREBASE, which used to be a crash.
     * `FirebaseInstallations.getInstance()` reaches for the default FirebaseApp
     * and THROWS when there is not one —
     *
     *     IllegalStateException: Default FirebaseApp is not initialized in this
     *     process network.thetech.fleetwright. Make sure to call
     *     FirebaseApp.initializeApp(Context) first.
     *
     * — which arrived as a fatal from a Play install on 0.2.3+441, and arrived
     * at the worst possible moment. This runs twice: once from `onCreate`,
     * where an unconfigured app returns at the line above without touching
     * Firebase, and once from `onSignedIn`. So the first launch survives, the
     * person fills the settings in, signs in, and the app dies on the last tap
     * of its own onboarding.
     *
     * THERE ARE TWO WAYS TO HAVE NO DEFAULT APP and this repository deliberately
     * ships one of them. `app/build.gradle.kts` applies the Google Services
     * plugin only `if (file("google-services.json").exists())`, so that a fork
     * or a self-hoster can build at all — "push simply does nothing for them,
     * which is the honest outcome rather than a broken build" is the comment
     * there, and it was not true: nothing was doing nothing, this line was
     * killing the app. The other way is the provider that normally does this
     * not having run, which is what a virtualised or cloned app container does
     * to a manifest's ContentProviders.
     *
     * `FirebaseApp.initializeApp` RATHER THAN A try/catch, because it answers
     * both. It is idempotent and returns the app that is already there when the
     * provider did its job; it initialises one when the provider did not, which
     * REPAIRS the second case rather than merely surviving it; and it returns
     * null rather than throwing when there is genuinely no configuration to
     * read, which is the fork, and is the one case where doing nothing is
     * right. A catch would have turned all three into the same shrug.
     *
     * Not fatal, and not hidden either: a fleet app that cannot wake you is
     * still a fleet app you can read, and "Send a test notification" in the
     * settings is where somebody finds out that it cannot — which is the answer
     * this screen already had for a registration that never arrived.
     */
    private fun registerForPush() {
        val settings = Settings(applicationContext)
        if (!settings.configured) return
        val firebase = FirebaseApp.initializeApp(applicationContext)
        if (firebase == null) {
            Log.w("Fleetwright", "no Firebase configuration in this build, so push is off")
            return
        }
        FirebaseInstallations.getInstance(firebase).id.addOnCompleteListener { task ->
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
        notifiedHost.value = hostNamedBy(intent)
        notifiedSetup.value = setupNamedBy(intent)
    }

    /**
     * The hypervisor setup a tapped progress notification was about
     * (XoSetupNotice), by job, or null. Opens Machines on its progress.
     */
    private val notifiedSetup = mutableStateOf<String?>(null)

    private fun setupNamedBy(intent: Intent?): String? {
        if (intent?.getStringExtra(XoSetupNotice.EXTRA_KIND) != XoSetupNotice.KIND) return null
        return intent.getStringExtra(XoSetupNotice.EXTRA_JOB)?.takeIf { XoSetup.JOB_RE.matches(it) }
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
        if (intent.getStringExtra("event").orEmpty().startsWith("host.")) return null
        return intent.getStringExtra("name")?.takeIf { it.isNotBlank() }
    }

    /**
     * The machine a tapped notification was about, for a host event. "deb132
     * cannot start sessions" used to land on the session list, two screens and
     * a scroll from the page that could do something about it.
     */
    private val notifiedHost = mutableStateOf<String?>(null)

    private fun hostNamedBy(intent: Intent?): String? {
        if (intent?.getStringExtra("event")?.startsWith("host.") != true) return null
        return intent.getStringExtra("hostId")?.takeIf { it.isNotBlank() }
    }

    /**
     * Android 13+ shows nothing until this is granted. Asked once there is a
     * fleet to be notified about: asking on a first launch, before anything is
     * set up, is asking for a permission nobody can yet see a reason for.
     */
    private fun askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
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
        notifiedHost.value = hostNamedBy(intent)
        notifiedSetup.value = setupNamedBy(intent)

        // A fleet app that cannot tell you a session is waiting has lost its
        // main reason to exist, so this is asked as soon as there is a fleet.
        if (Settings(this).configured) askForNotificationsOnce()

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
                    onSignedIn = {
                        askForNotificationsOnce()
                        registerForPush()
                    },
                    // Read once, from the intent that started this activity. A
                    // shortcut tap is the only thing that sets it.
                    launchKindId = intent?.getStringExtra(SessionKinds.EXTRA_KIND_ID),
                    notifiedSession = notifiedSession.value,
                    notifiedHost = notifiedHost.value,
                    notifiedSetup = notifiedSetup.value,
                )
            }
        }
    }
}

/**
 * The app, as three places rather than one screen with a panel on top.
 *
 * It was a session list with everything else behind a Settings button that
 * swapped the list for an 1,100-line panel: the build number, the coordinator
 * URL, every host card with six buttons on it, Siri, People, the sign-in, the
 * pin, the runner repository, this phone's GitHub sign-in, the vault, a
 * temporary machine, runner tokens, the same hosts again, devices, activity,
 * and a test notification. Every other screen was a dialog on top of that.
 *
 * Three places, one job each, the same three as iOS:
 *
 *   Sessions   what is running, and answering what is asking
 *   Machines   is each machine well, and doing something about one
 *   You        who you are here, what your sessions may use, and setup
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    onSignedIn: () -> Unit = {},
    launchKindId: String? = null,
    notifiedSession: String? = null,
    notifiedHost: String? = null,
    notifiedSetup: String? = null,
) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val outbox = remember { Outbox(context) }
    val fleet = remember { Fleet(settings, outbox) }
    // What is waiting, so the pending row can say how many.
    var pending by remember { mutableStateOf(outbox.held.size) }
    val scope = rememberCoroutineScope()

    // rememberSaveable, not remember: a rotation destroys and recreates the
    // activity, and plain `remember` state does not survive that. An
    // unconfigured app opens on You, where the fleet's address and the sign-in
    // now sit together.
    var tab by rememberSaveable { mutableStateOf(if (settings.configured) "sessions" else "you") }
    var signedIn by remember { mutableStateOf(settings.configured) }
    // WHETHER THIS PERSON IS AN ADMIN. Null is cannot tell (not asked yet, or a
    // coordinator too old to say), and admin-only rows are drawn only for true:
    // a member never meets a control that only answers "needs an admin".
    var admin by remember { mutableStateOf<Boolean?>(null) }
    // An admin viewing the fleet as a member: every request says so and the
    // coordinator answers it as a member's (see Settings.viewAsMember).
    var viewAsMember by remember { mutableStateOf(settings.viewAsMember) }
    val showsAdmin = admin == true && !viewAsMember
    // The machine a notification or the reassurance line asked to open.
    var openHost by remember { mutableStateOf<String?>(null) }
    var showStart by rememberSaveable { mutableStateOf(false) }
    var showActivity by rememberSaveable { mutableStateOf(false) }
    // The kind a launcher shortcut asked for, consumed once.
    var pendingKindId by rememberSaveable { mutableStateOf<String?>(null) }
    var status by rememberSaveable { mutableStateOf("") }
    // The session list is deliberately NOT saved: it is a cache of what the
    // coordinator said, and a stale list restored across a rotation would show
    // sessions that may since have stopped.
    var sessions by remember { mutableStateOf(listOf<Fleet.Session>()) }
    // Hosts, for the bin — which is fleet-wide and therefore needs them all.
    var binHosts by remember { mutableStateOf(listOf<Fleet.FleetHost>()) }
    var showBin by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    /** The session whose workspace is open, if any. */
    var browsing by remember { mutableStateOf<Fleet.Session?>(null) }
    // The session whose sheet is open: the state sentence, the pane watched,
    // Files, Output and Forget.
    var inspecting by remember { mutableStateOf<Fleet.Session?>(null) }
    // Whether this person's Claude login is kept for their runners (ClaudeSetup.kt).
    var claude by remember { mutableStateOf<ClaudeKept?>(null) }
    var claudePutOff by remember { mutableStateOf(settings.claudeSetupPutOff) }
    var settingUpClaude by remember { mutableStateOf(false) }
    // A Claude sign-in asked for from the empty list, on the machine picked.
    var connectingOn by remember { mutableStateOf<String?>(null) }
    // Whether THIS PERSON has Claude anywhere. Null until asked, and asked only
    // when there is nothing to show: "we have not asked" and "asked, and
    // nobody" stay different, and only the second is a setup step.
    var haveClaude by remember { mutableStateOf<Boolean?>(null) }

    /**
     * @param keepStatus keep whatever is already on screen if the list call
     *   succeeds. Set after an action, whose reply text is the only
     *   confirmation the coordinator ever gives.
     */
    val haptic = LocalHapticFeedback.current
    val reduced = Design.Motion.reduced()

    suspend fun reload(keepStatus: Boolean = false) {
        if (!settings.configured) return
        busy = true
        val reply = fleet.list()
        sessions = reply.sessions
        // A failure is shown, never swallowed: "nothing here" and "I could
        // not reach the coordinator" look identical otherwise.
        status = if (!reply.ok) reply.text.said() else if (keepStatus) status else ""
        // THE BIN'S CONTENTS, which `list` does not carry. Falls back to what
        // we already had: a fleet call that fails must not blank the list.
        binHosts = runCatching { fleet.fleetHosts() }.getOrDefault(binHosts)
        if (sessions.isEmpty() && binHosts.isNotEmpty()) {
            runCatching { fleet.connections() }.getOrNull()?.connections?.let { c ->
                haveClaude = c.linked("claude") != null
            }
        }
        pending = outbox.held.size
        busy = false
    }

    fun refresh(keepStatus: Boolean = false) {
        scope.launch { reload(keepStatus) }
    }

    /**
     * Run one verb and quote what came back, then re-list.
     *
     * FELT, NOT ONLY SEEN. Stop, Resume and an answer each say in the hand
     * whether the fleet took them, and a refusal feels different from a yes:
     * the quoted reply is at the top of a list read at arm's length at night.
     */
    fun act(work: suspend () -> Fleet.Reply) {
        scope.launch {
            busy = true
            val reply = work()
            status = reply.text.said()
            haptic.performHapticFeedback(if (reply.ok) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
            busy = false
            reload(keepStatus = true)
        }
    }

    /**
     * Start a session without making anybody watch it happen. THE SHEET
     * CLOSES ON TAP, and the coroutine is owned HERE, because a job scoped to a
     * dismissed composable is one that may not finish.
     */
    fun startInBackground(request: StartRequest) {
        // ON A MACHINE THAT DOES NOT EXIST YET. The coordinator holds the
        // session with the dispatch and starts it when the runner joins.
        request.platform?.let { platform ->
            val label = request.imageLabel ?: newMachineChoices.firstOrNull { it.platform == platform }?.label ?: "New machine"
            val lowered = label.replaceFirstChar { it.lowercase() }
            status = if (platform == "lab") {
                "Asking your hypervisor for a $lowered, in a lab of its own. The session starts on it when it joins."
            } else if (platform == "vm") {
                "Asking your hypervisor for a $lowered. The session starts on it when it joins."
            } else {
                "Asking GitHub for a $lowered. The session starts on it when it joins."
            }
            val start = buildMap {
                request.title?.let { put("title", it) }
                request.brief?.let { put("brief", it) }
                request.mode?.let { put("mode", it) }
                request.task?.let { put("task", it) }
            }
            scope.launch {
                val reply = fleet.provision(platform, minutes = request.minutes, start = start, template = request.template, network = request.network, group = request.group)
                val text = reply.text.ifBlank { "Asked for it." }
                LocalNotice.post(context, if (reply.ok) "Machine on its way" else "Could not ask for a machine", text)
                status = text
                reload(keepStatus = true)
            }
            return
        }
        // SAID DIFFERENTLY WHEN IT HAS NOTHING TO DO: a session with no profile
        // is waiting for a person.
        status = if (request.profile == null && request.task == null) {
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
                    secret = request.secret,
                    task = request.task,
                )
                // BY WHAT THE FLEET SAID, not by whether it answered: a refusal
                // is an answer, and "Session ready" over "unknown (connected, no
                // health report yet)" sent somebody looking for a session that
                // did not exist.
                LocalNotice.post(context, if (reply.ok) "Session ready" else "Could not start a session", reply.text.ifBlank { "Started." })
                reply.text.ifBlank { "Started." }
            } catch (e: Exception) {
                // A TIMEOUT IS NOT A FAILURE: `start` carries an idempotency
                // key, so the session may well exist.
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
            reload(keepStatus = true)
        }
    }

    // Launched from a shortcut: open the sheet with that kind already chosen.
    LaunchedEffect(launchKindId) {
        if (launchKindId != null) {
            pendingKindId = launchKindId
            tab = "sessions"
            showStart = true
        }
    }

    // A tapped notification lands where it is about: the session's sheet, or
    // a machine's page for a host event.
    LaunchedEffect(notifiedSession) {
        if (notifiedSession != null) {
            tab = "sessions"
            refresh()
        }
    }
    LaunchedEffect(notifiedHost) {
        if (notifiedHost != null) {
            openHost = notifiedHost
            tab = "machines"
        }
    }
    // A hypervisor setup's progress notification, tapped: Machines, with the
    // job's progress open, rather than whatever was on screen last.
    var openSetup by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(notifiedSetup) {
        if (notifiedSetup != null) {
            openSetup = notifiedSetup
            tab = "machines"
        }
    }
    // AND THE SESSION THE NOTIFICATION WAS ABOUT IS OPENED, once per tap,
    // from the fresh list once it has arrived and still holds the name.
    var openedFor by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(notifiedSession, sessions) {
        if (notifiedSession != null && notifiedSession != openedFor) {
            sessions.firstOrNull { it.name == notifiedSession }?.let {
                inspecting = it
                openedFor = notifiedSession
            }
        }
    }

    // FLUSHED ON EVERY SIGN-IN AND LAUNCH, which is the moment we learn the
    // fleet answers. Not on a timer: a timer retries into an outage.
    LaunchedEffect(signedIn, viewAsMember) {
        admin = if (signedIn) fleet.me().getOrNull() else null
        claude = if (signedIn) claudeKept(settings) else null
        if (!signedIn) {
            sessions = emptyList()
            binHosts = emptyList()
            return@LaunchedEffect
        }
        reload()
        val sent = outbox.flush { entry ->
            runCatching {
                val reply = fleet.resend(entry)
                // A REFUSAL COUNTS AS DELIVERED: the fleet answered.
                if (!reply.ok) status = reply.text.said()
            }
        }
        pending = outbox.held.size
        if (sent > 0) reload(keepStatus = true)
        // A token a finished hypervisor setup handed back while the app was
        // closed is collected now (XoHandoff).
        XoHandoff.collectPending(settings, fleet)
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
            // The host explicitly: a session lives on ONE box.
            host = session.hostId,
            onDismiss = { browsing = null },
        )
    }
    if (settingUpClaude) {
        ClaudeSetupScreen(settings, onDismiss = {
            settingUpClaude = false
            scope.launch { claude = claudeKept(settings) }
        })
    }
    inspecting?.let { session ->
        SessionSheet(
            fleet = fleet,
            initial = session,
            onDismiss = { inspecting = null },
            onChanged = { refresh(keepStatus = true) },
            onFiles = { browsing = session },
        )
    }
    if (showBin) {
        RecycleBinSheet(settings = settings, hosts = binHosts, onDismiss = { showBin = false }, onChanged = { refresh(keepStatus = true) })
    }
    if (showActivity) ActivitySheet(settings, onDismiss = { showActivity = false })
    connectingOn?.let { host ->
        CredentialsSheet(settings, host, onDismiss = { connectingOn = null; refresh() }, onlyClaude = true)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(when (tab) { "machines" -> "Machines"; "you" -> "You"; else -> "Fleetwright" }) },
                actions = {
                    if (tab == "sessions" && settings.configured) {
                        // THE BIN, WITH THE SESSIONS, reachable when empty too:
                        // a safety net nobody can find until they need it does
                        // not reassure anybody.
                        val bin = binHosts.sumOf { it.bin.size }
                        TextButton(onClick = { showBin = true }) { Text(if (bin > 0) "Bin ($bin)" else "Bin") }
                        // WHAT HAPPENED WHILE THE APP WAS CLOSED, beside the bin.
                        TextButton(onClick = { showActivity = true }) { Text("Activity") }
                    }
                },
            )
        },
        bottomBar = {
            // THE SHORT BAR, Material 3's current one: shorter than the old
            // NavigationBar, with the mark above its word. The marks were empty
            // slots, so the three tabs read as three words; they are now the
            // same list, rack and person iOS shows in the same places.
            ShortNavigationBar {
                listOf(
                    Triple("sessions", "Sessions", NavIcons.sessions),
                    Triple("machines", "Machines", NavIcons.machines),
                    Triple("you", "You", NavIcons.you),
                ).forEach { (key, label, mark) ->
                    ShortNavigationBarItem(
                        selected = tab == key,
                        onClick = { tab = key },
                        icon = { Icon(mark, contentDescription = null) },
                        label = { Text(label) },
                    )
                }
            }
        },
        floatingActionButton = {
            if (settings.configured && tab == "sessions") {
                ExtendedFloatingActionButton(
                    text = { Text("New session") },
                    icon = {},
                    // Opens the sheet rather than starting immediately: a
                    // session nobody described is one nobody recognises later.
                    onClick = { showStart = true },
                )
            }
        },
    ) { padding ->
        // THE BOTTOM BAR'S HEIGHT IS RESERVED, so the last card is never
        // under it.
        val inner = Modifier.padding(padding).fillMaxSize()
        when (tab) {
            "machines" -> MachinesScreen(
                settings = settings,
                admin = showsAdmin,
                viewAsMember = viewAsMember,
                opening = openHost,
                onOpened = { openHost = null },
                modifier = inner,
                resumingSetup = openSetup,
                onResumed = { openSetup = null },
            )
            "you" -> YouScreen(
                settings = settings,
                admin = admin,
                viewAsMember = viewAsMember,
                onViewAsMember = {
                    settings.viewAsMember = it
                    viewAsMember = it
                },
                onSignedIn = {
                    signedIn = true
                    // Signing in is what makes push registration possible at
                    // all — before it there is no credential to POST with.
                    onSignedIn()
                },
                onSignedOut = {
                    settings.viewAsMember = false
                    viewAsMember = false
                    signedIn = false
                },
                modifier = inner,
            )
            else -> PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        reload()
                        refreshing = false
                    }
                },
                modifier = inner,
            ) {
                LazyColumn(
                    Modifier.padding(horizontal = Design.Space.page),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.groupTight),
                ) {
                    item {
                        Column(
                            Modifier.padding(top = Design.Space.groupTight),
                            verticalArrangement = Arrangement.spacedBy(Design.Space.groupTight),
                        ) {
                            if (busy && !refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
                            // SAID WHERE IT IS SEEN. An admin viewing as a
                            // member is looking at a smaller fleet than theirs.
                            if (viewAsMember) {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .fleetCard(radius = Design.Radius.row, fill = Design.Palette.inner.now)
                                        .padding(horizontal = Design.Space.inside),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text("Viewing as a member", style = Design.Style.bodySmall, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                                    TextButton(
                                        onClick = { settings.viewAsMember = false; viewAsMember = false },
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text("Switch back") }
                                }
                            }
                            // FIRST, ALWAYS, ABOVE THE LIST. "Nothing needs you"
                            // is the most important state in the system.
                            //
                            // AND IT GOES WHERE IT POINTS: one unwell machine
                            // opens its page; several open the list.
                            val summary = Reassurance.of(sessions, binHosts)
                            val unwell = binHosts.filter { it.state != "healthy" }.map { it.hostId }
                            if (unwell.isEmpty()) {
                                ReassuranceBanner(summary)
                            } else {
                                Box(
                                    Modifier.clickable(role = Role.Button) {
                                        openHost = unwell.singleOrNull()
                                        tab = "machines"
                                    },
                                ) { ReassuranceBanner(summary) }
                            }
                            // THE ONBOARDING ASK, under the line that says
                            // whether anything needs you. A session runs on its
                            // starter's own Claude account, and a runner started
                            // with none kept refused the session it was started
                            // for, with nothing on the way there having asked.
                            if (!claudePutOff && (claude == ClaudeKept.Missing || claude == ClaudeKept.NeedsGitHub) &&
                                settings.configured && !Demo.isActive(settings.coordinatorUrl)
                            ) {
                                ClaudeSetupCard(
                                    onSetUp = { settingUpClaude = true },
                                    onPutOff = { settings.claudeSetupPutOff = true; claudePutOff = true },
                                )
                            }
                            if (status.isNotBlank()) {
                                // Evidence quoted from somewhere else, on an
                                // inner surface rather than a card of its own.
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
                            // WHAT IS WAITING, because a queue nobody can see is
                            // a surprise arriving later.
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
                                EmptySessions(
                                    configured = settings.configured,
                                    // TWO DIFFERENT EMPTY SCREENS, as on iOS. A
                                    // person with nowhere to run anything is
                                    // looking at a setup step, not an empty list.
                                    needsSetup = binHosts.isNotEmpty() && haveClaude == false,
                                    hosts = binHosts.map { it.hostId },
                                    onConnect = { connectingOn = it },
                                    onSignIn = { tab = "you" },
                                )
                            }
                        }
                    }
                    items(sessions, key = { "${it.hostId}/${it.name}" }) { session ->
                        // FILES, OUTPUT AND FORGET ARE ON THE SESSION'S SHEET,
                        // and only there. The card carried the same row of
                        // actions as the sheet it opens, plus Peek, which the
                        // sheet already does by watching the screen.
                        //
                        // A CARD MOVES TO WHERE IT NOW BELONGS: one that started
                        // asking goes to the top, a new one arrives, a forgotten
                        // one leaves. No travel when animations are off.
                        SessionCard(
                            modifier = Modifier.animateItem(
                                fadeInSpec = Design.Motion.change(),
                                placementSpec = Design.Motion.settle(reduced),
                                fadeOutSpec = Design.Motion.change(),
                            ),
                            session = session,
                            busy = busy,
                            onStop = { act { fleet.stop(session.name) } },
                            onAnswer = { option -> act { fleet.answer(session.name, option, session.prompt?.id) } },
                            onInspect = { inspecting = session },
                            onResume = { act { fleet.resume(session.name, "summary") } },
                            onOpen = { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                        )
                    }
                    item { Spacer(Modifier.heightIn(min = 88.dp)) }
                }
            }
        }
    }
}

/**
 * Nothing in the list, said as one of three different situations: not signed
 * in, nothing set up for you yet, or simply nothing running.
 */
@Composable
private fun EmptySessions(
    configured: Boolean,
    needsSetup: Boolean,
    hosts: List<String>,
    onConnect: (String) -> Unit,
    onSignIn: () -> Unit,
) {
    Column(
        Modifier.padding(top = Design.Space.group),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        when {
            !configured -> {
                Text("Not signed in", style = Design.Style.section, color = Design.Palette.ink.now)
                Hint("Sign in to a fleet under You, and its sessions are listed here.")
                OutlinedButton(onClick = onSignIn) { Text("Go to You") }
            }
            needsSetup -> {
                Text("Nothing set up yet", style = Design.Style.section, color = Design.Palette.ink.now)
                Hint("A session runs on YOUR Claude account. Sign in to Claude on one of these machines and you can start work here.")
                // THE SAME SIGN-IN A MACHINE'S PAGE OFFERS, on the machine picked.
                hosts.forEach { host ->
                    OutlinedButton(onClick = { onConnect(host) }) { Text("Connect Claude on $host") }
                }
            }
            else -> {
                Text("No sessions", style = Design.Style.section, color = Design.Palette.ink.now)
                Hint("Nothing is running on any machine in this fleet. Tap “New session” to start one.")
            }
        }
    }
}

@Composable
private fun SessionCard(
    modifier: Modifier = Modifier,
    session: Fleet.Session,
    busy: Boolean,
    onStop: () -> Unit,
    onResume: () -> Unit,
    onAnswer: (Int) -> Unit,
    onOpen: (String) -> Unit,
    /** The session's own sheet: the way to look, and Files, Output and Forget. */
    onInspect: () -> Unit,
) {
    // NO BORDER, AND A RING THAT MEANS SOMETHING. The one card that wears a
    // tone is the one asking a question.
    //
    // AND IT TAKES THE TONE ON as the question arrives, rather than being
    // swapped for it.
    val ring by animateColorAsState(
        if (session.prompt != null) Design.Palette.attention.now else Design.Palette.ring.now,
        Design.Motion.change(),
        label = "ring",
    )
    val reduced = Design.Motion.reduced()
    Column(
        modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = ring)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // THE TITLE IS THE WAY IN, 48dp tall whatever the type size, and a
            // button to TalkBack, because it is one.
            Row(
                Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClick = onInspect),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    session.label,
                    style = Design.Style.bodyStrong,
                    color = Design.Palette.ink.now,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(" ›", style = Design.Style.bodyStrong, color = Design.Palette.inkDim.now)
            }
            // Colour AND the word, never colour alone. The word crossfades
            // into the next one: a session changing state is the news.
            AnimatedContent(
                targetState = session.status,
                modifier = Modifier
                    .background(Design.Palette.inner.now, RoundedCornerShape(Design.Radius.chip))
                    .padding(horizontal = Design.Space.insideTight, vertical = Design.Space.hair),
                transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
                label = "status",
            ) { status ->
                Text(status, style = Design.Style.label, color = statusColour(status))
            }
        }
        if (session.label != session.name) {
            Text(session.name, style = Design.Style.micro, fontFamily = FontFamily.Monospace, color = Design.Palette.inkDim.now)
        }
        // Where, how long, and whose account — one line, secondary.
        val context = listOfNotNull(
            session.hostId?.let { "on $it" },
            session.workspace,
            session.age,
            session.account?.takeIf { it != "shared" },
            session.contextLine,
        )
        if (context.isNotEmpty()) {
            Text(context.joinToString(" · "), style = Design.Style.micro, color = Design.Palette.inkDim.now)
        }
        // HOW LONG IT HAS BEEN QUIET. Null under five minutes.
        session.quietFor?.let { Text(it, style = Design.Style.micro, color = Design.Palette.inkDim.now) }
        // WHAT IT IS ASKING, and the answer as rows. The options are the ones
        // the HOST published; an ordinal is sent, never text.
        // THE QUESTION UNFOLDS from under the title it belongs to; with
        // animations off it fades in where it will sit.
        AnimatedVisibility(
            visible = session.prompt != null,
            enter = if (reduced) fadeIn(Design.Motion.change())
            else fadeIn(Design.Motion.change()) + expandVertically(Design.Motion.settle(false)!!),
            exit = fadeOut(Design.Motion.change()) + shrinkVertically(Design.Motion.change()),
        ) {
        session.prompt?.let { prompt ->
            if (prompt.options.isNotEmpty()) {
                Column(
                    Modifier.padding(top = Design.Space.insideTight),
                    verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    // THE QUESTION IS THE TITLE HERE.
                    prompt.question?.let { Text(it, style = Design.Style.title, color = Design.Palette.ink.now) }
                    prompt.options.forEach { option ->
                        // A row, not a TextButton: 48dp of target whatever the
                        // label's length.
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(Design.Radius.row))
                                .clickable(enabled = !busy, role = Role.Button) { onAnswer(option.index) }
                                .background(Design.Palette.inner.now)
                                .border(1.dp, Design.Palette.ring.now, RoundedCornerShape(Design.Radius.row))
                                .heightIn(min = 48.dp)
                                .padding(horizontal = Design.Space.inside),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Text(
                                "${option.index}",
                                Modifier
                                    .background(Design.Palette.track.now, RoundedCornerShape(Design.Radius.chip))
                                    .padding(horizontal = Design.Space.insideTight),
                                style = Design.Style.label,
                                fontFamily = FontFamily.Monospace,
                                color = Design.Palette.inkDim.now,
                            )
                            Text(option.label, style = Design.Style.bodySmall, color = Design.Palette.ink.now)
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
        }

        // ONE PRIMARY ACTION, at 48dp.
        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            if (session.status == "running") {
                TextButton(onClick = onStop, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Stop") }
                session.rcUrl?.let { url ->
                    // The button that turns a notification into actually
                    // driving the session. The same words as its sheet.
                    TextButton(onClick = { onOpen(url) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Continue in Remote Control") }
                }
            } else if (session.resumable) {
                TextButton(onClick = onResume, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Resume") }
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
    // NOT `ok`: an ended session may have crashed, and green would say it
    // did its job. And not `idle`, which as label-sized text is 3.6:1 on the
    // dark inner surface and 2.3:1 on the light one; `inkDim` is the
    // palette's colour for "stopped" and passes AA in both.
    else -> Design.Palette.inkDim.now
}
