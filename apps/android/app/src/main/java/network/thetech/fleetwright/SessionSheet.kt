package network.thetech.fleetwright

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * One session, everything about it, on a sheet of its own. The Android half
 * of iOS's SessionView, in the same order and the same words.
 *
 * WHY THIS EXISTS. The card carries the question and its answers, the
 * actions and a line of context, and Peek dropped one frozen copy of the pane
 * into the status box at the top of the list, where the next refresh wiped
 * it. docs/plan.md calls the session screen "the one state the product exists
 * for"; this is where the pane is WATCHED rather than glanced at.
 *
 * THREE THINGS, IN THIS ORDER. The state sentence, in the title size. Then
 * whatever needs a person: the question and its answers when there is one,
 * and Remote Control front and centre when there is not, because until there
 * is a prompt it is the only way to say anything and after there is one it is
 * still the only way to say anything the option list cannot. Then the pane.
 *
 * THE PANE IS WATCHED, AND THEN IT STOPS BEING WATCHED. `peek` is pinned:
 * every tick is a routed round trip down one host's single socket and a
 * capture-pane fork on the box running the session. Ten looks three seconds
 * apart while somebody is deciding, nine ten seconds apart, then a button.
 * A sheet left open must not poll a production host forever; dismissing it
 * cancels the effect, which is the whole of the mechanism.
 */
