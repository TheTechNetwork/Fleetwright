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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
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
            ) { FleetScreen() }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen() {
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
    var status by rememberSaveable { mutableStateOf("") }
    // The session list is deliberately NOT saved: it is a cache of what the
    // coordinator said, it is refetched on the way back, and a stale list
    // restored across a rotation would show sessions that may since have
    // stopped.
    var sessions by remember { mutableStateOf(listOf<Fleet.Session>()) }
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
            busy = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Fleetwright") },
                actions = {
                    TextButton(onClick = { refresh() }, enabled = !busy) { Text("Refresh") }
                    TextButton(onClick = { showSettings = !showSettings }) { Text("Settings") }
                },
            )
        },
        floatingActionButton = {
            if (settings.configured && !showSettings) {
                ExtendedFloatingActionButton(
                    text = { Text("New session") },
                    icon = {},
                    onClick = {
                        scope.launch {
                            busy = true
                            val reply = fleet.start(null)
                            status = reply.text
                            busy = false
                            refresh(keepStatus = true)
                        }
                    },
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).fillMaxSize()) {

            if (showSettings) {
                SettingsPanel(settings) {
                    showSettings = false
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
    onPeek: () -> Unit,
    onOpen: (String) -> Unit,
) {
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
            session.hostId?.let {
                Text("on $it", style = MaterialTheme.typography.bodySmall)
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
            }
        }
    }
}

@Composable
private fun SettingsPanel(settings: Settings, onDone: () -> Unit) {
    // Saved, so a rotation mid-typing does not silently reset both fields to
    // whatever was last persisted.
    var url by rememberSaveable { mutableStateOf(settings.coordinatorUrl) }
    var token by rememberSaveable { mutableStateOf(settings.apiToken) }

    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Coordinator", style = MaterialTheme.typography.titleMedium)
        Text(
            "The origin this app talks to, and the API token from " +
                "/etc/agent-fleet-coordinator.env. Nothing is baked into the app — a " +
                "credential in an APK is public the moment somebody unzips it.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Coordinator URL") },
            placeholder = { Text("https://fleet.thetech.network") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        // Masked, like the iOS SecureField. This is the credential that can
        // start and stop every session in the fleet, and in plain text it is
        // readable over a shoulder and captured by any screenshot or screen
        // recording of this panel. `reveal` is there because a mistyped token
        // otherwise fails as an indistinguishable "rejected the token".
        var reveal by rememberSaveable { mutableStateOf(false) }
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API token") },
            singleLine = true,
            visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                autoCorrectEnabled = false,
            ),
            trailingIcon = {
                TextButton(onClick = { reveal = !reveal }) { Text(if (reveal) "Hide" else "Show") }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                settings.coordinatorUrl = url
                settings.apiToken = token
                onDone()
            },
            enabled = url.isNotBlank(),
        ) { Text("Save") }

        // Push is the one feature that fails silently: a registration that
        // never arrived and a coordinator with no sender configured look
        // identical from here, which is to say they look like nothing at all.
        // This asks the coordinator to send one now and reports what happened,
        // so the answer arrives before the notification that matters does.
        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        var pushResult by rememberSaveable { mutableStateOf("") }
        val scope = rememberCoroutineScope()
        OutlinedButton(
            onClick = {
                scope.launch {
                    pushResult = "sending…"
                    // Save first: testing against a token the user has typed
                    // but not saved would test the wrong coordinator.
                    settings.coordinatorUrl = url
                    settings.apiToken = token
                    pushResult = Fleet(settings).testPush(null).text
                }
            },
            enabled = url.isNotBlank(),
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
