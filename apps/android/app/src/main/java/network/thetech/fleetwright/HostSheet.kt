package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * What a machine is set to, on a screen of its own.
 *
 * WHY A SHEET AND NOT MORE ROWS. The fleet card already carries a state line, a
 * version, Check, Apply, Reboot and a channel picker; the two settings here are
 * a segmented choice and a list that grows, and putting them in the card would
 * rebuild the wall that iOS just took apart. This is Android's answer to
 * HostView — narrower for now, and docs/app-parity.md records the rest.
 *
 * Both settings answer the same kind of question: what does a session that
 * lands here get, and what makes one land here at all.
 */
@Composable
fun HostSheet(settings: Settings, host: Fleet.FleetHost, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    // SEEDED FROM WHAT THE LIST ALREADY HAS. A sheet that opened blank to ask a
    // question it was handed the answer to is the fault the fleet screen was
    // rebuilt for.
    var variant by remember { mutableStateOf(host.sandboxVariant) }
    var pinned by remember { mutableStateOf(host.sandboxPinned) }
    var labels by remember { mutableStateOf(host.labels) }
    var setLabels by remember { mutableStateOf(host.setLabels) }
    var newLabel by remember { mutableStateOf("") }

    /** One action, one place the busy flag and the answer are set. */
    fun run(work: suspend (Fleet) -> Fleet.Reply) {
        scope.launch {
            busy = true
            result = try {
                val r = work(Fleet(settings))
                // BELIEVE THE REPLY. The host pushes a health frame after a
                // mutating verb and the list's own refresh races it; losing that
                // race shows the value somebody just changed away from.
                r.sandboxVariant?.let { variant = it; pinned = r.sandboxPinned }
                // BOTH LISTS MOVE TOGETHER, or a chip lingers after a Remove and
                // is missing after an Add until the next frame — on the one
                // screen where the person is looking straight at what they
                // changed. The full list is what the machine derives (which this
                // sheet already has) plus what the reply says is set.
                r.setLabels?.let { set ->
                    val derived = labels.filter { it !in setLabels }
                    labels = (derived + set).distinct().sorted()
                    setLabels = set.sorted()
                }
                // Trimmed, because a journal that answers with padding would
                // otherwise draw its card with a screenful of empty rows above
                // and below the one line worth reading. See String.said.
                r.text.said()
            } catch (e: Exception) {
                e.message ?: "that did not work"
            }
            busy = false
            onChanged()
        }
    }

    fun addLabel() {
        val wanted = newLabel.trim()
        if (wanted.isEmpty()) return
        // CLEARED THE MOMENT IT LEAVES, whether or not it worked. A field still
        // holding a name that was refused looks like it can be pressed again,
        // and the reason is in the box below.
        newLabel = ""
        run { it.labels(host.hostId, add = wanted) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(host.hostId) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
            ) {
                // THE GAP, FIRST AND IN THE ERROR COLOUR: the one line on this
                // sheet that says the box is not running what it holds. Same
                // sentence as iOS, held equal by test/restart-waiting.test.js.
                host.restartWaitingFor?.let { waiting ->
                    Text(
                        "$waiting is on this box and not yet running. A restart applies it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Text("Sessions", style = MaterialTheme.typography.titleSmall)
                when {
                    variant == null ->
                        // NULL IS CANNOT TELL. A host older than this verb sends
                        // nothing, and a control defaulted to "no browser" would
                        // tell somebody their box has no Chromium when it might.
                        Text(
                            "This host has not said which image it runs sessions in.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    pinned || (variant != "minimal" && variant != "browser") ->
                        // AN ANSWER, NOT A CHOICE. Either the environment names
                        // the image or the box is on one that is neither variant,
                        // and a picker would have to show a segment for a state
                        // it cannot switch to.
                        Text(
                            (if (pinned) "Set on the box: " else "Not one of ours: ") + host.sandboxImage.orEmpty(),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        )
                    else -> Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        listOf("minimal" to "No browser", "browser" to "Browser").forEach { (value, label) ->
                            FilterChip(
                                selected = variant == value,
                                enabled = !busy && variant != value,
                                onClick = { run { it.sandbox(host.hostId, to = value) } },
                                label = { Text(label) },
                            )
                        }
                    }
                }
                Text(
                    "The browser image is the same one with Chromium in it, for a session that has to "
                        + "look at a page it built. Running sessions keep the image they started in.",
                    style = MaterialTheme.typography.bodySmall,
                )

                Text("Labels", style = MaterialTheme.typography.titleSmall)
                if (labels.isEmpty()) {
                    Text(
                        "No labels, so only work that names this host can land here.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                labels.forEach { label ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        // REMOVE APPEARS ON EXACTLY THE ONES IT WORKS FOR.
                        // `arm64` and `gpu` look identical in the list the host
                        // sends, and the host refuses to drop one of them — so a
                        // trailing X on every chip would do nothing on half of
                        // them, discoverable only by tapping.
                        if (label in setLabels) {
                            InputChip(
                                selected = false,
                                enabled = !busy,
                                onClick = { run { it.labels(host.hostId, remove = label) } },
                                label = { Text(label) },
                                trailingIcon = { Text("✕") },
                            )
                        } else {
                            InputChip(
                                selected = false,
                                enabled = false,
                                onClick = {},
                                label = { Text(label) },
                            )
                            Text(
                                "from the machine",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    OutlinedTextField(
                        value = newLabel,
                        onValueChange = { newLabel = it },
                        label = { Text("Add a label") },
                        singleLine = true,
                        // A LABEL IS COMPARED FOR EQUALITY by the scheduler, so
                        // Android capitalising it would store one that can never
                        // be matched — which looks exactly like tags being broken.
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { addLabel() }, enabled = !busy && newLabel.isNotBlank()) { Text("Add") }
                }
                Text(
                    "Labels are how work is aimed: a session asked for with a tag lands on a host "
                        + "carrying it. The ones the machine works out about itself cannot be removed.",
                    style = MaterialTheme.typography.bodySmall,
                )

                // WHAT THIS BOX PUTS INTO EVERY SESSION, and what it costs.
                //
                // A box can hold a file that becomes ~/.claude/CLAUDE.md inside
                // every new session. Nothing about it crosses the wire and no
                // screen can set it, so all this can do is report it: the size,
                // because rules are read on every turn and the size is the
                // running cost; or that a file is there and not being used,
                // which is the one state worth attention.
                //
                // NULL DRAWS NOTHING. It is the normal case (no file) and also
                // an older host, and a line reading "no house rules" on every
                // machine that has never heard of them would be a line about a
                // feature nobody is using. Same words as iOS, held equal by
                // test/house-rules-shown.test.js.
                host.houseRules?.let { houseRules ->
                    Text("House rules", style = MaterialTheme.typography.titleSmall)
                    if (houseRules == 0) {
                        Text(
                            "A rules file is on this box and is not being used. The box's /profiles says why.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    } else {
                        Text(
                            "Every new session here starts with $houseRules characters of house rules, read on every turn.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Text(
                        "One file on the box, written into each new session as its CLAUDE.md. Changing it needs "
                            + "a shell there, and reaches the next session rather than a running one.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                // THE JOURNAL, FROM THE PHONE. The half of "sign-in status and
                // logs on the app" that stayed unbuilt while the roadmap said
                // done: Fleet.kt had the call and no screen made it.
                //
                // One button per journal THIS box can read, which the host says
                // in its health frame. A box that is a host and not a
                // coordinator gets two, not three with one that answers "no log
                // entries" — the chat surface has filtered the same way since
                // the verb shipped.
                Text("Logs", style = MaterialTheme.typography.titleSmall)
                val logs = host.logs
                when {
                    logs == null ->
                        // NULL IS CANNOT TELL. A host older than this field
                        // still answers the verb, but this sheet has not been
                        // told which of the three journals exist here.
                        Text(
                            "This host has not said which logs it can read.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    logs.isEmpty() ->
                        Text(
                            "None of the services this app knows are installed here.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    else -> Column {
                        logs.forEach { source ->
                            TextButton(
                                onClick = { run { it.logs(host.hostId, service = source) } },
                                enabled = !busy,
                            ) { Text(logName(source)) }
                        }
                    }
                }
                Text(
                    "The last forty lines of a service's journal. A session's own output is under "
                        + "the session, as Output.",
                    style = MaterialTheme.typography.bodySmall,
                )

                if (result.isNotBlank()) {
                    // THE BOX'S OWN WORDS, on an inner surface: quoted from
                    // somewhere else, and it should not look like something this
                    // screen said.
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = MaterialTheme.shapes.small,
                    ) {
                        Text(
                            result,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier
                                .padding(Design.Space.insideTight)
                                .heightIn(max = 180.dp)
                                .verticalScroll(rememberScrollState()),
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
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
