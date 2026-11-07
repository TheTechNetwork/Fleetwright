package network.thetech.fleetwright

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * The sentence behind a verdict, closed until asked for.
 *
 * A row says its one to three words and a page says its result; the
 * mechanism, the fleet's or the machine's own sentence on what was checked
 * and what it answered, is said once, behind this (docs/design-system.md,
 * "Words"). The same control the Credentials sheet has had for a provider's
 * scopes, in one place so every screen opens its sentence the same way: a
 * text button at the 48dp target, Details or Hide details, and the sentence
 * under it, selectable because it names paths and statuses that get
 * searched for. iOS's `DisclosureGroup("Details")` is the same thing.
 *
 * Remembered across rotation and not across a reopen: a person who opened
 * the sentence and turned the phone keeps it; one who comes back later
 * reads the verdict first, as the page intends.
 */
@Composable
fun Details(text: String, modifier: Modifier = Modifier) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(modifier) {
        TextButton(onClick = { open = !open }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(if (open) "Hide details" else Manage.Words.details)
        }
        if (open) {
            SelectionContainer {
                Text(text, style = Design.Style.label, color = Design.Palette.inkDim.now)
            }
        }
    }
}
