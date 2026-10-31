package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
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
 * Add Fleetwright's reconnect watchdog to a Xen Orchestra that predates it,
 * through the pool master that runs its VM. docs/hypervisors.md, "When Xen
 * Orchestra loses a pool"; the arithmetic and the words are XoWatchdog.kt.
 *
 * Reached from the pool's page, an admin's row. AN INSTALL'S FIRST HALF
 * (XoDeploySheet), and the same pieces of it: which machines reach the pool
 * master's SSH server and with which host key (`xoprobe`, whose `ssh` says
 * so wherever no Xen Orchestra answers, as a pool master's address does not);
 * the person's word that the key is the pool master's, read off its own
 * console (HostKeyAsk); `watchdog` pinned to that key, whose job key is
 * checked under this job's own context before anything is sealed to it; then
 * the root password sealed and sent with the address this phone keeps the
 * pool under, which is how the machine finds Xen Orchestra's VM; and the
 * steps as the machine runs them, polled only while this is open because the
 * notification carries them when it is not (XoSetupNotice).
 *
 * WHAT IT DOES IS SAID BEFORE THE PASSWORD IS ASKED FOR (XoWatchdog.
 * WHAT_HAPPENS): Xen Orchestra goes away for a minute or two, and the person
 * chooses when. Its end is the machine's own sentence, which says whether the
 * VM was started again; nothing here claims it was (C-5).
 *
 * THE POOL MASTER'S ADDRESS starts as the one an install kept, when this
 * phone has a record that names one, and empty otherwise: a guess at which
 * host is the master would send a root password to ask.
 *
 * THE PASSWORD IS IN MEMORY FOR AS LONG AS IT TAKES TO SEAL IT, and not in
 * rememberSaveable, for the reason HypervisorSheet gives.
 */
