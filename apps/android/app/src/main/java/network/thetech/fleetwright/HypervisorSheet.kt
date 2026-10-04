package network.thetech.fleetwright

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Machines, Add a hypervisor: a Xen Orchestra pool onboarded by one machine
 * already in the fleet, from this phone. docs/hypervisors.md; the arithmetic
 * is in XoSetup.kt and the words here are iOS's too.
 *
 * FOUR THINGS, IN THE ORDER THEY CAN HAPPEN. An address, and which machines
 * can reach it (`xoprobe`); a machine and the admin sign-in; the machine's
 * key for this job, checked before anything is sealed to it; then the steps as
 * the machine runs them, polled only while this screen is open, because the
 * fleet also pushes them to a notification (XoSetupNotice) for the phone in a
 * pocket.
 *
 * THE PASSWORD IS IN MEMORY FOR AS LONG AS IT TAKES TO SEAL IT, and no longer.
 * It is sealed to the job's key on this phone, so the coordinator relays
 * ciphertext; the field is cleared the moment the sealed string exists, and
 * again on every way out of the sign-in step. Nothing here writes it anywhere,
 * logs it, or hands it to the outbox: every send is given an id, which is what
 * keeps a send the fleet did not answer off this phone's disk (Fleet.xosetup).
 *
 * @param resumeJob a job a notification was tapped for: straight to its
 *   progress, from `status`, with nothing to type.
 */
