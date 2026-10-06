package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AssistChip
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Machines kept ready on your hypervisor, so a session starts in seconds.
 * docs/hypervisors.md, "Machines kept ready". iOS's VMStandbyView, in the
 * same words.
 *
 * Asked for: "standby vms to speed up session starts". Up to three machines
 * from one image, booted and joined: a session asking for that image on that
 * network starts on one at once, and the fleet makes another behind it. A
 * machine a session has used is never handed to the next one.
 *
 * WHAT IT COSTS IS SAID BEFORE IT IS ASKED FOR: each is a machine's worth of
 * the pool, all the time, replaced when its life runs out.
 */
@Composable
fun VmStandbyScreen(settings: Settings, images: List<Fleet.VmImage>, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var kept by remember { mutableStateOf<Fleet.VmStandby?>(null) }
    var template by remember { mutableStateOf(images.firstOrNull()?.template ?: "") }
    var network by remember { mutableStateOf("") }
    var count by remember { mutableStateOf(1) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    val chosen = images.firstOrNull { it.template == template }

    LaunchedEffect(Unit) {
        // A failure keeps what was shown: null is keeping none, not cannot tell.
        Fleet(settings).vmStandby().onSuccess { got ->
            kept = got
            if (got != null) {
                template = got.template
                network = got.network ?: ""
                count = got.count
            }
        }
    }

    FullScreen(title = "Keep machines ready", onDismiss = onDismiss) {
        SectionHead("Keep machines ready")
        Hint(kept?.let { "${it.ready} ready now, ${it.starting} being made, of ${it.count} kept." } ?: "None kept ready.")
        images.forEach { image ->
            AssistChip(
                onClick = { template = image.template; network = "" },
                label = { Text(if (template == image.template) "${image.label} ✓" else image.label) },
            )
        }
        val networks = chosen?.networks
        if (!networks.isNullOrEmpty()) {
            Text("Network", style = Design.Style.label, color = Design.Palette.inkDim.now)
            AssistChip(
                onClick = { network = "" },
                label = { Text(if (network.isEmpty()) "Behind the edge router ✓" else "Behind the edge router") },
            )
            networks.forEach { n ->
                AssistChip(onClick = { network = n.id }, label = { Text(if (network == n.id) "${n.name} ✓" else n.name) })
            }
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Keep $count ready", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
            TextButton(onClick = { count-- }, enabled = !busy && count > 0, modifier = Modifier.semantics { contentDescription = "Fewer" }) { Text("−") }
            TextButton(onClick = { count++ }, enabled = !busy && count < 3, modifier = Modifier.semantics { contentDescription = "More" }) { Text("+") }
        }
        OutlinedButton(
            onClick = {
                scope.launch {
                    busy = true
                    Fleet(settings).setVmStandby(if (count == 0) null else template, count, network.ifBlank { null })
                        .onSuccess { failed = !it.ok; message = it.text }
                        .onFailure { failed = true; message = it.message ?: "that did not work" }
                    Fleet(settings).vmStandby().onSuccess { kept = it }
                    busy = false
                }
            },
            enabled = !busy && (count == 0 || chosen != null),
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (count == 0) "Stop keeping any" else "Keep them ready") }
        if (message.isNotBlank()) Hint(message, if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        Hint(
            "A session from this image starts on a ready one at once, and another is made behind it. Each uses a machine’s worth of your pool all the time, and is replaced when its 350 minutes run out.",
        )
    }
}
