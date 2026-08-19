package network.thetech.fleetwright

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 13+ will not show a notification until this is granted, and a
        // fleet app that cannot tell you a session is waiting has lost its main
        // reason to exist.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent { MaterialTheme { FleetScreen() } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen() {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val fleet = remember { Fleet(settings) }
    val scope = rememberCoroutineScope()

    var showSettings by remember { mutableStateOf(!settings.configured) }
    var sessions by remember { mutableStateOf(listOf<Fleet.Session>()) }
    var status by remember { mutableStateOf("") }
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
                title = { Text("agent-fleet") },
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
                AssistChip(onClick = {}, label = { Text(session.status) })
            }
            if (session.label != session.name) {
                Text(session.name, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
            session.hostId?.let {
                Text("on $it", style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
    var url by remember { mutableStateOf(settings.coordinatorUrl) }
    var token by remember { mutableStateOf(settings.apiToken) }

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
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API token") },
            singleLine = true,
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
    }
}
