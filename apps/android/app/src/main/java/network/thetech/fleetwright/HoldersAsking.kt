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
import androidx.compose.runtime.LaunchedEffect
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
 * LET IT IN IS ONE APPROVAL, AND THE PHONE THAT MADE IT GIVES IT BY ITSELF.
 * The secrets this phone gave the policy jobs that made them (HolderJoin)
 * prove the request of the machine each made; the request one of them proves
 * is the one let in, so the fleet enrols that key and the vault lets the same
 * key hold that pool and nothing else of yours. As soon as a card with a
 * request is on screen the phone tries that quietly (HolderJoin.admit), and
 * the card says how it went; the buttons stay for a request it could not
 * settle by itself: one this phone did not make, or one whose secret is from
 * before, behind the owner's check, which the tap opens. A request none of
 * the secrets proves is said as such and nothing is let in.
 *
 * ONLY WHAT EXISTS (C-2). A name nobody has asked under yet has no buttons:
 * the line says what to do if it never asks, or that this phone will let it
 * in when it does.
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
    val mine = remember(waiting.address) { HolderJoin.made(settings, waiting.address) }

    /** What an approval, from a tap or by itself, leaves on the card. */
    suspend fun settle(outcome: HolderJoin.Outcome) {
        outcome.said?.let { said = it }
        if (outcome.isIn) {
            admitted = true
            onChanged()
        }
    }

    /** From the tap: the same approval, opening a secret from before behind the owner's check where that is what this phone keeps. */
    fun letIn() = scope.launch {
        busy = true
        try {
            settle(HolderJoin.admit(context, settings, waiting, quietly = false))
        } finally {
            busy = false
        }
    }

    // BY ITSELF, once per request on screen: the quiet pass. Keyed on the
    // keys asking, so a request that arrives while Machines is open is let in
    // without a tap, and a redraw tries nothing twice.
    LaunchedEffect(waiting.hostId, waiting.requests.map { it.key }.sorted().joinToString(",")) {
        if (!asked || admitted || busy) return@LaunchedEffect
        busy = true
        try {
            settle(HolderJoin.admit(context, settings, waiting, quietly = true))
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
        if (!asked && mine) Text(HolderJoin.byItself(waiting.hostId), style = Design.Style.label, color = Design.Palette.inkDim.now)
        said?.let { Text(it, style = Design.Style.label, color = Design.Palette.ink.now) }
        if (asked && !admitted) {
            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                Button(enabled = !busy, onClick = { letIn() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Let it in") }
                OutlinedButton(enabled = !busy, onClick = { decline() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Decline") }
            }
        }
    }
}
