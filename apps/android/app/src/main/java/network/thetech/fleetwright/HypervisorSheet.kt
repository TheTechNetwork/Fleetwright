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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.saveable.rememberSaveable
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
 * FIVE THINGS, IN THE ORDER THEY CAN HAPPEN. An address, and which machines
 * can reach it (`xoprobe`); the certificate that machine saw, which the
 * person acknowledges when it does not check out; a machine and the admin
 * sign-in; the machine's key for this job, checked before anything is sealed
 * to it; then the steps as the machine runs them, polled only while this
 * screen is open, because the fleet also pushes them to a notification
 * (XoSetupNotice) for the phone in a pocket.
 *
 * ONE CARD HERE ASKS A QUESTION, AND IT IS ONE OF TWO. A certificate that
 * checks out is one calm line. One that does not gets the attention ring the
 * design spends on exactly this, what is wrong with it in words, its
 * details, and a box the person ticks having read them; Set up stays off
 * until they do, and `begin` then carries `trust = accepted`, which is what
 * the host looks for before it will connect. A Xen Orchestra that answers in
 * plain HTTP, which is what the installer builds until it is given a
 * certificate, gets the other card in the same ring: that the password typed
 * here and the token the fleet keeps would cross that network readable, how
 * to give it HTTPS instead, and a box that says send it anyway; `begin` then
 * carries `plain = accepted` and no pin, and the host refuses it without.
 * Either box unticks itself when the address, the machine or the probe
 * changes, because it was about what those three named.
 *
 * THE PASSWORD IS IN MEMORY FOR AS LONG AS IT TAKES TO SEAL IT, and no longer.
 * It is sealed to the job's key on this phone, so the coordinator relays
 * ciphertext; the field is cleared the moment the sealed string exists, and
 * again on every way out of the sign-in step. Nothing here writes it anywhere,
 * logs it, or hands it to the outbox: every send is given an id, which is what
 * keeps a send the fleet did not answer off this phone's disk (Fleet.xosetup).
 * It is the one input NOT in rememberSaveable, for the same reason: saved
 * state is written to a Bundle, and a Bundle is a place.
 *
 * WHAT SURVIVES A ROTATION. The job, the machine running it, the address,
 * the machine chosen and the acknowledgement are saveable, so turning the
 * phone mid-setup comes back to the same progress rather than an empty form.
 * The probes are not: they are an answer from the fleet, and asking again is
 * one tap.
 *
 * @param resumeJob a job a notification was tapped for: straight to its
 *   progress, from `status`, with nothing to type.
 */
