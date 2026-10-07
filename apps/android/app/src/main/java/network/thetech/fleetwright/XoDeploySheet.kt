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
 * Install Xen Orchestra on a pool that has none, from one machine already in
 * the fleet, and add the pool with it. docs/hypervisors.md, "A pool without
 * Xen Orchestra"; the arithmetic and the words are XoDeploy.kt, and they are
 * iOS's too (DeployXOView.swift).
 *
 * Reached from Add a hypervisor, and only when every machine that answered
 * found no Xen Orchestra at the address (C-2). The same four phases a setup
 * has, in the order they can happen: which machines reach the pool master's
 * SSH server and with which host key (what `xoprobe` says where it found no
 * Xen Orchestra, handed over from Add a hypervisor); the person's word that
 * the key is the pool master's, read off its own console; `deploy` pinned to
 * that key, whose job key is checked before anything is sealed to it; then
 * both passwords sealed and sent, and the steps as the machine runs them,
 * polled only while this is open because the notification carries them when
 * it is not (XoSetupNotice).
 *
 * ONE CARD HERE ASKS A QUESTION: the host key, in the attention ring, with
 * where on the pool master to read its own and a box the person ticks having
 * compared them. Install stays off until they do.
 *
 * THE PASSWORDS ARE IN MEMORY FOR AS LONG AS IT TAKES TO SEAL THEM, and are
 * not in rememberSaveable, for the reason HypervisorSheet gives: saved state
 * is written to a Bundle, and a Bundle is a place.
 */
