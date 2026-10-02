package network.thetech.fleetwright

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

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
        if (events.isEmpty()) Hint(if (loaded) "Nothing recorded yet." else "Asking the fleet…")
        // NEWEST FIRST HERE, and consecutive repeats collapsed to one row and a
        // count: nine lines reading "asked for connect" is one fact.
        for (run in runsOf(events)) {
            Column(Modifier.fillMaxWidth().padding(vertical = Design.Space.hair)) {
                Row {
                    Text(describeEvent(run.first), style = Design.Style.body, color = Design.Palette.ink.now)
                    if (run.second > 1) Text("  ×${run.second}", style = Design.Style.label, color = Design.Palette.inkDim.now)
                }
                Hint(describeEventWho(run.first, settings.signedInAs))
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
 * The sentence for one event, with its subject named. The fleet records `text`
 * for the events that have something to say, so this falls back to the
 * event's own name rather than to a blank row.
 */
private fun describeEvent(e: Fleet.Event): String = when {
    !e.text.isNullOrBlank() -> e.text
    !e.name.isNullOrBlank() -> "${e.event} — ${e.name}"
    else -> e.event
}

/** "on deb132 · 20 minutes ago", and who asked when it was not you. */
private fun describeEventWho(e: Fleet.Event, me: String): String {
    val parts = mutableListOf<String>()
    // "on coordinator" IS NOT A PLACE. It is where everything happens.
    e.hostId?.takeIf { it.isNotBlank() && it != "coordinator" }?.let { parts.add("on $it") }
    // NULL ACTOR IS THE FLEET ACTING ON ITS OWN, and your own name is not news.
    val actor = e.actor?.takeIf { it.isNotBlank() }
    if (actor == null) parts.add("the fleet") else if (actor != me) parts.add(actor)
    parts.add(relative(e.at).toString())
    return parts.joinToString(" · ")
}