@Composable
internal fun XoWatchdogSheet(settings: Settings, xoAddress: String, startPoolMaster: String?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }

    var address by rememberSaveable { mutableStateOf(startPoolMaster.orEmpty()) }
    var probing by remember { mutableStateOf(false) }
    var probes by remember { mutableStateOf<List<Fleet.Probe>?>(null) }
    var probeText by remember { mutableStateOf("") }
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    // The person compared the host key with the pool master's own. About one
    // key from one machine: reset with the address, the machine and the probe.
    var matched by rememberSaveable { mutableStateOf(false) }
    var rootPassword by remember { mutableStateOf("") }
    var beginning by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf("") }
    var unvouched by remember { mutableStateOf<Begun?>(null) }

    var job by rememberSaveable { mutableStateOf<String?>(null) }
    var runningOn by rememberSaveable { mutableStateOf("") }
    var progress by remember { mutableStateOf<Fleet.Setup?>(null) }
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

    /** The root password sealed to the job's key and sent; the field is cleared the moment it is sealed. */
    suspend fun run(b: Begun) {
        val key = b.setup.key ?: return
        val sealed = XoWatchdog.sealRoot(key, b.setup.job, b.where, rootPassword, xoAddress)
        rootPassword = ""
        val r = fleet.xosetup("run", job = b.setup.job, sealed = sealed)
        if (!r.ok) {
            refusal = r.text.ifBlank { "${b.hostId} did not take the root password." }
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
            val r = fleet.xosetup("watchdog", address = where, pin = pin, host = p.hostId)
            val setup = r.xosetup
            val hostId = r.hostId ?: p.hostId
            when {
                // A machine from before this job answers `host_outdated`,
                // in words the coordinator wrote; they are said as given.
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not begin adding the watchdog." }
                // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under
                // this job's own context and over the host key the person
                // compared.
                setup.key == null || !XoSetup.verifyKeySig(setup.hostKey, setup.keySig, runCatching { XoWatchdog.signingInput(where, setup.job, setup.key, pin) }.getOrDefault(ByteArray(0))) -> {
                    rootPassword = ""
                    refusal = "That key did not come from $hostId. Nothing was sent. Something between this phone and that machine is not what it says it is, so check the fleet before trying again."
                    runCatching { fleet.xosetup("cancel", job = setup.job) }
                }
                else -> {
                    val fingerprint = PhoneVault.fingerprint(setup.hostKey!!)
                    val listed = runCatching { fleet.enrolledHosts() }.getOrDefault(emptyList())
                        .firstOrNull { it.hostId == hostId }?.publicJwk?.let { PhoneVault.fingerprint(it) }
                    // APPROVED only by a whole-vault grant for this machine,
                    // by this whole key, as an install's (PhoneVault.approval).
                    // NONE when the vault cannot be asked, which asks the
                    // person and never passes.
                    val approval = if (PhoneGitHub(settings).signedIn) {
                        runCatching { PhoneVault(settings).list(fleet) }.getOrNull()?.grants
                            ?.let { PhoneVault.approval(it, hostId, setup.hostKey!!) } ?: PhoneVault.Approval.NONE
                    } else {
                        PhoneVault.Approval.NONE
                    }
                    val begun = Begun(setup, hostId, where)
                    when {
                        listed != null && listed != fingerprint -> {
                            rootPassword = ""
                            refusal = "That key did not come from $hostId: the fleet lists a different key for it. Nothing was sent."
                            runCatching { fleet.xosetup("cancel", job = setup.job) }
                        }
                        // Approved under another key: a machine that was
                        // re-keyed would have been re-approved. Hard stop, in
                        // iOS's words.
                        approval == PhoneVault.Approval.ANOTHER_KEY -> {
                            rootPassword = ""
                            refusal = "The key $hostId answered with did not come from that machine: it is not the key this phone approved for it. The root password was not sent."
                            runCatching { fleet.xosetup("cancel", job = setup.job) }
                        }
                        approval == PhoneVault.Approval.APPROVED -> run(begun)
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
        refusal = ""
        matched = false
        cancelAccepted = false
    }

    // THE POLL, ONLY WHILE THIS IS ON SCREEN, as an install's: it ends with
    // the job, or when the fleet says it has no such job.
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
                continue
            }
            unanswered++
            refusal = r.text.ifBlank { "The fleet did not answer about adding the watchdog." }
            if (r.code == "unknown_job" || unanswered >= 5) break
        }
    }

    FullScreen(title = Manage.Words.addWatchdog, onDismiss = { rootPassword = ""; onDismiss() }) {
        val setup = progress
        val waitingOn = unvouched
        when {
            job != null -> {
                SectionHead("Adding it")
                if (runningOn.isNotBlank()) Hint("On $runningOn, for Xen Orchestra at $xoAddress", color = Design.Palette.ink.now)
                if (setup == null) {
                    Hint("Asking where it has got to…")
                } else {
                    DeployProgress(setup, stateWords = ::watchdogStateWords, stepWords = XoWatchdog::stepWords)
                }
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
                        "fingerprint; send the root password only if it is this one.",
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
                            refusal = "Nothing was sent."
                            scope.launch { runCatching { fleet.xosetup("cancel", job = waitingOn.setup.job) } }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("Cancel") }
                }
            }
            else -> {
                Hint("For Xen Orchestra at $xoAddress. It reconnects a pool Xen Orchestra loses, by itself, without waiting for Reconnect its servers.")
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
                        Text(
                            if (startPoolMaster != null) "The pool master Xen Orchestra was installed from. Change it if the pool’s master has changed since."
                            else "The host that runs Xen Orchestra’s VM, or its pool’s master, as you would SSH to it as root.",
                        )
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
                    SectionHead("Which machine does it")
                    XoDeploy.nobody(found, address.trim(), doing = "add the watchdog")?.let { Hint(it, color = Design.Palette.attention.now) }
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
                                    Text(XoWatchdog.describe(p), style = Design.Style.label, color = Design.Palette.inkDim.now)
                                }
                            }
                        } else {
                            // Said, and not offered (C-2): it reached the pool
                            // master, and cannot sign in to it from there.
                            Text("${p.hostId} · ${XoWatchdog.describe(p)}", style = Design.Style.label, color = Design.Palette.attention.now)
                        }
                    }
                }

                val key = pick?.let { XoDeploy.hostKey(it) }
                if (pick != null && key != null) {
                    HostKeyAsk(pick.hostId, address.trim(), key, matched, enabled = !beginning, onMatched = { matched = it })

                    SectionHead("What happens")
                    Text(XoWatchdog.WHAT_HAPPENS, style = Design.Style.body, color = Design.Palette.ink.now)

                    SectionHead("Root password")
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
                    Hint(XoWatchdog.passwordFooter(pick.hostId))
                    OutlinedButton(
                        enabled = !beginning && matched && rootPassword.isNotEmpty(),
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (beginning) "Checking ${pick.hostId}'s key…" else "Add the watchdog from ${pick.hostId}") }
                }
            }
        }
        if (refusal.isNotBlank()) Hint(refusal, color = Design.Palette.bad.now)
    }
}

/** This job's words for a state that is not one of its steps, or null for one that is. */
private fun watchdogStateWords(state: String): String? = when (state) {
    "waiting" -> "Waiting for the root password"
    "done", "failed", "cancelled" -> XoWatchdog.title(state)
    else -> null
}