@Composable
internal fun XoDeploySheet(settings: Settings, startAddress: String, startProbes: List<Fleet.Probe>? = null, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }

    var address by rememberSaveable { mutableStateOf(startAddress) }
    var probing by remember { mutableStateOf(false) }
    // What Add a hypervisor's probe of this address found, which already says
    // what answered SSH; asked again only for another address.
    var probes by remember { mutableStateOf(startProbes) }
    var probeText by remember { mutableStateOf("") }
    var chosen by rememberSaveable { mutableStateOf(startProbes.orEmpty().filter { XoDeploy.canInstall(it) }.singleOrNull()?.hostId) }
    // The person compared the host key with the pool master's own. About one
    // key from one machine: reset with the address, the machine and the probe.
    var matched by rememberSaveable { mutableStateOf(false) }
    var rootPassword by remember { mutableStateOf("") }
    var adminPassword by remember { mutableStateOf("") }
    var beginning by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf("") }
    var unvouched by remember { mutableStateOf<Begun?>(null) }

    var job by rememberSaveable { mutableStateOf<String?>(null) }
    var runningOn by rememberSaveable { mutableStateOf("") }
    var progress by remember { mutableStateOf<Fleet.Setup?>(null) }
    var handedBack by remember { mutableStateOf<XoHandoff.Outcome?>(null) }
    var fleetNote by remember { mutableStateOf("") }
    // Where the Xen Orchestra it installed answers, from the record it
    // handed back once this phone holds it; null until then, never a guess.
    var installedAt by remember { mutableStateOf<String?>(null) }
    var cancelling by remember { mutableStateOf(false) }
    var cancelAccepted by rememberSaveable { mutableStateOf(false) }

    val addressOk = XoSetup.ADDRESS_RE.matches(address.trim())
    val able = probes.orEmpty().filter { XoDeploy.canInstall(it) }
    val pick = able.firstOrNull { it.hostId == chosen }

    fun probe() {
        scope.launch {
            probing = true
            probeText = ""
            probes = null
            chosen = null
            matched = false
            val r = fleet.xoprobe(address.trim())
            if (r.ok && r.probes != null) {
                probes = r.probes
                // One machine that can is not a choice, so it is chosen.
                r.probes.filter { XoDeploy.canInstall(it) }.singleOrNull()?.let { chosen = it.hostId }
            } else {
                probeText = r.text.ifBlank { "The fleet did not try that address." }
            }
            probing = false
        }
    }

    /** Both passwords sealed to the job's key and sent; the fields are cleared the moment they are sealed. */
    suspend fun run(b: Begun) {
        val key = b.setup.key ?: return
        val reply = XoHandoff.newKey(settings, b.setup.job, b.where)
        val sealed = XoDeploy.sealPasswords(key, b.setup.job, b.where, rootPassword, adminPassword, reply.publicKey)
        rootPassword = ""
        adminPassword = ""
        val r = fleet.xosetup("run", job = b.setup.job, sealed = sealed)
        if (!r.ok) {
            XoHandoff.forget(settings, b.setup.job)
            refusal = r.text.ifBlank { "${b.hostId} did not take the passwords." }
            return
        }
        job = b.setup.job
        runningOn = r.hostId ?: b.hostId
        progress = r.xosetup ?: b.setup.copy(state = "running")
    }

    fun begin() {
        val p = pick ?: return
        val pin = XoDeploy.hostKey(p)?.sha256 ?: return
        if (!matched) return
        scope.launch {
            beginning = true
            refusal = ""
            val where = address.trim()
            val r = fleet.xosetup("deploy", address = where, pin = pin, host = p.hostId)
            val setup = r.xosetup
            val hostId = r.hostId ?: p.hostId
            when {
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not begin the install." }
                // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under
                // the install's own context and over the host key the person
                // compared.
                setup.key == null || !XoSetup.verifyKeySig(setup.hostKey, setup.keySig, runCatching { XoDeploy.signingInput(where, setup.job, setup.key, pin) }.getOrDefault(ByteArray(0))) -> {
                    rootPassword = ""
                    adminPassword = ""
                    refusal = "That key did not come from $hostId. Nothing was sent. Something between this phone and that machine is not what it says it is, so check the fleet before trying again."
                    runCatching { fleet.xosetup("cancel", job = setup.job) }
                }
                else -> {
                    val fingerprint = PhoneVault.fingerprint(setup.hostKey!!)
                    val listed = runCatching { fleet.enrolledHosts() }.getOrDefault(emptyList())
                        .firstOrNull { it.hostId == hostId }?.publicJwk?.let { PhoneVault.fingerprint(it) }
                    val approved = PhoneGitHub(settings).signedIn &&
                        runCatching { PhoneVault(settings).list(fleet) }.getOrNull()?.grants?.any { it.fingerprint == fingerprint } == true
                    val begun = Begun(setup, hostId, where)
                    when {
                        listed != null && listed != fingerprint -> {
                            rootPassword = ""
                            adminPassword = ""
                            refusal = "That key did not come from $hostId: the fleet lists a different key for it. Nothing was sent."
                            runCatching { fleet.xosetup("cancel", job = setup.job) }
                        }
                        approved -> run(begun)
                        else -> unvouched = begun
                    }
                }
            }
            beginning = false
        }
    }

    fun cancelJob(setup: Fleet.Setup) {
        scope.launch {
            cancelling = true
            val r = fleet.xosetup("cancel", job = setup.job)
            if (r.ok) {
                cancelAccepted = true
                r.xosetup?.let { progress = it }
            } else {
                refusal = r.text.ifBlank { "Could not cancel." }
            }
            cancelling = false
        }
    }

    fun startAgain() {
        job = null
        progress = null
        handedBack = null
        installedAt = null
        refusal = ""
        matched = false
        cancelAccepted = false
    }

    // THE POLL, ONLY WHILE THIS IS ON SCREEN, as HypervisorSheet's: it ends
    // with the job, or when the fleet says it has no such job.
    LaunchedEffect(job) {
        val id = job ?: return@LaunchedEffect
        var unanswered = 0
        while (isActive) {
            val state = progress?.state
            if (state == "done" || state == "failed" || state == "cancelled") break
            delay(2_000)
            val r = fleet.xosetup("status", job = id)
            val s = r.xosetup
            if (r.ok && s != null) {
                progress = s
                unanswered = 0
                refusal = ""
                val (outcome, inFleet) = XoHandoff.collectAndKeep(settings, fleet, id, s)
                outcome?.let { handedBack = it }
                inFleet?.let { fleetNote = it }
                if (outcome == XoHandoff.Outcome.Kept) installedAt = XoHandoff.installedFrom(settings, address.trim())
                if (s.state == "failed" || s.state == "cancelled") XoHandoff.forget(settings, id)
                continue
            }
            unanswered++
            refusal = r.text.ifBlank { "The fleet did not answer about the install." }
            if (r.code == "unknown_job" || unanswered >= 5) break
        }
    }

    FullScreen(title = "Install Xen Orchestra", onDismiss = { rootPassword = ""; adminPassword = ""; onDismiss() }) {
        val setup = progress
        val waitingOn = unvouched
        when {
            job != null -> {
                SectionHead("Installing")
                if (runningOn.isNotBlank()) Hint("On $runningOn", color = Design.Palette.ink.now)
                if (setup == null) Hint("Asking where it has got to…") else DeployProgress(setup)
                when (val outcome = handedBack) {
                    XoHandoff.Outcome.Kept -> Hint("The token is kept on this phone now, encrypted. No machine in the fleet keeps it on disk.")
                    is XoHandoff.Outcome.Failed -> Hint(outcome.why, color = Design.Palette.bad.now)
                    null -> {}
                }
                installedAt?.let { Hint(XoDeploy.signInLine(it), color = Design.Palette.ink.now) }
                if (fleetNote.isNotBlank()) Hint(fleetNote)
                when {
                    setup != null && (setup.state == "running" || setup.state == "waiting") && !cancelAccepted ->
                        TextButton(enabled = !cancelling, onClick = { cancelJob(setup) }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(if (cancelling) "Cancelling…" else "Cancel")
                        }
                    setup != null && setup.state == "done" ->
                        TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") }
                    setup != null && setup.state != "running" && setup.state != "waiting" ->
                        // A new begin, because the key was for the job that ended.
                        TextButton(onClick = { startAgain() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
                }
            }
            waitingOn != null -> {
                SectionHead("Is that ${waitingOn.hostId}'s key?")
                Hint(
                    "This phone has not approved ${waitingOn.hostId} before. On it, fleetwright-sidecar identity prints its " +
                        "fingerprint; send the passwords only if it is this one.",
                )
                SelectionContainer {
                    Text(PhoneVault.fingerprint(waitingOn.setup.hostKey!!), style = Design.Style.title, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(onClick = { unvouched = null; scope.launch { run(waitingOn) } }, modifier = Modifier.heightIn(min = 48.dp)) { Text("They match") }
                    TextButton(
                        onClick = {
                            unvouched = null
                            rootPassword = ""
                            adminPassword = ""
                            refusal = "Nothing was sent."
                            scope.launch { runCatching { fleet.xosetup("cancel", job = waitingOn.setup.job) } }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("Cancel") }
                }
            }
            else -> {
                SectionHead("The pool master")
                OutlinedTextField(
                    value = address,
                    onValueChange = { typed ->
                        val next = typed.trim()
                        if (next != address) {
                            address = next
                            probes = null
                            probeText = ""
                            chosen = null
                            matched = false
                        }
                    },
                    label = { Text("Address of the pool master") },
                    supportingText = {
                        Text("Its host name or address, as you would SSH to it as root. Xen Orchestra goes on the pool master’s own network, with an address from DHCP there.")
                    },
                    singleLine = true,
                    enabled = !beginning,
                    isError = address.isNotBlank() && !addressOk,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(enabled = !probing && !beginning && addressOk, onClick = { probe() }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (probing) "Asking your machines…" else "Find a machine that can reach it over SSH")
                }
                if (probeText.isNotBlank()) Hint(probeText, color = Design.Palette.bad.now)

                val found = probes
                if (found != null) {
                    SectionHead("Which machine installs it")
                    XoDeploy.nobody(found, address.trim())?.let { Hint(it, color = Design.Palette.attention.now) }
                    found.filter { it.ssh?.reachable == true }.forEach { p ->
                        if (XoDeploy.canInstall(p)) {
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
                                                // Another machine saw the key
                                                // for itself; the tick was for
                                                // the last one's.
                                                matched = false
                                            }
                                        },
                                    ),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = p.hostId == chosen, onClick = null, enabled = !beginning)
                                Spacer(Modifier.width(Design.Space.insideTight))
                                Column(Modifier.weight(1f)) {
                                    Text(p.hostId, style = Design.Style.body, color = Design.Palette.ink.now)
                                    Text(XoDeploy.describe(p), style = Design.Style.label, color = Design.Palette.inkDim.now)
                                }
                            }
                        } else {
                            // Said, and not offered (C-2): it reached the pool
                            // master, and cannot install from there.
                            Text("${p.hostId} · ${XoDeploy.describe(p)}", style = Design.Style.label, color = Design.Palette.attention.now)
                        }
                    }
                }

                val key = pick?.let { XoDeploy.hostKey(it) }
                if (pick != null && key != null) {
                    HostKeyAsk(pick.hostId, address.trim(), key, matched, enabled = !beginning, onMatched = { matched = it })

                    SectionHead("Passwords")
                    OutlinedTextField(
                        value = rootPassword,
                        onValueChange = { rootPassword = it },
                        label = { Text("Root password of the pool master") },
                        singleLine = true,
                        enabled = !beginning,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = adminPassword,
                        onValueChange = { adminPassword = it },
                        label = { Text("New password for Xen Orchestra’s admin") },
                        singleLine = true,
                        enabled = !beginning,
                        isError = adminPassword.isNotEmpty() && !XoDeploy.adminPasswordOk(adminPassword),
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    // Said in words, not only by the field turning red.
                    if (adminPassword.isNotEmpty() && !XoDeploy.adminPasswordOk(adminPassword)) {
                        Hint(XoDeploy.ADMIN_PASSWORD_SHORT, color = Design.Palette.attention.now)
                    }
                    Hint(XoDeploy.passwordsFooter(pick.hostId))
                    OutlinedButton(
                        enabled = !beginning && matched && rootPassword.isNotEmpty() && XoDeploy.adminPasswordOk(adminPassword),
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (beginning) "Checking ${pick.hostId}'s key…" else "Install on ${pick.hostId}") }
                }
            }
        }
        if (refusal.isNotBlank()) Hint(refusal, color = Design.Palette.bad.now)
    }
}

