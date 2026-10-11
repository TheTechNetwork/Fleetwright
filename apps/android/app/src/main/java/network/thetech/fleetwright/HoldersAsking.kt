package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * One of the pools' own machines waiting on you, at the top of Machines: the
 * same shape as every other card (RHYTHM 1), wearing the attention ring when
 * it has asked to join. HoldersAskingView.swift is the same on iOS.
 *
 * LET IT IN IS ONE APPROVAL. The phone's check opens the secrets this phone
 * gave the policy jobs that made them (HolderJoin); the request one of them
 * proves is the one let in, so the fleet enrols that key and the vault lets
 * the same key hold that pool and nothing else of yours. A request none of
 * them proves is said as such and nothing is let in.
 *
 * ONLY WHAT EXISTS (C-2). A name nobody has asked under yet has no buttons.
 */
@Composable
internal fun HolderAskingCard(settings: Settings, waiting: HolderJoin.Waiting, onChanged: suspend () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember(waiting.hostId) { mutableStateOf(false) }
    var said by remember(waiting.hostId) { mutableStateOf<String?>(null) }
    // Let in from this card: it stays to say so, without buttons, for as long
    // as the screen is open.
    var admitted by remember(waiting.hostId) { mutableStateOf(false) }
    val asked = waiting.requests.isNotEmpty()

    fun letIn() = scope.launch {
        busy = true
        try {
            val secrets = HolderJoin.unlock(context, settings, waiting.address, HolderJoin.reason(waiting.hostId, waiting.address)) ?: return@launch
            if (secrets.isEmpty()) {
                said = HolderJoin.notThisPhone(waiting.hostId)
                return@launch
            }
            val match = HolderJoin.proven(waiting, secrets.map { it.value })
            if (match == null) {
                said = HolderJoin.notProven(waiting.hostId)
                return@launch
            }
            val (request, value) = match
            val fleet = Fleet(settings)
            val answer = fleet.approveHolder(waiting.hostId, request.key).getOrElse {
                said = it.message ?: "The fleet did not let ${waiting.hostId} in."
                return@launch
            }
            if (!answer.ok) {
                said = answer.text.ifBlank { "The fleet did not let ${waiting.hostId} in." }
                return@launch
            }
            admitted = true
            secrets.firstOrNull { it.value == value }?.let { HolderJoin.spent(settings, waiting.address, it) }
            said = PhoneVault(settings).approveHolder(fleet, waiting.hostId, request.publicJwk, waiting.address).fold(
                onSuccess = { HolderJoin.joined(waiting.hostId, waiting.address) },
                onFailure = { HolderJoin.joinedNotHolding(waiting.hostId, it.message ?: "the vault did not answer.") },
            )
            onChanged()
        } finally {
            busy = false
        }
    }

    fun decline() = scope.launch {
        busy = true
        try {
            val fleet = Fleet(settings)
            for (request in waiting.requests) fleet.declineHolder(waiting.hostId, request.key)
            onChanged()
        } finally {
            busy = false
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = if (asked && !admitted) Design.Palette.attention.now else Design.Palette.ring.now)
            .heightIn(min = 48.dp)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.hair),
    ) {
        Text(
            if (asked) HolderJoin.asks(waiting.hostId) else waiting.hostId,
            style = Design.Style.bodyStrong,
            fontFamily = FontFamily.Monospace,
            color = Design.Palette.ink.now,
        )
        Text(
            if (asked) HolderJoin.toHold(waiting.address) else HolderJoin.notYet(waiting.hostId),
            style = Design.Style.label,
            color = Design.Palette.inkDim.now,
        )
        said?.let { Text(it, style = Design.Style.label, color = Design.Palette.ink.now) }
        if (asked && !admitted) {
            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                Button(enabled = !busy, onClick = { letIn() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Let it in") }
                OutlinedButton(enabled = !busy, onClick = { decline() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Decline") }
            }
        }
    }
}
