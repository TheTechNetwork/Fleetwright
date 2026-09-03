package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
fun KindsSheet(settings: Settings, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val kinds = remember { mutableStateListOf<SessionKind>().apply { addAll(SessionKinds.all(context)) } }
    var newWord by remember { mutableStateOf("") }
    // BY NAME, DEDUPLICATED ACROSS HOSTS. A kind is a word somebody says, not a
    // placement: two boxes may both have a profile called "reviewer", and a
    // kind that pinned one of them would send "start a reviewer session" at a
    // machine that happens to be busy. The start sheet resolves the host from
    // where the file actually is.
    var offered by remember { mutableStateOf(listOf<String>()) }
    LaunchedEffect(Unit) {
        offered = Fleet(settings).profiles().orEmpty().map { it.name }.distinct().sorted()
    }

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
                        + "nothing else to set up. A task makes the word do something: spoken, that is the "
                        + "only way a session gets one, because there is no screen to drive it from afterwards.",
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
                    // A TEXT FIELD WOULD HAVE BEEN SMALLER AND WRONG: a
                    // mistyped profile name saves fine, pre-fills nothing, and
                    // the kind quietly starts idle sessions forever — a setting
                    // that looks applied and is not.
                    //
                    // Only when the fleet has answered with something. A picker
                    // whose only entry is "Nothing" is furniture, and on a fleet
                    // with no profiles it would imply a broken feature.
                    if (offered.isNotEmpty()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AssistChip(
                                onClick = { kinds[i] = k.copy(profile = "") },
                                label = { Text(if (k.profile.isBlank()) "Idle \u2713" else "Idle") },
                            )
                            offered.forEach { name ->
                                AssistChip(
                                    onClick = { kinds[i] = k.copy(profile = if (k.profile == name) "" else name) },
                                    label = { Text(if (k.profile == name) "$name \u2713" else name) },
                                )
                            }
                        }
                    }
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
