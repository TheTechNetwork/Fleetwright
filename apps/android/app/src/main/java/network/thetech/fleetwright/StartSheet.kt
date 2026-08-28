package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Starting a session without asking anybody to name a thing they have not done.
 *
 *   ordinary form:  [ Name ______ ] [ Start ]     <- stalls here
 *   this one:       [ What is this about? ____ ]
 *                   [ Title: suggested, editable ]
 *                   [ Start ]
 *
 * The brief comes first because it is recall — you already know what you are
 * about to do. The title is composition, which is harder, so it is offered
 * rather than demanded. Start is enabled from the first moment: leaving both
 * blank is a perfectly good answer and gets exactly what the app did before.
 */
@Composable
fun StartSheet(
    settings: Settings,
    preselectedKindId: String? = null,
    onDismiss: () -> Unit,
    onStarted: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val kinds = remember { SessionKinds.all(context) }

    var brief by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var lastSuggested by remember { mutableStateOf("") }
    var titleUntouched by remember { mutableStateOf(true) }
    var kind by remember {
        mutableStateOf(preselectedKindId?.let { id -> kinds.firstOrNull { it.id == id } })
    }
    var host by remember { mutableStateOf("") }
    var hosts by remember { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }

    // Suggest once the typing stops, not on every keystroke. A suggestion that
    // changes under the cursor while somebody is still writing makes them stop
    // to read it, lose the sentence, and costs them the thing it was meant to
    // save. Restarted by LaunchedEffect's key rather than by cancelling a job
    // by hand, which is the same debounce with less to get wrong.
    LaunchedEffect(brief) {
        if (!titleUntouched || brief.isBlank()) return@LaunchedEffect
        delay(700)
        val suggested = Naming.suggest(brief)
        // The brief may have moved on. Applying a title for text that is no
        // longer there is worse than applying none.
        if (titleUntouched) {
            lastSuggested = suggested
            title = suggested
        }
    }

    LaunchedEffect(Unit) {
        // The enrolled list the settings screen already uses. Loaded here so
        // the sheet works from every entry point, launcher shortcuts included.
        hosts = runCatching { Fleet(settings).enrolledHosts().map { it.hostId } }.getOrDefault(emptyList())
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("New session") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = brief,
                    onValueChange = { brief = it },
                    label = { Text("What is this about?") },
                    supportingText = { Text("Optional. Helps you recognise this session later.") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = title,
                    onValueChange = {
                        title = it
                        // Compared against the last suggestion rather than a
                        // plain did-it-change flag: setting the field
                        // programmatically also changes it, which would mark our
                        // own suggestion as edited and stop every later one.
                        if (it != lastSuggested) titleUntouched = false
                    },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (kinds.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Kind", style = MaterialTheme.typography.labelMedium)
                        kinds.forEach { k ->
                            AssistChip(
                                onClick = { kind = if (kind?.id == k.id) null else k },
                                label = { Text(if (kind?.id == k.id) "${k.displayName} ✓" else k.displayName) },
                            )
                        }
                    }
                }
                // Only when there is a choice. One host is not a decision,
                // and a picker with one entry is furniture.
                if (hosts.size > 1) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Where", style = MaterialTheme.typography.labelMedium)
                        AssistChip(
                            onClick = { host = "" },
                            label = { Text(if (host.isEmpty()) "Wherever fits \u2713" else "Wherever fits") },
                        )
                        hosts.forEach { h ->
                            AssistChip(
                                onClick = { host = if (host == h) "" else h },
                                label = { Text(if (host == h) "$h \u2713" else h) },
                            )
                        }
                    }
                }
                if (error.isNotBlank()) {
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            // Never disabled for an empty title or brief. Both are optional and
            // the whole point is that this is answerable without them.
            TextButton(
                enabled = !busy && settings.configured,
                onClick = {
                    scope.launch {
                        busy = true
                        error = ""
                        var finalTitle = title.trim()
                        val prefix = kind?.titlePrefix.orEmpty()
                        if (prefix.isNotBlank() && finalTitle.isNotBlank()) finalTitle = "$prefix: $finalTitle"
                        try {
                            val reply = Fleet(settings).start(
                                title = finalTitle.ifBlank { null },
                                brief = brief.trim().ifBlank { null },
                                mode = kind?.mode,
                                host = host.ifBlank { null },
                            )
                            onStarted(reply.text ?: "Started a session")
                            onDismiss()
                        } catch (e: Exception) {
                            // Shown here rather than dismissed into the list:
                            // this dialog holds the only copy of what they
                            // typed, and closing it throws that away.
                            error = e.message ?: "could not start"
                        }
                        busy = false
                    }
                },
            ) { Text(if (busy) "Starting…" else "Start") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") } },
    )
}