@Composable
internal fun HypervisorSheet(settings: Settings, resumeJob: String? = null, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }

    var address by remember { mutableStateOf("") }
    var probing by remember { mutableStateOf(false) }
    // NULL IS NOT ASKED. An empty list is a fleet with nothing permanent to ask.
    var probes by remember { mutableStateOf<List<Fleet.Probe>?>(null) }
    var probeText by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf<String?>(null) }

    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var beginning by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf("") }

    // A `begin` answer this phone could not vouch for by itself, waiting on
    // the person's comparison. Cleared either way.
    var unvouched by remember { mutableStateOf<Fleet.Setup?>(null) }
    var unvouchedHost by remember { mutableStateOf("") }

    var job by remember { mutableStateOf(resumeJob) }
    var runningOn by remember { mutableStateOf("") }
    var progress by remember { mutableStateOf<Fleet.Setup?>(null) }
    var cancelling by remember { mutableStateOf(false) }

    val addressOk = XoSetup.ADDRESS_RE.matches(address.trim())
    val reachable = probes.orEmpty().filter { it.reachable && it.tls && it.cert != null }
    val pick = reachable.firstOrNull { it.hostId == chosen }

    fun probe() {
        scope.launch {
            probing = true
            probeText = ""
            probes = null
            chosen = null
            val r = fleet.xoprobe(address.trim())
            if (r.ok && r.probes != null) {
                probes = r.probes
                // One machine that can is chosen for them; two is a decision.
                chosen = r.probes.filter { it.reachable && it.tls && it.cert != null }.singleOrNull()?.hostId
            } else {
                probeText = r.text.ifBlank { "The fleet did not answer the probe." }
            }
            probing = false
        }
    }

    /** `run`: seal the sign-in to the job's key, drop the password, send. */
    suspend fun run(setup: Fleet.Setup, hostId: String) {
        val key = setup.key ?: return
        val sealed = XoSetup.sealSignIn(key, setup.job, address.trim(), email.trim(), password)
        password = ""
        val r = fleet.xosetup("run", job = setup.job, sealed = sealed)
        if (!r.ok) {
            refusal = r.text.ifBlank { "$hostId did not take the sign-in." }
            return
        }
        job = setup.job
        runningOn = r.hostId ?: hostId
        progress = r.xosetup ?: setup.copy(state = "running")
    }

    /**
     * `begin`, then the check that decides whether anything is sealed at all:
     * the machine's signature over the job's key, by the enrolment key the
     * fleet lists for it, and whether this phone has already approved that
     * key for its vault. docs/hypervisors.md, "The credential".
     */
    fun begin() {
        val p = pick ?: return
        val pin = p.cert ?: return
        scope.launch {
            beginning = true
            refusal = ""
            val where = address.trim()
            val r = fleet.xosetup("begin", address = where, pin = pin, host = p.hostId)
            val setup = r.xosetup
            val hostId = r.hostId ?: p.hostId
            when {
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not start the setup." }
                setup.key == null || !XoSetup.verifyKeySig(setup.hostKey, setup.keySig, runCatching { XoSetup.signingInput(where, setup.job, setup.key, pin) }.getOrDefault(ByteArray(0))) -> {
                    // A HARD STOP. The key was not signed by the key offered as
                    // the machine's, so it is nobody's key worth sealing to.
                    password = ""
                    refusal = "That key did not come from $hostId. Nothing was sent. Something between this phone and that machine is not what it says it is, so check the fleet before trying again."
                }
                else -> {
                    val fingerprint = PhoneVault.fingerprint(setup.hostKey!!)
                    // THE KEY THE FLEET ALREADY LISTS FOR THIS MACHINE. A
                    // different one here is the same hard stop: whichever is
                    // the machine's, the other is not.
                    val listed = runCatching { fleet.enrolledHosts() }.getOrDefault(emptyList())
                        .firstOrNull { it.hostId == hostId }?.publicJwk?.let { PhoneVault.fingerprint(it) }
                    val approved = PhoneGitHub(settings).signedIn &&
                        runCatching { PhoneVault(settings).list(fleet) }.getOrNull()?.grants?.any { it.fingerprint == fingerprint } == true
                    when {
                        listed != null && listed != fingerprint -> {
                            password = ""
                            refusal = "That key did not come from $hostId: the fleet lists a different key for it. Nothing was sent."
                        }
                        approved -> run(setup, hostId)
                        else -> {
                            unvouched = setup
                            unvouchedHost = hostId
                        }
                    }
                }
            }
            beginning = false
        }
    }

    // THE POLL, ONLY WHILE THIS IS ON SCREEN. Leaving the screen cancels the
    // effect; the notification carries on without it.
    LaunchedEffect(job) {
        val id = job ?: return@LaunchedEffect
        while (isActive) {
            val state = progress?.state
            if (state == "done" || state == "failed" || state == "cancelled") break
            if (progress != null) delay(2_000)
            val r = fleet.xosetup("status", job = id)
            if (r.ok && r.xosetup != null) {
                progress = r.xosetup
                refusal = ""
                r.hostId?.let { runningOn = it }
            } else if (progress == null) {
                // Resumed on a job the fleet no longer knows: say so, once.
                progress = Fleet.Setup(id, "failed", null, null, null, r.text.ifBlank { "The fleet does not know that setup any more." }, null, null, null, null)
            } else if (!r.ok) {
                // The bar stays where it was; the sentence says the fleet
                // stopped answering, and the next answer clears it.
                refusal = r.text.ifBlank { "The fleet did not answer about the setup." }
            }
        }
    }

    FullScreen(title = "Add a hypervisor", onDismiss = { password = ""; onDismiss() }) {
        val setup = progress
        val waitingOn = unvouched
        when {
            job != null -> {
                SectionHead("Setting up")
                if (runningOn.isNotBlank()) Hint("On $runningOn", color = Design.Palette.ink.now)
                if (setup == null) {
                    Hint("Asking where it has got to…")
                } else {
                    SetupProgress(setup)
                    when (setup.state) {
                        "running", "waiting" -> {
                            TextButton(
                                enabled = !cancelling,
                                onClick = {
                                    scope.launch {
                                        cancelling = true
                                        val r = fleet.xosetup("cancel", job = setup.job)
                                        if (r.ok && r.xosetup != null) progress = r.xosetup
                                        else if (!r.ok) refusal = r.text.ifBlank { "Could not cancel." }
                                        cancelling = false
                                    }
                                },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                            Hint("It stops between steps. What was made so far is tagged fleetwright, and running the setup again picks up from what exists.")
                        }
                        else -> {
                            TextButton(
                                onClick = {
                                    job = null
                                    progress = null
                                    refusal = ""
                                    password = ""
                                },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text("Start again") }
                        }
                    }
                }
            }
            waitingOn != null -> {
                SectionHead("Is that $unvouchedHost's key?")
                Hint(
                    "$unvouchedHost signed the key your sign-in will be sealed to, and this phone has not approved " +
                        "that machine before. Compare this with what fleetwright-sidecar identity prints on $unvouchedHost.",
                )
                SelectionContainer {
                    Text(
                        PhoneVault.fingerprint(waitingOn.hostKey!!),
                        style = Design.Style.title,
                        fontFamily = FontFamily.Monospace,
                        color = Design.Palette.ink.now,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(
                        onClick = {
                            val s = waitingOn
                            val h = unvouchedHost
                            unvouched = null
                            scope.launch { run(s, h) }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("They match") }
                    TextButton(
                        onClick = {
                            unvouched = null
                            password = ""
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("Cancel") }
                }
                Hint("If they differ, cancel: the sign-in has not left this phone, and will not.")
            }
            else -> {
                SectionHead("Where Xen Orchestra answers")
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it.trim() },
                    label = { Text("Address") },
                    supportingText = { Text("A host name or IP address, with a port if it is not 443. No https://.") },
                    singleLine = true,
                    isError = address.isNotBlank() && !addressOk,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(
                    enabled = !probing && addressOk,
                    onClick = { probe() },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (probing) "Asking every machine…" else "Find a machine that can reach it") }
                if (probeText.isNotBlank()) Hint(probeText, color = Design.Palette.bad.now)

                val found = probes
                if (found != null) {
                    SectionHead("Which machine runs the setup")
                    when {
                        found.isEmpty() -> Hint("This fleet has no permanent machine to ask. Add a machine first; a temporary one cannot hold the pool's token.")
                        reachable.isEmpty() -> {
                            Hint(
                                "No machine reached $address over HTTPS. Check the address and the port, that Xen Orchestra is " +
                                    "running, and that one of these machines is on a network that can see it.",
                                color = Design.Palette.attention.now,
                            )
                            found.forEach { p -> ProbeLine(p) }
                        }
                        else -> {
                            Hint("Only a machine that reaches it can. The machine keeps the pool's token afterwards, so pick one that stays.")
                            reachable.forEach { p ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .selectable(selected = p.hostId == chosen, role = Role.RadioButton, onClick = { chosen = p.hostId }),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(selected = p.hostId == chosen, onClick = null)
                                    Spacer(Modifier.width(Design.Space.insideTight))
                                    Column(Modifier.weight(1f)) {
                                        Text(p.hostId, style = Design.Style.body, color = Design.Palette.ink.now)
                                        Text(XoSetup.describe(p), style = Design.Style.label, color = Design.Palette.inkDim.now)
                                    }
                                }
                            }
                            found.filter { it !in reachable }.forEach { p -> ProbeLine(p) }
                        }
                    }
                }

                val cert = pick?.cert
                if (pick != null && cert != null) {
                    // THE PIN. The machine sends the sign-in only to an address
                    // that answers with this certificate, so this is the thing
                    // to compare with the padlock in a browser before going on.
                    Text("Certificate SHA-256", style = Design.Style.label, color = Design.Palette.inkDim.now)
                    SelectionContainer {
                        Text(
                            XoSetup.groupedPin(cert),
                            style = Design.Style.label,
                            fontFamily = FontFamily.Monospace,
                            color = Design.Palette.ink.now,
                        )
                    }
                    Hint("The certificate ${pick.hostId} saw at $address. Compare it with the one your browser shows for Xen Orchestra; the machine refuses to send the sign-in to any other.")

                    SectionHead("Xen Orchestra admin sign-in")
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it.trim() },
                        label = { Text("Admin email") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Email,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Admin password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Password,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Hint(
                        "Used once, on ${pick.hostId}, to make a limited fleetwright user and its token, then dropped. " +
                            "It is sealed to that machine on this phone; the fleet relays it and cannot read it.",
                    )
                    OutlinedButton(
                        enabled = !beginning && email.isNotBlank() && password.isNotEmpty(),
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (beginning) "Checking ${pick.hostId}'s key…" else "Set up on ${pick.hostId}") }
                }
            }
        }
        if (refusal.isNotBlank()) Hint(refusal, color = Design.Palette.bad.now)
    }
}

