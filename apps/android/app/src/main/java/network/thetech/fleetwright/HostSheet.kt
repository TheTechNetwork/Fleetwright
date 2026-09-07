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
                r.text
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
