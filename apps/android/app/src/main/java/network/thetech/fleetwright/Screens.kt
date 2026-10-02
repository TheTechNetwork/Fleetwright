package network.thetech.fleetwright

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * A screen of its own, over the tab it was opened from.
 *
 * EVERY SECONDARY SCREEN WAS AN AlertDialog: a narrow card with a scroll inside
 * it, a single "Done" in the corner, and a keyboard that covered whichever
 * field was at its foot. A machine's page, Credentials, Devices and the rest
 * are pages, so they get the whole screen, a title, and room for the IME.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FullScreen(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Design.Palette.bg.now,
            topBar = {
                TopAppBar(
                    title = { Text(title) },
                    actions = { TextButton(onClick = onDismiss) { Text("Done") } },
                )
            },
        ) { padding ->
            Column(
                Modifier
                    .padding(padding)
                    .imePadding()
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Design.Space.page, vertical = Design.Space.groupTight),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
                content = content,
            )
        }
    }
}

/** A section's heading, in the design's section style. */
@Composable
fun SectionHead(text: String) {
    Text(text, style = Design.Style.section, color = Design.Palette.ink.now, modifier = Modifier.padding(top = Design.Space.insideTight))
}

/** A sentence under a section, in the dim body style. */
@Composable
fun Hint(text: String, color: androidx.compose.ui.graphics.Color = Design.Palette.inkDim.now) {
    Text(text, style = Design.Style.bodySmall, color = color)
}

/**
 * A row that opens something: the label, a chevron, and 48dp of target
 * whatever the type size. Role.Button, so TalkBack says it can be activated.
 */
@Composable
fun OpenRow(label: String, value: String? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
        value?.let { Text(it, style = Design.Style.label, color = Design.Palette.inkDim.now) }
        Text("  ›", style = Design.Style.body, color = Design.Palette.inkDim.now)
    }
}

/** A machine's or a coordinator's own words: quoted, monospaced, on the inner surface. */
@Composable
fun Quoted(text: String) {
    SelectionContainer {
        Text(
            text,
            style = Design.Style.label,
            fontFamily = FontFamily.Monospace,
            color = Design.Palette.ink.now,
            modifier = Modifier
                .fillMaxWidth()
                .background(Design.Palette.inner.now)
                .padding(Design.Space.insideTight),
        )
    }
}

/**
 * "2 people · eli@example.com · max", or the fault when it is nobody.
 *
 * The org is dropped when it is only the address again — Google and Anthropic
 * both name a personal organisation that way, so on a single-person account it
 * is guaranteed noise.
 */
fun describeWhoCanStart(accounts: Int, host: Fleet.FleetHost): String {
    // THE ZERO CASE KEEPS ITS WORDS. It is the only real fault here, and
    // naming the Claude account is what makes it actionable.
    if (accounts == 0) return "Nobody has connected a Claude account here — sessions will not start"
    val parts = mutableListOf("$accounts ${if (accounts == 1) "person" else "people"}")
    host.accountEmail?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    host.accountPlan?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    host.accountOrg?.takeIf { it.isNotBlank() && !it.startsWith(host.accountEmail ?: "\u0000") }?.let { parts.add(it) }
    return parts.joinToString(" · ")
}

/**
 * "0223f94 · 1 commit behind · rolling", or as much of it as is known: what is
 * it running, is that current, and what will it take next.
 */
fun describeRunning(host: Fleet.FleetHost): String {
    val parts = mutableListOf<String>()
    host.version?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    val behind = host.behind ?: 0
    when {
        // FIRST, because it is the one thing on this line somebody can act on
        // right now. A box can have nothing left to fetch and still be running
        // an old release.
        host.restartWaitingFor != null -> parts.add("${host.restartWaitingFor} installed, restart waiting")
        behind > 0 -> parts.add("$behind commit${if (behind == 1) "" else "s"} behind")
        host.release?.available != null -> parts.add("${host.release.available} waiting")
        // A migratable checkout counts no commits and names no release version.
        host.appPending -> parts.add("update waiting")
        // "UP TO DATE" IS A CLAIM. Not knowing is its own state and gets its
        // own words.
        !host.appStatusKnown -> parts.add("update status unknown")
        host.version != null -> parts.add("up to date")
    }
    // BESIDE THE BRANCH ABOVE, NOT INSTEAD OF IT. Same words as iOS, held equal
    // by test/root-half-shown.test.js.
    if (host.rootHalfBehind) parts.add("update helper out of date")
    host.channel?.takeIf { it.isNotBlank() }?.let {
        // Pinned is worth a word, because it is why the picker is missing.
        parts.add(if (host.channelPinned) "$it, set on the box" else it)
    }
    return if (parts.isEmpty()) "version not reported" else parts.joinToString(" · ")
}

/** The one line on the box that turns a grant on. The app never runs it. */
fun grantLine(name: String): String = "sudo fleetwright grant $name on"

/**
 * A grant that is off: the fact, then the line, selectable so it can be copied
 * into a terminal. Dim, not a fault colour — the box is doing what somebody
 * decided.
 */
@Composable
fun GrantOff(fact: String, line: String) {
    Text(fact, style = Design.Style.bodySmall, color = Design.Palette.inkDim.now)
    SelectionContainer {
        Text(line, style = Design.Style.bodySmall, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
    }
}

/** Milliseconds since the epoch, as words. */
fun relative(at: Long): CharSequence =
    android.text.format.DateUtils.getRelativeTimeSpanString(
        at,
        System.currentTimeMillis(),
        android.text.format.DateUtils.MINUTE_IN_MILLIS,
    )
