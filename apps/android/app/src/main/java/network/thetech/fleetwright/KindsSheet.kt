package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * The words Assistant will recognise.
 *
 * THIS SCREEN FINISHES THE JOB. Adding a word here pushes a dynamic shortcut
 * whose `shortLabel` is that word, which is exactly what Assistant matches on —
 * so there is no second app to visit and nothing to paste.
 *
 * The iOS version of this cannot do that: an app may not register a Siri phrase,
 * so it hands off to Shortcuts for the last tap. That difference is deliberate
 * and stays. Bringing the handoff here so the two screens look alike would be
 * consistency serving us rather than the person holding the phone.
 */
@Composable
fun KindsSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val kinds = remember { mutableStateListOf<SessionKind>().apply { addAll(SessionKinds.all(context)) } }
    var newWord by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Session kinds") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "Say \"start a dev session\". A word here becomes a shortcut straight away — "
                        + "nothing else to set up.",
                    style = MaterialTheme.typography.bodySmall,
                )
                kinds.forEachIndexed { i, k ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = k.word,
                            onValueChange = { kinds[i] = k.copy(word = it) },
                            label = { Text("Word") },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { kinds.removeAt(i) }) { Text("Remove") }
                    }
                    OutlinedTextField(
                        value = k.titlePrefix,
                        onValueChange = { kinds[i] = k.copy(titlePrefix = it) },
                        label = { Text("Title prefix (optional)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = newWord,
                        onValueChange = { newWord = it },
                        label = { Text("Add a word") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = newWord.isNotBlank(),
                        onClick = {
                            kinds.add(SessionKind(word = newWord.trim()))
                            newWord = ""
                        },
                    ) { Text("Add") }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                // Saved and published together. save() pushes the shortcuts, so
                // there is no state where the stored list and what Assistant
                // offers disagree — which would show up as a phrase that works
                // for a word the user deleted.
                SessionKinds.save(context, kinds.filter { it.word.isNotBlank() })
                onDismiss()
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
