package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Sessions that were forgotten and are still recoverable.
 *
 * IT LIVES WITH SESSIONS, NOT WITH MACHINES. It was under each host's row in
 * settings, because that is where the volumes are — an implementation detail
 * leaking into the layout. A person forgetting a session is not thinking about
 * which box held it, and by three entries across two hosts the Fleet section
 * was unreadable.
 *
 * Reachable when EMPTY too, which is the other half: a safety net nobody can
 * find until they need it does not reassure anybody, and the app looked for a
 * while like it had no recycle bin at all.
 *
 * Matches the iOS screen field for field.
 */
@Composable
fun RecycleBinSheet(settings: Settings, hosts: List<Fleet.FleetHost>, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var purgeTarget by remember { mutableStateOf<String?>(null) }

    // Flattened across hosts, soonest to go first: the deadline is what
    // somebody is deciding on, and which machine holds the volume is a detail
    // they can see but need not sort by.
    val items = hosts.flatMap { host -> host.bin.map { host.hostId to it } }.sortedBy { it.second.expiresAt }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Recycle bin") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (items.isEmpty()) {
                    // Says what the feature IS, to somebody who has never used
                    // it. An empty screen that only says "empty" teaches
                    // nothing, and this is the answer to a mistake people make
                    // at most once.
                    Text("Nothing here.", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Forgetting a session puts it here for seven days rather than deleting it. Its "
                            + "conversation and workspace are kept, and restoring brings both back.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                items.forEach { (hostId, item) ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(item.title ?: item.name, style = MaterialTheme.typography.titleSmall)
                        Text(
                            listOfNotNull(item.title?.let { item.name }, "on $hostId", item.remaining)
                                .joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        val reply = Fleet(settings).restore(item.name)
                                        // THE APP WRITES ITS OWN SENTENCE. The
                                        // host's reply is written for chat and
                                        // ends in "/restore <name> brings it
                                        // back" — correct there, nonsense here,
                                        // where there is nothing to type and a
                                        // button that already did it.
                                        result = if (!reply.ok) reply.text else "Restored ${item.name}."
                                        busy = false
                                        onChanged()
                                    }
                                },
                            ) { Text("Restore") }
                            TextButton(enabled = !busy, onClick = { purgeTarget = item.name }) { Text("Delete now") }
                        }
                    }
                }

                purgeTarget?.let { target ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Delete $target for good?", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "The conversation and the workspace go with it. This is the only step here that "
                                + "cannot be undone — forgetting was reversible, this is not.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    scope.launch {
                                        busy = true
                                        val reply = Fleet(settings).purge(target)
                                        result = if (!reply.ok) reply.text else "Deleted $target."
                                        purgeTarget = null
                                        busy = false
                                        onChanged()
                                    }
                                },
                            ) { Text("Delete") }
                            TextButton(onClick = { purgeTarget = null }) { Text("Cancel") }
                        }
                    }
                }

                if (result.isNotBlank()) {
                    Text(result, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}