@Composable
internal fun HypervisorSheet(settings: Settings, resumeJob: String? = null, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }

    var address by rememberSaveable { mutableStateOf("") }
    var probing by remember { mutableStateOf(false) }
    // NULL IS NOT ASKED. An empty list is a fleet with nothing permanent to ask.
    var probes by remember { mutableStateOf<List<Fleet.Probe>?>(null) }
    var probeText by remember { mutableStateOf("") }
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    // The person has read what is wrong with the chosen machine's certificate
    // and trusts it anyway. About one certificate: reset with the address,
    // the machine, and every new probe.
    var acknowledged by rememberSaveable { mutableStateOf(false) }
    // The person has read that, with no HTTPS, the password and the token
    // would cross the network readable between the chosen machine and the
    // address, and said to send it anyway. About one machine at one address:
    // reset where the acknowledgement is.
    var plainAccepted by rememberSaveable { mutableStateOf(false) }

    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var beginning by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf("") }

    // A `begin` answer this phone could not vouch for by itself, waiting on
    // the person's comparison, with the inputs as they were when `begin` was
    // sent. Cleared either way.
    var unvouched by remember { mutableStateOf<Pending?>(null) }

    var job by rememberSaveable { mutableStateOf(resumeJob) }
    var runningOn by rememberSaveable { mutableStateOf("") }
    var progress by remember { mutableStateOf<Fleet.Setup?>(null) }
    // Whether the token the machine handed back is kept on this phone, once
    // the job is done (XoHandoff). Said only when this phone knows.
    var handedBack by remember { mutableStateOf<XoHandoff.Outcome?>(null) }
    var cancelling by remember { mutableStateOf(false) }
    // The fleet took a cancel: the button is not offered again, and what the
    // host said about it is shown instead.
    var cancelAccepted by rememberSaveable { mutableStateOf(false) }
    var cancelText by rememberSaveable { mutableStateOf("") }
    // The poll gave up: on the fleet's word that it has no such job (`gone`),
    // or after five unanswered asks. `asks` restarts it from Ask again.
    var pollStopped by remember { mutableStateOf(false) }
    var pollGone by remember { mutableStateOf(false) }
    var asks by rememberSaveable { mutableStateOf(0) }

    val addressOk = XoSetup.ADDRESS_RE.matches(address.trim())
    // WHO CAN RUN IT: the machines that reached it over HTTPS and saw a
    // certificate, then the ones answered in plain HTTP. The pinned ones
    // first, because they are the ones with nothing to accept.
    val pinned = probes.orEmpty().filter { XoSetup.pinned(it) }
    val reachable = pinned + probes.orEmpty().filter { XoSetup.plain(it) }
    val pick = reachable.firstOrNull { it.hostId == chosen }

    fun probe() {
        scope.launch {
            probing = true
            probeText = ""
            probes = null
            chosen = null
            acknowledged = false
            plainAccepted = false
            val r = fleet.xoprobe(address.trim())
            if (r.ok && r.probes != null) {
                probes = r.probes
                // One machine that can is chosen for them; two is a decision.
                // A lone plain-HTTP machine is chosen too: choosing it shows
                // the card that asks, and nothing is sent until it is answered.
                chosen = r.probes.filter { XoSetup.pinned(it) || XoSetup.plain(it) }.singleOrNull()?.hostId
            } else {
                probeText = r.text.ifBlank { "The fleet did not answer the probe." }
            }
            probing = false
        }
    }

    /**
     * `run`: seal the sign-in to the job's key, drop the password, send. The
     * address and the email are the ones `begin` was sent with, not whatever
     * the fields hold now: the job's key was signed over that address, and a
     * sign-in sealed under a different one would be refused as a replay.
     */
    suspend fun run(p: Pending) {
        val key = p.setup.key ?: return
        val reply = XoHandoff.newKey(settings, p.setup.job, p.where)
        val sealed = XoSetup.sealSignIn(key, p.setup.job, p.where, p.email, password, reply.publicKey)
        password = ""
        val r = fleet.xosetup("run", job = p.setup.job, sealed = sealed)
        if (!r.ok) {
            XoHandoff.forget(settings, p.setup.job)
            refusal = r.text.ifBlank { "${p.hostId} did not take the sign-in." }
            return
        }
        job = p.setup.job
        runningOn = r.hostId ?: p.hostId
        progress = r.xosetup ?: p.setup.copy(state = "running")
    }

    /**
     * `begin`, then the check that decides whether anything is sealed at all:
     * the machine's signature over the job's key, by the enrolment key the
     * fleet lists for it, and whether this phone has already approved that
     * key for its vault. docs/hypervisors.md, "The credential".
     */
    fun begin() {
        val p = pick ?: return
        // TWO SETUPS, NEVER MIXED. Pinned: the certificate's fingerprint, and
        // `trust` for one that did not check out. Plain: no pin at all, and
        // `plain = accepted`. The button is off until the box for whichever
        // this is has been ticked, so a return here is a path that should not
        // exist; refusing it is cheaper than finding out.
        val plain = XoSetup.plain(p)
        val pin = if (plain) null else (p.cert ?: return)
        if (plain && !plainAccepted) return
        val trust = if (plain) null else XoSetup.trustFor(p.certificate, acknowledged)
        if (!plain && p.certificate?.trusted != true && trust == null) return
        scope.launch {
            beginning = true
            refusal = ""
            val where = address.trim()
            val who = email.trim()
            val r = fleet.xosetup("begin", address = where, pin = pin, host = p.hostId, trust = trust, plain = if (plain) "accepted" else null)
            val setup = r.xosetup
            val hostId = r.hostId ?: p.hostId
            when {
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not start the setup." }
                // The machine signed over an empty pin for a plain setup, and
                // the phone checks the same bytes (XoSetup.signingInput).
                setup.key == null || !XoSetup.verifyKeySig(setup.hostKey, setup.keySig, runCatching { XoSetup.signingInput(where, setup.job, setup.key, pin ?: "") }.getOrDefault(ByteArray(0))) -> {
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
                    val pending = Pending(setup, hostId, where, who)
                    when {
                        listed != null && listed != fingerprint -> {
                            password = ""
                            refusal = "That key did not come from $hostId: the fleet lists a different key for it. Nothing was sent."
                        }
                        approved -> run(pending)
                        else -> unvouched = pending
                    }
                }
            }
            beginning = false
        }
    }

    fun startAgain() {
        job = null
        progress = null
        handedBack = null
        refusal = ""
        password = ""
        cancelAccepted = false
        cancelText = ""
        pollStopped = false
        pollGone = false
    }

    // THE POLL, ONLY WHILE THIS IS ON SCREEN. Leaving the screen cancels the
    // effect; the notification carries on without it. It ends when the setup
    // does, when the fleet says it has no such job, or after five asks in a
    // row went unanswered: a poll that runs for ever against a refusal is a
    // phone warming a pocket. Ask again restarts it.
    LaunchedEffect(job, asks) {
        val id = job ?: return@LaunchedEffect
        pollStopped = false
        pollGone = false
        var unanswered = 0
        while (isActive) {
            val state = progress?.state
            if (state == "done" || state == "failed" || state == "cancelled") break
            if (progress != null || unanswered > 0) delay(2_000)
            val r = fleet.xosetup("status", job = id)
            if (r.ok && r.xosetup != null) {
                progress = r.xosetup
                XoHandoff.collect(settings, id, r.xosetup)?.let { handedBack = it }
                if (r.xosetup.state == "failed" || r.xosetup.state == "cancelled") XoHandoff.forget(settings, id)
                refusal = ""
                unanswered = 0
                r.hostId?.let { runningOn = it }
                continue
            }
            // WHAT IS SHOWN IS THE REFUSAL, NOT A STATE. The bar stays where
            // it was, or stays absent: "Stopped" is the machine's word for
            // its own job, and a fleet that did not answer has not said it.
            unanswered++
            refusal = r.text.ifBlank { "The fleet did not answer about the setup." }
            if (r.code == "unknown_job" || unanswered >= 5) {
                pollGone = r.code == "unknown_job"
                pollStopped = true
                break
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
                    if (!pollStopped) Hint("Asking where it has got to…")
                } else {
                    SetupProgress(setup)
                }
                when (val outcome = handedBack) {
                    XoHandoff.Outcome.Kept -> Hint("The token is kept on this phone now, encrypted, and no machine in the fleet keeps a copy.")
                    is XoHandoff.Outcome.Failed -> Hint(outcome.why, color = Design.Palette.bad.now)
                    null -> {}
                }
                when {
                    pollStopped -> {
                        Hint(
                            if (pollGone) "The fleet has no setup with this id for you, so there is nothing more to ask it."
                            else "Asked five times with no answer, so this has stopped asking.",
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                            if (!pollGone) {
                                OutlinedButton(onClick = { asks++ }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Ask again") }
                            }
                            TextButton(onClick = { startAgain() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Start again") }
                        }
                    }
                    setup != null && (setup.state == "running" || setup.state == "waiting") && !cancelAccepted -> {
                        TextButton(
                            enabled = !cancelling,
                            onClick = {
                                scope.launch {
                                    cancelling = true
                                    val r = fleet.xosetup("cancel", job = setup.job)
                                    if (r.ok) {
                                        // OFFERED ONCE. The fleet has the cancel;
                                        // what the host said about it stands in
                                        // for the button until the state changes.
                                        cancelAccepted = true
                                        cancelText = r.text
                                        r.xosetup?.let { progress = it }
                                    } else {
                                        refusal = r.text.ifBlank { "Could not cancel." }
                                    }
                                    cancelling = false
                                }
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                        Hint("It stops between steps. What was made so far is tagged fleetwright, and running the setup again picks up from what exists.")
                    }
                    setup != null && (setup.state == "running" || setup.state == "waiting") -> {
                        Hint(cancelText.ifBlank { "Cancelling after this step." }, color = Design.Palette.ink.now)
                    }
                    setup != null -> {
                        TextButton(onClick = { startAgain() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Start again") }
                    }
                }
            }
            waitingOn != null -> {
                SectionHead("Is that ${waitingOn.hostId}'s key?")
                Hint(
                    "${waitingOn.hostId} signed the key your sign-in will be sealed to, and this phone has not approved " +
                        "that machine before. Compare this with what fleetwright-sidecar identity prints on ${waitingOn.hostId}.",
                )
                SelectionContainer {
                    Text(
                        PhoneVault.fingerprint(waitingOn.setup.hostKey!!),
                        style = Design.Style.title,
                        fontFamily = FontFamily.Monospace,
                        color = Design.Palette.ink.now,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(
                        onClick = {
                            unvouched = null
                            scope.launch { run(waitingOn) }
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
                    onValueChange = { typed ->
                        val next = typed.trim()
                        if (next != address) {
                            // A NEW ADDRESS IS A NEW QUESTION: the probes, the
                            // machine and the certificate were about the old one.
                            address = next
                            probes = null
                            probeText = ""
                            chosen = null
                            acknowledged = false
                            plainAccepted = false
                        }
                    },
                    label = { Text("Address") },
                    supportingText = { Text("A host name or IP address, with a port if it is not 443. No https://.") },
                    singleLine = true,
                    enabled = !beginning,
                    isError = address.isNotBlank() && !addressOk,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(
                    enabled = !probing && !beginning && addressOk,
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
                                "No machine reached $address. Check the address and the port, that Xen Orchestra is " +
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
                                        .selectable(
                                            selected = p.hostId == chosen,
                                            enabled = !beginning,
                                            role = Role.RadioButton,
                                            onClick = {
                                                if (chosen != p.hostId) {
                                                    chosen = p.hostId
                                                    // Another machine saw its own
                                                    // certificate, or its own lack
                                                    // of one; the tick was for the
                                                    // last one's.
                                                    acknowledged = false
                                                    plainAccepted = false
                                                }
                                            },
                                        ),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(selected = p.hostId == chosen, onClick = null, enabled = !beginning)
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

                if (pick != null) {
                    val cert = pick.cert
                    val plain = XoSetup.plain(pick)
                    val certificate = pick.certificate
                    val trusted = !plain && certificate?.trusted == true
                    when {
                        plain -> PlainAsk(pick, address, plainAccepted, enabled = !beginning, onAccepted = { plainAccepted = it })
                        certificate != null && trusted && cert != null -> {
                            // CALM. It checks out, so nothing is asked; the pin
                            // still shows, because it is what the machine holds
                            // the sign-in to.
                            Hint(XoSetup.trustedLine(certificate), color = Design.Palette.ink.now)
                            PinLines(cert, pick.hostId, address)
                        }
                        else -> CertificateAsk(pick, address, acknowledged, enabled = !beginning, onAcknowledged = { acknowledged = it })
                    }
                    // WHAT THE PERSON HAS SAID YES TO, for the card that was
                    // shown: nothing needed for a certificate that checks out.
                    val consented = if (plain) plainAccepted else (trusted || acknowledged)

                    SectionHead("Xen Orchestra admin sign-in")
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it.trim() },
                        label = { Text("Admin email") },
                        singleLine = true,
                        enabled = !beginning,
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
                        enabled = !beginning,
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
                    // OFF UNTIL THE CERTIFICATE IS EITHER FINE OR ACKNOWLEDGED,
                    // or plain HTTP has been accepted: the host would refuse
                    // anyway, and a button that leads to a refusal is a button
                    // that lied.
                    OutlinedButton(
                        enabled = !beginning && email.isNotBlank() && password.isNotEmpty() && consented,
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (beginning) "Checking ${pick.hostId}'s key…" else "Set up on ${pick.hostId}") }
                }
            }
        }
        if (refusal.isNotBlank()) Hint(refusal, color = Design.Palette.bad.now)
    }
}

/** A `begin` answer with the inputs it was sent for, which `run` seals under and not the fields' current text. */
private class Pending(val setup: Fleet.Setup, val hostId: String, val where: String, val email: String)

/** A machine that cannot run it, and why, in one dim line. */
@Composable
private fun ProbeLine(p: Fleet.Probe) {
    Text("${p.hostId} · ${XoSetup.describe(p)}", style = Design.Style.label, color = Design.Palette.inkDim.now)
}

/**
 * THE PIN. The machine sends the sign-in only to an address that answers
 * with this certificate, so this is the thing to compare with the padlock in
 * a browser before going on.
 */
@Composable
private fun PinLines(cert: String, hostId: String, address: String) {
    Text("Certificate SHA-256", style = Design.Style.label, color = Design.Palette.inkDim.now)
    SelectionContainer {
        Text(
            XoSetup.groupedPin(cert),
            style = Design.Style.label,
            fontFamily = FontFamily.Monospace,
            color = Design.Palette.ink.now,
        )
    }
    Hint("The certificate $hostId saw at $address. Compare it with the one your browser shows for Xen Orchestra; the machine refuses to send the sign-in to any other.")
}

/**
 * The card that asks: a certificate that does not check out, or one the
 * machine could not read. What is wrong, one line each in the words iOS
 * uses; then what it says about itself, each line only when the machine
 * said; then the pin; then the box. The attention ring is the one place
 * this screen spends a tone, and the heading carries the same word, so the
 * card reads the same with the colour gone.
 */
@Composable
private fun CertificateAsk(probe: Fleet.Probe, address: String, acknowledged: Boolean, enabled: Boolean, onAcknowledged: (Boolean) -> Unit) {
    val c = probe.certificate
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = Design.Palette.attention.now)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Text(
            if (c == null) "This certificate could not be checked" else "This certificate does not check out",
            style = Design.Style.bodyStrong,
            color = Design.Palette.attention.now,
        )
        XoSetup.problemLines(c, address).forEach { line ->
            Text(line, style = Design.Style.bodySmall, color = Design.Palette.ink.now)
        }
        if (c != null) {
            Detail("Issued to", c.subject)
            Detail("Issued by", c.issuer)
            Detail("Valid from", c.notBefore?.let { XoSetup.mediumDate(it) })
            Detail("Valid until", c.notAfter?.let { XoSetup.mediumDate(it) })
            Detail("Names", c.names.takeIf { it.isNotEmpty() }?.joinToString(", "))
        }
        probe.cert?.let { PinLines(it, probe.hostId, address) }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = acknowledged, enabled = enabled, role = Role.Checkbox, onValueChange = onAcknowledged),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = acknowledged, onCheckedChange = null, enabled = enabled)
            Spacer(Modifier.width(Design.Space.insideTight))
            Text("I checked this certificate and trust it", style = Design.Style.body, color = Design.Palette.ink.now)
        }
    }
}

/**
 * The other card that asks: a Xen Orchestra answering in plain HTTP. The same
 * ring and the same shape as CertificateAsk, because it is the same kind of
 * question, with different stakes: not "is this the right server" but "the
 * password and the token would be readable on the wire between these two".
 * It names both ends, because "the network" is nobody's network; it says how
 * to give the server HTTPS instead, in the installer's own variable names,
 * because the fix is on the far side and the person may well go and do it;
 * and the box says what ticking it does. The heading carries the word, so the
 * card reads the same with the colour gone.
 */
@Composable
private fun PlainAsk(probe: Fleet.Probe, address: String, accepted: Boolean, enabled: Boolean, onAccepted: (Boolean) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = Design.Palette.attention.now)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Text("This Xen Orchestra answers without HTTPS", style = Design.Style.bodyStrong, color = Design.Palette.attention.now)
        Text(
            "The admin password you type, and the token the fleet keeps afterwards, would cross the network between " +
                "${probe.hostId} and $address unencrypted. Anything on that network could read them.",
            style = Design.Style.bodySmall,
            color = Design.Palette.ink.now,
        )
        Text(
            "To give it HTTPS instead: in the installer's xo-install.cfg, set PORT=\"443\", PATH_TO_HTTPS_CERT, " +
                "PATH_TO_HTTPS_KEY and AUTOCERT=\"true\", then run it again.",
            style = Design.Style.bodySmall,
            color = Design.Palette.ink.now,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = accepted, enabled = enabled, role = Role.Checkbox, onValueChange = onAccepted),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = accepted, onCheckedChange = null, enabled = enabled)
            Spacer(Modifier.width(Design.Space.insideTight))
            Text("Send it without HTTPS anyway", style = Design.Style.body, color = Design.Palette.ink.now)
        }
    }
}

/** One thing a certificate says about itself. Absent is not drawn: a blank row would read as "none", and the machine said nothing. */
@Composable
private fun Detail(label: String, value: String?) {
    if (value == null) return
    Column {
        Text(label, style = Design.Style.label, color = Design.Palette.inkDim.now)
        SelectionContainer { Text(value, style = Design.Style.bodySmall, color = Design.Palette.ink.now) }
    }
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