/** A `begin` answer with the address it was sent for, which `run` seals under. */
private class Begun(val setup: Fleet.Setup, val hostId: String, val where: String)

/**
 * THE QUESTION THIS SCREEN ASKS, in the attention ring the design spends on
 * exactly this: the key, where on the pool master to read its own, and the
 * box. The heading carries the word, so the card reads the same with the
 * colour gone.
 */
@Composable
private fun HostKeyAsk(hostId: String, address: String, key: Fleet.SshKey, matched: Boolean, enabled: Boolean, onMatched: (Boolean) -> Unit) {
    SectionHead("Its SSH host key")
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(radius = Design.Radius.cardSmall, ring = Design.Palette.attention.now)
            .padding(Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Text("Check this key on the pool master", style = Design.Style.bodyStrong, color = Design.Palette.attention.now)
        Text("On the pool master’s console, open Local Command Shell and run:", style = Design.Style.bodySmall, color = Design.Palette.ink.now)
        SelectionContainer { Text(XoDeploy.keygenCommand(key.type), style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now) }
        Text(
            "It prints this fingerprint, as $hostId saw it. If it prints another, something else answered at $address.",
            style = Design.Style.bodySmall,
            color = Design.Palette.ink.now,
        )
        SelectionContainer { Text(key.fingerprint, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now) }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = matched, enabled = enabled, role = Role.Checkbox, onValueChange = onMatched),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = matched, onCheckedChange = null, enabled = enabled)
            Spacer(Modifier.width(Design.Space.insideTight))
            Text("It matches the pool master’s", style = Design.Style.body, color = Design.Palette.ink.now)
        }
    }
    Hint("The root password goes only to a server that answers with this key.")
}

