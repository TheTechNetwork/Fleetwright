package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Browsing a session's workspace from a phone.
 *
 * The last item on the roadmap, and the one it called "deliberately last —
 * largest new attack surface in the product". Everything that makes it safe is
 * on the host (docs/filesystem.md): the path is confined three times, the
 * container mounts one volume read-only and has no network.
 *
 * NOTHING HERE IS A SECURITY CONTROL, and this file should not read as though
 * it were — an app that validated paths would be an app somebody later trusted
 * to. What it is responsible for is the other half: not lying to the person
 * holding it. A refusal from the host is shown verbatim, because the host is
 * the only thing that knows why.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesSheet(
    fleet: Fleet,
    session: String,
    host: String?,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var path by remember { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<Fleet.Entry>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var reading by remember { mutableStateOf<Pair<String, String>?>(null) }
    var deleting by remember { mutableStateOf<Fleet.Entry?>(null) }

    suspend fun load() {
        loading = true
        val reply = fleet.files(session, path, host)
        loading = false
        if (!reply.ok) {
            // VERBATIM. The host distinguishes "no such directory" from "that
            // path leaves the workspace" from "this session has no workspace",
            // and each is a different thing to do next.
            problem = reply.text.ifBlank { "That directory could not be read." }
            entries = emptyList()
            return
        }
        problem = null
        // THE FIELD, NEVER THE TEXT. `entries` is data; `text` is a rendering
        // of it for a person, and an app that parsed the rendering would break
        // the first time somebody improved the wording.
        entries = reply.entries
    }

    LaunchedEffect(path) { load() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text(
                if (path.isEmpty()) "Workspace" else path,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                session,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.padding(4.dp))

            problem?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.padding(4.dp))
            }

            if (loading && entries.isEmpty()) {
                CircularProgressIndicator(Modifier.padding(16.dp))
            }

            LazyColumn {
                if (path.isNotEmpty()) {
                    item {
                        Text(
                            "⬆︎  Up",
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { path = parentOf(path) }
                                .padding(vertical = 12.dp),
                        )
                        HorizontalDivider()
                    }
                }
                items(entries, key = { it.name }) { entry ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable {
                                if (entry.isDirectory) {
                                    path = joinPath(path, entry.name)
                                } else {
                                    scope.launch {
                                        val reply = fleet.readFile(session, joinPath(path, entry.name), host)
                                        if (!reply.ok) {
                                            // "not text", "too big", "leaves the
                                            // workspace" — different facts, and
                                            // the host is what knows which.
                                            problem = reply.text.ifBlank { "That file could not be read." }
                                        } else {
                                            problem = null
                                            reading = entry.name to reply.text
                                        }
                                    }
                                }
                            }
                            .padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // A symlink is drawn as what it is: the host may refuse
                        // to follow it out of the workspace, and somebody who
                        // can see it is a link is not surprised by that.
                        Text(if (entry.isDirectory) "📁" else if (entry.kind == "link") "🔗" else "📄")
                        Spacer(Modifier.padding(horizontal = 6.dp))
                        Text(entry.name, Modifier.weight(1f))
                        if (!entry.isDirectory) {
                            Text(
                                humanSize(entry.size),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { deleting = entry }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete ${entry.name}")
                        }
                    }
                    HorizontalDivider()
                }
                if (entries.isEmpty() && !loading && problem == null) {
                    item {
                        Text(
                            "This directory is empty.",
                            Modifier.padding(vertical = 12.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    reading?.let { (name, body) ->
        AlertDialog(
            onDismissRequest = { reading = null },
            confirmButton = { TextButton(onClick = { reading = null }) { Text("Done") } },
            title = { Text(name) },
            text = {
                // MONOSPACED AND UNWRAPPED. This is source and output, and
                // reflowing it moves the columns somebody is reading.
                Text(
                    body,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState()),
                )
            },
        )
    }

    deleting?.let { target ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${target.name}?") },
            // NOT RECOVERABLE, and said plainly. `forget` keeps a session for
            // seven days; this keeps nothing, which is the whole reason there
            // is a confirmation here at all.
            text = { Text("This cannot be undone. Forgetting a session keeps it for seven days; deleting a file keeps nothing.") },
            confirmButton = {
                TextButton(onClick = {
                    val entry = target
                    deleting = null
                    scope.launch {
                        val reply = fleet.deleteFile(session, joinPath(path, entry.name), host)
                        if (!reply.ok) problem = reply.text.ifBlank { "That could not be deleted." }
                        load()
                    }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

// Paths, for display only.
//
// These build the string sent to the host. They are NOT a security check — the
// host confines the path three times and is the only thing that can, since a
// symlink is invisible from here. A `..` guard in this file would be something
// for somebody to rely on later.

private fun joinPath(base: String, name: String): String = if (base.isEmpty()) name else "$base/$name"

private fun parentOf(p: String): String = p.substringBeforeLast('/', "")

private fun humanSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format("%.1f MB", bytes / 1_048_576.0)
}
