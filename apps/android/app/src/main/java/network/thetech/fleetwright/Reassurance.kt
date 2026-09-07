package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

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

    /**
     * Whether the quiet can be vouched for, which is what decides how loud the
     * card is. Calm is LOW CONTRAST on purpose: claims that hold recede, claims
     * that fail come forward. Matches `Reassurance.settled` in Swift.
     */
    val settled: Boolean get() = waiting == 0 && !blind && unwell.isEmpty()
}

/**
 * Deliberately one line and a smaller second one. This is what somebody reads
 * before deciding whether to read anything else, and a summary that takes as
 * long to read as the list it summarises has failed.
 */
@Composable
fun ReassuranceBanner(summary: Reassurance, modifier: Modifier = Modifier) {
    // NEVER COLOUR ALONE (§5). The headline always carries the meaning; this
    // only agrees with it, and a reader who cannot see it loses nothing. The
    // tones are the design system's, so amber means the same thing here, on the
    // console and on the iPhone.
    val tint: Color = when {
        summary.waiting > 0 -> Design.Palette.attention.now
        summary.blind || summary.unwell.isNotEmpty() -> Design.Palette.bad.now
        else -> Design.Palette.inkDim.now
    }
    Column(
        modifier
            .fillMaxWidth()
            // A CARD THAT IS ASKING SOMETHING WEARS ITS OWN RING. Settled, the
            // ring is the hairline every other card has; unsettled, it is the
            // tone the headline is already carrying. Calm recedes, trouble
            // comes forward, and neither depends on the colour being seen.
            .fleetCard(ring = if (summary.settled) Design.Palette.ring.now else tint)
            .padding(Design.Space.groupTight)
            // One announcement rather than two fragments: this is the line on
            // the screen worth hearing first.
            .semantics(mergeDescendants = true) {
                contentDescription = "${summary.headline}. ${summary.basis}"
            },
        verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
            // 26sp, and it is the only thing on the screen set that big. This
            // line is read first or the app has not done its job.
            Text(
                summary.headline,
                style = Design.Style.greeting,
                // Ink when the quiet holds, the tone when it does not. Calm
                // reads as ordinary text; trouble is the only thing on this
                // screen that is coloured for its own sake — and the sentence
                // says which it is either way.
                color = if (summary.settled) Design.Palette.ink.now else tint,
            )
        }
        Text(summary.basis, style = Design.Style.bodySmall, color = Design.Palette.inkDim.now)
    }
}