@Composable
fun SessionSheet(fleet: Fleet, initial: Fleet.Session, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    // Seeded from what the list already has: a sheet that opened blank to
    // ask a question it was handed the answer to is the fault the fleet
    // screen was rebuilt for.
    var session by remember { mutableStateOf(initial) }
    var pane by remember { mutableStateOf<String?>(null) }
    var paneAt by remember { mutableStateOf<Long?>(null) }
    var watchEnded by remember { mutableStateOf(false) }
    // Bumped by the look-again button; the effect keyed on it restarts.
    var watchGeneration by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var confirmingForget by remember { mutableStateOf(false) }

    suspend fun peek() {
        try {
            pane = fleet.peek(session.name).text
            paneAt = System.currentTimeMillis()
        } catch (e: Exception) {
            // Keeps the last picture and says so, rather than blanking a
            // screen somebody is reading.
            result = e.message ?: "could not read the screen"
        }
    }

    /** The session as the fleet sees it now, so a Stop moves the sentence. */
    suspend fun reload() {
        try {
            fleet.status(session.name).sessions.firstOrNull { it.name == session.name }?.let { session = it }
        } catch (_: Exception) {
        }
    }

    /** One action, one place the busy flag and the answer are set. */
    fun act(nothingSaid: String = "", work: suspend (Fleet) -> Fleet.Reply) {
        scope.launch {
            busy = true
            result = try {
                work(fleet).text.said(nothingSaid)
            } catch (e: Exception) {
                e.message ?: "that did not work"
            }
            busy = false
            reload()
            onChanged()
        }
    }

    // THE SCHEDULE, IN ONE PLACE. Cancelled when the sheet leaves
    // composition, restarted when the generation changes.
    LaunchedEffect(watchGeneration, session.isRunning) {
        watchEnded = false
        if (!session.isRunning) return@LaunchedEffect
        repeat(QUICK_LOOKS) { peek(); delay(QUICK_INTERVAL_MS) }
        repeat(SLOW_LOOKS) { peek(); delay(SLOW_INTERVAL_MS) }
        watchEnded = true
    }

    if (confirmingForget) {
        AlertDialog(
            onDismissRequest = { confirmingForget = false },
            title = { Text("Forget ${session.label}?") },
            text = { Text("This deletes its conversation and workspace. It cannot be undone.") },
            confirmButton = {
                TextButton(onClick = { confirmingForget = false; act { it.forget(session.name) } }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { confirmingForget = false }) { Text("Cancel") } },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(session.label) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
            ) {
                // THE STATE SENTENCE, FIRST AND IN THE TITLE SIZE: the answer
                // to "what is it doing" before anything else on the sheet.
                Text(
                    session.stateSentence,
                    style = Design.Style.title,
                    color = if (session.prompt != null) Design.Palette.attention.now else Design.Palette.ink.now,
                )
                if (session.label != session.name) {
                    Text(session.name, style = Design.Style.micro, fontFamily = FontFamily.Monospace, color = Design.Palette.inkDim.now)
                }
                Text(
                    listOfNotNull(
                        session.hostId?.let { "on $it" },
                        session.workspace?.let { "· $it" },
                        session.age?.let { "· started $it ago" },
                        session.account?.takeIf { it != "shared" }?.let { "· $it" },
                    ).joinToString(" "),
                    style = Design.Style.micro,
                    color = Design.Palette.inkDim.now,
                )

                val prompt = session.prompt
                if (prompt != null && prompt.options.isNotEmpty()) {
                    Text("It is asking", style = Design.Style.section, color = Design.Palette.ink.now)
                    prompt.question?.let { Text(it, style = Design.Style.bodyStrong, color = Design.Palette.ink.now) }
                    prompt.options.forEach { option ->
                        OutlinedButton(
                            onClick = { act { it.answer(session.name, option.index, prompt.id) } },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Text("${option.index}", fontFamily = FontFamily.Monospace, color = Design.Palette.inkDim.now)
                            Spacer(Modifier.padding(horizontal = Design.Space.hair))
                            Text(option.label)
                        }
                    }
                } else if (prompt != null) {
                    Text("It is asking", style = Design.Style.section, color = Design.Palette.ink.now)
                    Text(
                        "Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.inkDim.now,
                    )
                } else if (session.isRunning && !session.rcUrl.isNullOrBlank()) {
                    // FRONT AND CENTRE WHEN THERE IS NO PROMPT. Demoting this
                    // to a footer would be wrong: it is the only way to say
                    // anything to a session the option list cannot express,
                    // which is every session not asking a yes-or-no question.
                    OutlinedButton(
                        onClick = { uriHandler.openUri(session.rcUrl) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Text("Continue in Remote Control") }
                    Text(
                        "Your shell on this session, in the browser. Anything typed there goes to the session as if you were at the box.",
                        style = Design.Style.micro,
                        color = Design.Palette.inkDim.now,
                    )
                }

                Text("On its screen", style = Design.Style.section, color = Design.Palette.ink.now)
                val screen = pane
                when {
                    screen != null && screen.isBlank() -> Text(
                        "Nothing is on ${session.label}'s screen right now.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.inkDim.now,
                    )
                    // MONOSPACED, UNWRAPPED, SCROLLED SIDEWAYS. A pane is drawn
                    // for a terminal of 70 to 100 columns and its box-drawing
                    // borders must never reflow: a wrapped pane is not a
                    // smaller picture of the same thing, it is a different
                    // picture. softWrap = false is the whole of that rule.
                    screen != null -> Text(
                        screen,
                        style = Design.Style.label,
                        fontFamily = FontFamily.Monospace,
                        softWrap = false,
                        color = Design.Palette.ink.now,
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                    )
                    session.isRunning -> Text("Reading the screen…", style = Design.Style.bodySmall, color = Design.Palette.inkDim.now)
                    else -> Text(
                        "Not running, so there is no screen to read. Output has what it printed; Resume brings the conversation back.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.inkDim.now,
                    )
                }
                paneAt?.let { at ->
                    Row {
                        val time = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(at))
                        Text(
                            if (watchEnded) "As of $time. No longer watching." else "As of $time. Watching.",
                            style = Design.Style.micro,
                            color = Design.Palette.inkDim.now,
                        )
                        Spacer(Modifier.weight(1f))
                        if (watchEnded) TextButton(onClick = { watchGeneration += 1 }) { Text("Look again") }
                    }
                }

                Text("Actions", style = Design.Style.section, color = Design.Palette.ink.now)
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    if (session.isRunning) {
                        TextButton(onClick = { act { it.stop(session.name) } }, enabled = !busy) { Text("Stop") }
                    } else if (session.resumable) {
                        TextButton(onClick = { act { it.resume(session.name, "summary") } }, enabled = !busy) { Text("Resume") }
                    }
                    // What it SAID, as against what it looks like: the
                    // container's output outlives the pane.
                    TextButton(
                        onClick = {
                            act(nothingSaid = "${session.label} has printed nothing that this machine could read.") {
                                it.logs(host = session.hostId, session = session.name)
                            }
                        },
                        enabled = !busy,
                    ) { Text("Output") }
                    if (!session.isRunning) {
                        TextButton(onClick = { confirmingForget = true }, enabled = !busy) { Text("Forget", color = MaterialTheme.colorScheme.error) }
                    }
                }

                if (result.isNotBlank()) {
                    Text("Reply", style = Design.Style.section, color = Design.Palette.ink.now)
                    Text(result, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

/** Ten looks three seconds apart, then nine ten seconds apart: two minutes of watching, and then a button. */
private const val QUICK_LOOKS = 10
private const val QUICK_INTERVAL_MS = 3_000L
private const val SLOW_LOOKS = 9
private const val SLOW_INTERVAL_MS = 10_000L
