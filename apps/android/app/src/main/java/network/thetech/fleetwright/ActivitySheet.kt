package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * What happened while the app was closed. A notification wakes this phone;
 * this is the rest of it.
 *
 * Reached from the session list, beside the bin, because it is news about
 * sessions and machines. It was the last section of the settings panel, which
 * is the last place anybody looks for news.
 */
@Composable
fun ActivitySheet(settings: Settings, onDismiss: () -> Unit) {
    var events by remember { mutableStateOf<List<Fleet.Event>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        events = Fleet(settings).events()
        loaded = true
    }
    FullScreen(title = "Recent activity", onDismiss = onDismiss) {
        if (events.isEmpty()) Hint(if (loaded) "Nothing recorded yet." else "Loading…")
        // NEWEST FIRST HERE, and consecutive repeats collapsed to one row and a
        // count: nine lines reading "asked for connect" is one fact.
        // THE LABEL AND ITS SUBJECT ON THE ROW, THE SENTENCE ON A TAP. The
        // fleet's `text` is its log line: "eli@example.com asked for start
        // reviewer-3 on deb132" is the record, and a screen that printed it
        // per row was the log again (docs/design-system.md, Words). The row
        // says what kind of thing happened and to what; the sentence opens
        // under it for whoever wants the detail. A row with no sentence has
        // nothing to open. Same as iOS (ActivityView).
        for (run in runsOf(events)) {
            val e = run.first
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(vertical = Design.Space.hair)) {
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    Text(ReasonWords.activity(e.event, e.verb), style = Design.Style.body, color = Design.Palette.ink.now)
                    describeEventSubject(e)?.let {
                        Text(it, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.inkDim.now)
                    }
                    if (run.second > 1) Text("×${run.second}", style = Design.Style.label, color = Design.Palette.inkDim.now)
                }
                Hint(describeEventWho(e, settings.signedInAs))
                e.text?.takeIf { it.isNotBlank() }?.let { Details(it) }
            }
        }
    }
}

/** Newest first, consecutive identical events as one with a count. */
private fun runsOf(events: List<Fleet.Event>): List<Pair<Fleet.Event, Int>> {
    val out = mutableListOf<Pair<Fleet.Event, Int>>()
    for (e in events.reversed()) {
        val last = out.lastOrNull()?.first
        if (last != null && last.event == e.event && last.name == e.name && last.hostId == e.hostId && last.actor == e.actor) {
            out[out.size - 1] = last to out[out.size - 1].second + 1
        } else {
            out.add(e to 1)
        }
    }
    return out
}

/**
 * What the event is about: its `name` (a session, a pool's address), else its
 * machine, or null for news about the fleet as a whole. "coordinator" is not
 * a machine (describeEventWho says the same). The label beside it is
 * [ReasonWords.activity], which knows every kind the coordinator records and
 * shows the kind itself for one it does not (C-5).
 */
private fun describeEventSubject(e: Fleet.Event): String? =
    e.name?.takeIf { it.isNotBlank() } ?: e.hostId?.takeIf { it.isNotBlank() && it != "coordinator" }

/**
 * "on deb132 · 20 minutes ago", and who asked when it was not you. The machine
 * only where the row's subject was something else (a session, a pool): where
 * the machine is the subject it is already on the row.
 */
private fun describeEventWho(e: Fleet.Event, me: String): String {
    val parts = mutableListOf<String>()
    // "on coordinator" IS NOT A PLACE. It is where everything happens.
    if (!e.name.isNullOrBlank()) e.hostId?.takeIf { it.isNotBlank() && it != "coordinator" }?.let { parts.add("on $it") }
    // NULL ACTOR IS THE FLEET ACTING ON ITS OWN, and your own name is not news.
    val actor = e.actor?.takeIf { it.isNotBlank() }
    if (actor == null) parts.add("the fleet") else if (actor != me) parts.add(actor)
    parts.add(relative(e.at).toString())
    return parts.joinToString(" · ")
}