/** A machine that cannot run it, and why, in one dim line. */
@Composable
private fun ProbeLine(p: Fleet.Probe) {
    Text("${p.hostId} · ${XoSetup.describe(p)}", style = Design.Style.label, color = Design.Palette.inkDim.now)
}

/**
 * The bar and the sentence. The step words crossfade when they change and the
 * bar moves to its new place: a change of state is news (MOTION 2), and the
 * crossfade is what Reduce Motion keeps.
 */
@Composable
private fun SetupProgress(setup: Fleet.Setup) {
    val of = setup.of ?: XoSetup.STEPS.size
    val step = setup.step ?: 0
    val ended = setup.state == "done" || setup.state == "failed" || setup.state == "cancelled"
    val fraction = if (setup.state == "done") 1f else (step.toFloat() / of.coerceAtLeast(1)).coerceIn(0f, 1f)
    val shown by animateFloatAsState(fraction, animationSpec = Design.Motion.change(), label = "setup progress")
    val tone = when (setup.state) {
        "done" -> Design.Palette.ok.now
        "failed" -> Design.Palette.bad.now
        "cancelled" -> Design.Palette.idle.now
        else -> Design.Palette.active.now
    }
    val words = when (setup.state) {
        "waiting" -> "Waiting for the sign-in"
        "done" -> "Added"
        "failed" -> "Stopped"
        "cancelled" -> "Cancelled"
        else -> XoSetup.stepWords(setup.phase, step, of)
    }
    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        LinearProgressIndicator(
            progress = { shown },
            color = tone,
            trackColor = Design.Palette.track.now,
            modifier = Modifier.fillMaxWidth().padding(top = Design.Space.hair),
        )
        AnimatedContent(
            targetState = words,
            transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
            label = "setup step",
        ) { w ->
            Text(w, style = Design.Style.bodyStrong, color = if (ended) tone else Design.Palette.ink.now)
        }
        if (!ended && setup.state == "running") {
            Text("Step ${(step + 1).coerceAtMost(of)} of $of", style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
        setup.text?.let { Quoted(it) }
    }
}
