package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * The line that says nothing needs you, and why it is confident of that.
 *
 * docs/psychology.md names this as the product's real job and neither app was
 * doing it:
 *
 * > The product's real job is to convert unbounded anxiety into bounded
 * > knowledge — and the important consequence is that *"nothing needs you"* is
 * > the most important state in the system, not the least.
 *
 * A list of rows is not that. Reading five rows and concluding that none of
 * them is asking anything is work, and it is work a person redoes every time
 * they open the app — which is exactly the loop the anxiety runs in.
 *
 * SILENCE HAS TO BE TRUSTWORTHY BEFORE IT IS COMFORTABLE (§7). So this never
 * says "all good" from an absence. It counts what it can see and NAMES WHAT IT
 * CANNOT: a fleet with no health at all is a different fact from a healthy
 * fleet with nothing running, and a summary that cannot tell them apart is
 * worse than no summary.
 *
 * Matches the iOS banner clause for clause.
 */
data class Reassurance(
    val waiting: Int,
    val running: Int,
    val quiet: Int,
    val unwell: List<String>,
    val blind: Boolean,
    val healthy: Int,
) {
    companion object {
        fun of(sessions: List<Fleet.Session>, hosts: List<Fleet.FleetHost>): Reassurance {
            val unwell = hosts.filter { it.state != "healthy" }.map { it.hostId }
            return Reassurance(
                waiting = sessions.count { it.prompt != null },
                running = sessions.count { it.isRunning },
                // Only the ones that look STALLED. Counting finished sessions
                // as "quiet a while" told somebody three things needed
                // attention on a fleet where everything had gone perfectly.
                quiet = sessions.count { it.looksStalled },
                unwell = unwell,
                blind = hosts.isEmpty(),
                healthy = hosts.size - unwell.size,
            )
        }
    }

    /** The headline. One clause, and the most urgent true one. */
    val headline: String get() = when {
        waiting == 1 -> "One session is waiting for you"
        waiting > 1 -> "$waiting sessions are waiting for you"
        unwell.size == 1 -> "One machine needs a look"
        unwell.size > 1 -> "${unwell.size} machines need a look"
        blind -> "No machines are reporting"
        running == 0 -> "Nothing is running"
        else -> "Nothing needs you"
    }

    /**
     * WHY it is confident, which is the half that does the work. A headline
     * with no basis is a reassurance somebody has to take on faith, and the
     * whole argument for this line is that they should not have to.
     */
    val basis: String get() {
        if (blind) {
            return "The coordinator has no health from any machine, so this cannot say whether anything is running."
        }
        val parts = mutableListOf<String>()
        if (running > 0) parts += if (running == 1) "1 session running" else "$running sessions running"
        if (quiet > 0) parts += if (quiet == 1) "1 of them quiet a while" else "$quiet of them quiet a while"
        if (unwell.isNotEmpty()) parts += unwell.joinToString(", ")
        else parts += if (healthy == 1) "1 machine healthy" else "$healthy machines healthy"
        return parts.joinToString(" · ")
    }
}

/**
 * Deliberately one line and a smaller second one. This is what somebody reads
 * before deciding whether to read anything else, and a summary that takes as
 * long to read as the list it summarises has failed.
 */
@Composable
fun ReassuranceBanner(summary: Reassurance, modifier: Modifier = Modifier) {
    // NEVER COLOUR ALONE (§5). The headline always carries the meaning; this
    // only agrees with it, and a reader who cannot see it loses nothing.
    val tint: Color = when {
        summary.waiting > 0 -> MaterialTheme.colorScheme.tertiary
        summary.blind || summary.unwell.isNotEmpty() -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurface
    }
    Column(
        modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            // One announcement rather than two fragments: this is the line on
            // the screen worth hearing first.
            .semantics(mergeDescendants = true) {
                contentDescription = "${summary.headline}. ${summary.basis}"
            },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(summary.headline, style = MaterialTheme.typography.titleSmall, color = tint)
        }
        Text(
            summary.basis,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