/**
 * The bar and the sentence, as SetupProgress draws a setup's: the step words
 * crossfade when they change and the bar moves to its new place (MOTION 2).
 */
@Composable
private fun DeployProgress(setup: Fleet.Setup) {
    val of = setup.of ?: 1
    val step = setup.step ?: 0
    val ended = setup.state == "done" || setup.state == "failed" || setup.state == "cancelled"
    val fill = setup.part?.fill?.takeIf { setup.state == "running" }
    val fraction = when {
        setup.state == "done" -> 1f
        fill != null -> fill / 1000f
        else -> (step.toFloat() / of.coerceAtLeast(1)).coerceIn(0f, 1f)
    }
    val shown by animateFloatAsState(fraction, animationSpec = Design.Motion.change(), label = "install progress")
    val tone = when (setup.state) {
        "done" -> Design.Palette.ok.now
        "failed" -> Design.Palette.bad.now
        "cancelled" -> Design.Palette.idle.now
        else -> Design.Palette.active.now
    }
    val words = when (setup.state) {
        "waiting" -> "Waiting for the passwords"
        "done" -> "Xen Orchestra installed and added"
        "failed" -> "Installing Xen Orchestra stopped"
        "cancelled" -> "Installing Xen Orchestra cancelled"
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
            label = "install step",
        ) { w ->
            Text(w, style = Design.Style.bodyStrong, color = if (ended) tone else Design.Palette.ink.now)
        }
        if (!ended && setup.state == "running") Text(XoDeploy.stepLine(step, of, fill), style = Design.Style.label, color = Design.Palette.inkDim.now)
        setup.text?.let { Quoted(it) }
    }
}
