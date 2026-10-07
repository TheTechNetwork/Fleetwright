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
import androidx.compose.ui.platform.LocalContext
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
 * again on every way out of the sign-in step. Nothing here logs it or hands
 * it to the outbox: every send is given an id, which is what keeps a send the
 * fleet did not answer off this phone's disk (Fleet.xosetup). It is the one
 * input NOT in rememberSaveable, for the same reason: saved state is written
 * to a Bundle, and a Bundle is a place.
 *
 * UNLESS THE PERSON ASKS TO KEEP IT. "Keep on this phone" seals the sign-in
 * and their word for the certificate under a key that opens only after a
 * fingerprint or face check (XoSaved), at the moment the sign-in is sealed
 * for the machine, and writes that ciphertext only once the machine has
 * signed in with it, so a mistyped password is never the one kept. And the
 * machine that got through is remembered by address: the next change on the
 * same pool starts there, and asks every machine only when it does not get
 * through.
 *
 * WHAT SURVIVES A ROTATION. The job, the machine running it, the address,
 * the machine chosen and the acknowledgement are saveable, so turning the
 * phone mid-setup comes back to the same progress rather than an empty form.
 * The probes are not: they are an answer from the fleet, and asking again is
 * one tap.
 *
 * CHANGING WHAT THE FLEET MAY USE is this screen again, for a pool this
 * phone already keeps a token for ([policyFor]): the same probe, machine,
 * certificate, sign-in and key check, because the job is begun exactly as a
 * setup is, then a form where the steps would be. It differs where XoPolicy
 * says. `begin` must answer that the machine can (`can` holds "policy"),
 * checked before anything is sealed, because an older machine would run a
 * policy sign-in as a setup. The sign-in carries the purpose inside the
 * seal, and a key for the pool to come back to that lives in this screen's
 * memory alone: not saveable, not the Keystore, gone when the screen goes. So
 * a screen rebuilt while the machine waits says it can no longer open what
 * the machine sent, and offers Cancel, rather than pretending otherwise.
 *
 * @param resumeJob a job a notification was tapped for: straight to its
 *   progress, from `status`, with nothing to type.
 * @param policyFor a pool's address, to change what the fleet may use on it
 *   instead of adding it. The address is fixed: it is the pool the token is
 *   kept for.
 */
@Composable
internal fun HypervisorSheet(settings: Settings, resumeJob: String? = null, policyFor: String? = null, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }
    val policy = policyFor != null

    var address by rememberSaveable { mutableStateOf(policyFor ?: "") }
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

    // A POLICY JOB. The job's key as `begin` gave it and this phone checked
    // it, which is what the choice is sealed to (a `status` answer carries no
    // key, and one that did would be the coordinator's word for it). The key
    // the pool comes back to, IN MEMORY ONLY. What the pool has, once opened,
    // and what the person has chosen from it.
    var jobKey by remember { mutableStateOf<String?>(null) }
    // The machine said it can build the edge router (`can` holds "edge"), so
    // the form offers it; an older one never is offered (C-2).
    var canEdge by remember { mutableStateOf(false) }
    // The machine takes any of the pool's networks as the way out (`can`
    // holds "egress-any"); an older one only the fleet's.
    var anyWayOut by remember { mutableStateOf(false) }
    // The machine puts the router's disk where the person says (`can` holds
    // "edge-disk"); an older one picks it unasked.
    var edgeDisk by remember { mutableStateOf(false) }
    // The machine builds the machine image sessions' machines are cloned
    // from (`can` holds "image"); an older one cannot.
    var canImage by remember { mutableStateOf(false) }
    // It builds any of its catalogue's images, chosen together; an older one Debian alone.
    var canImages by remember { mutableStateOf(false) }
    // It makes the pool a machine of its own (`can` holds "holder"); an older one cannot.
    var canHolder by remember { mutableStateOf(false) }
    // What the fleet said when the token was kept there too, or what stood in
    // the way (XoHandoff.keepInFleet).
    var fleetNote by remember { mutableStateOf("") }
    var keepingInFleet by remember { mutableStateOf(false) }
    var policyKey by remember { mutableStateOf<Seal.OneUseKey?>(null) }
    var inventory by remember { mutableStateOf<XoPolicy.Inventory?>(null) }
    var choice by remember { mutableStateOf<XoPolicy.Choice?>(null) }
    // The machine sent the pool and it did not open here: the key went with
    // a rebuilt screen, or the sealed copy is not what the machine sealed.
    var unopened by remember { mutableStateOf(false) }
    var applying by remember { mutableStateOf(false) }
    // The machine took the choice: the form goes, and is not offered again.
    var applied by rememberSaveable { mutableStateOf(false) }
    // What the machine said when it did not take the choice. Kept apart from
    // `refusal`, which the poll clears on every answer, because the person
    // needs to read it while they change what it was about.
    var choiceRefusal by remember { mutableStateOf("") }

    // WHAT THIS PHONE REMEMBERS (XoSaved). What was kept, once a fingerprint
    // or face opened it; the switch, on when what is on screen came from it;
    // the machine chosen from memory without asking the others; and the
    // sealed copy waiting for the machine to sign in with it.
    val context = LocalContext.current
    val canKeep = remember { XoSaved.available(context) }
    var remembered by remember { mutableStateOf<XoSaved.Entry?>(null) }
    var keep by remember { mutableStateOf(false) }
    var keepLoaded by remember { mutableStateOf(false) }
    var viaMemory by rememberSaveable { mutableStateOf(false) }
    var pendingSave by remember { mutableStateOf<String?>(null) }
    var keepNote by remember { mutableStateOf("") }
    var openedOnce by rememberSaveable { mutableStateOf(false) }

    val addressOk = XoSetup.ADDRESS_RE.matches(address.trim())
    // WHO CAN RUN IT: the machines that reached it over HTTPS and saw a
    // certificate, then the ones answered in plain HTTP. The pinned ones
    // first, because they are the ones with nothing to accept.
    val pinned = probes.orEmpty().filter { XoSetup.pinned(it) }
    val reachable = pinned + probes.orEmpty().filter { XoSetup.plain(it) }
    val pick = reachable.firstOrNull { it.hostId == chosen }

    /** The person's word for what this machine found, kept and opened: the same fingerprint, or plain HTTP again. */
    fun rememberedAccepts(p: Fleet.Probe): Boolean = remembered?.accepts(p) == true

    /** Open what was kept for this address, which puts the fingerprint or face prompt up. */
    suspend fun unlockRemembered() {
        val where = address.trim()
        if (!XoSaved.has(settings, where)) return
        val entry = XoSaved.unlock(context, settings, where) ?: return
        remembered = entry
        if (entry.hasLogin) {
            email = entry.email.orEmpty()
            password = entry.password.orEmpty()
        }
        keep = true
        keepLoaded = true
    }

    fun probe() {
        scope.launch {
            probing = true
            viaMemory = false
            probeText = ""
            probes = null
            chosen = null
            acknowledged = false
            plainAccepted = false
            val r = fleet.xoprobe(address.trim())
            if (r.ok && r.probes != null) {
                probes = r.probes
                // One machine that can is chosen for them; two is a decision,
                // unless one of them got through last time, which is chosen
                // and the others stay a tap away. A lone plain-HTTP machine is
                // chosen too: choosing it shows the card that asks, and
                // nothing is sent until it is answered.
                val able = r.probes.filter { XoSetup.pinned(it) || XoSetup.plain(it) }
                val via = XoSaved.machine(settings, address.trim())
                chosen = able.singleOrNull()?.hostId ?: able.firstOrNull { it.hostId == via }?.hostId
                // An address this phone kept a sign-in for: opened now, once
                // there is something to send it to.
                if (remembered == null) unlockRemembered()
            } else {
                probeText = r.text.ifBlank { "The fleet did not answer the probe." }
            }
            probing = false
        }
    }

    /**
     * The remembered machine as a probe nobody ran: plain HTTP if the person
     * accepted that, the fingerprint they accepted, or the one pinned at
     * setup when it checked out then. Null when none is known.
     */
    fun directPath(via: String): Fleet.Probe? {
        val kept = remembered
        if (kept != null && kept.acceptedPlain) return Fleet.Probe(via, reachable = true, xo = null, tls = false, cert = null, version = null)
        kept?.acceptedPin?.let { return Fleet.Probe(via, reachable = true, xo = null, tls = true, cert = it, version = null) }
        val pinned = XoHandoff.pinnedCertificate(settings, address.trim())
        if (pinned != null && pinned.second) {
            val checked = Fleet.Certificate(trusted = true, problems = emptyList(), subject = null, issuer = null, notBefore = null, notAfter = null, names = emptyList())
            return Fleet.Probe(via, reachable = true, xo = null, tls = true, cert = pinned.first, version = null, certificate = checked)
        }
        return null
    }

    /**
     * FIRST, WHERE IT WORKED LAST TIME. What was kept is opened, and when the
     * machine that got through last time is known and the certificate needs
     * nobody's word or has the person's kept word, that machine is chosen and
     * nothing else is asked: `begin` goes to it, and it holds the sign-in to
     * the pinned certificate as it always does, so a server that changed
     * fails at `connect` with nothing sent to it. Anything less asks every
     * machine, as before.
     */
    suspend fun openRemembered() {
        unlockRemembered()
        val path = XoSaved.machine(settings, address.trim())?.let { directPath(it) }
        if (path != null) {
            probes = listOf(path)
            chosen = path.hostId
            viaMemory = true
            return
        }
        probe()
    }

    /**
     * The copy to keep, sealed behind a fingerprint or face now, while the
     * password is still here, or null: the box is off, nothing changed since
     * it was kept, or the person cancelled the prompt (said, and the sign-in
     * goes ahead).
     */
    suspend fun sealToKeep(p: Fleet.Probe, who: String): String? {
        if (!keep || !canKeep) return null
        val plain = XoSetup.plain(p)
        val trusted = !plain && p.certificate?.trusted == true
        val entry = XoSaved.Entry(who, password, if (!plain && !trusted) p.cert else null, plain)
        if (keepLoaded && entry == remembered) return null
        return XoSaved.seal(context, entry, address.trim()).also {
            if (it == null) keepNote = "Nothing was kept, because the fingerprint or face check did not finish. The sign-in went ahead."
        }
    }

    /**
     * WHERE IT GOT TO decides what is kept. Past `sign-in`: that machine is
     * remembered for this address, and the sealed copy is written, once.
     * Stopped at `connect` on a machine chosen from memory: said, and Start
     * again asks every machine. Stopped at `sign-in` with a kept password:
     * forgotten rather than offered again. The same rule as iOS's notePath.
     */
    fun notePath(s: Fleet.Setup) {
        val where = address.trim()
        val phase = s.phase.orEmpty()
        val past = s.state == "done" || s.state == "choosing" ||
            (s.state == "running" && phase.isNotEmpty() && phase != "connect" && phase != "sign-in")
        if (past) {
            if (runningOn.isNotBlank()) XoSaved.rememberMachine(settings, where, runningOn)
            pendingSave?.let {
                pendingSave = null
                XoSaved.keep(settings, where, it)
                keepLoaded = true
                keepNote = "The sign-in is kept on this phone behind your fingerprint or face now."
            }
            return
        }
        if (s.state != "failed") return
        pendingSave = null
        if (phase == "connect" && viaMemory) {
            keepNote = "$runningOn got through last time and did not this time. Start again asks all your machines and shows the certificate in full."
        } else if (phase == "sign-in" && keepLoaded) {
            XoSaved.forget(settings, where)
            remembered = null
            keepLoaded = false
            keep = false
            keepNote = "The kept sign-in did not work, so this phone no longer keeps it."
        }
    }

    fun olderThanPolicy(hostId: String) =
        "$hostId is older than changing a policy, so nothing was sent. Update it, or choose another machine that reaches $address."

    /**
     * `run` for a policy job: the same seal, under the same binding, with the
     * purpose inside it and a reply key made here and kept only in memory.
     * Never XoHandoff's key, which is written down so a token can be
     * collected with the app closed: what comes back here is for this screen
     * to show now, and nothing comes back afterwards to collect.
     */
    suspend fun runPolicy(p: Pending) {
        val key = p.setup.key ?: return
        // ASKED AGAIN, though begin already refused: this is the last line
        // before a sign-in is sealed.
        if (XoPolicy.PURPOSE !in p.setup.can) {
            password = ""
            refusal = olderThanPolicy(p.hostId)
            return
        }
        val reply = Seal.newKey()
        pendingSave = pick?.let { sealToKeep(it, p.email) }
        val sealed = XoPolicy.sealSignIn(key, p.setup.job, p.where, p.email, password, reply.publicKey)
        password = ""
        val r = fleet.xosetup("run", job = p.setup.job, sealed = sealed)
        if (!r.ok) {
            pendingSave = null
            refusal = r.text.ifBlank { "${p.hostId} did not take the sign-in." }
            return
        }
        jobKey = key
        canEdge = "edge" in p.setup.can
        anyWayOut = "egress-any" in p.setup.can
        edgeDisk = "edge-disk" in p.setup.can
        canImage = "image" in p.setup.can
        canImages = "images" in p.setup.can
        canHolder = "holder" in p.setup.can
        policyKey = reply
        job = p.setup.job
        runningOn = r.hostId ?: p.hostId
        progress = r.xosetup ?: p.setup.copy(state = "running")
    }

    /**
     * `run`: seal the sign-in to the job's key, drop the password, send. The
     * address and the email are the ones `begin` was sent with, not whatever
     * the fields hold now: the job's key was signed over that address, and a
     * sign-in sealed under a different one would be refused as a replay.
     */
    suspend fun run(p: Pending) {
        if (policy) {
            runPolicy(p)
            return
        }
        val key = p.setup.key ?: return
        val reply = XoHandoff.newKey(settings, p.setup.job, p.where)
        pendingSave = pick?.let { sealToKeep(it, p.email) }
        val sealed = XoSetup.sealSignIn(key, p.setup.job, p.where, p.email, password, reply.publicKey)
        password = ""
        val r = fleet.xosetup("run", job = p.setup.job, sealed = sealed)
        if (!r.ok) {
            pendingSave = null
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
        val kept = rememberedAccepts(p)
        if (plain && !plainAccepted && !kept) return
        val trust = if (plain) null else XoSetup.trustFor(p.certificate, acknowledged || kept)
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
                // THE REMEMBERED MACHINE IS A FIRST TRY, NOT THE ONLY ONE:
                // switched off or gone, and every machine is asked instead,
                // with the reason kept on screen.
                (!r.ok || setup == null) && viaMemory -> {
                    val why = r.text.ifBlank { "${p.hostId} did not start the setup." }
                    probe()
                    refusal = "$why Your other machines were asked instead."
                }
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not start the setup." }
                // ONLY TO A MACHINE THAT SAYS IT CAN, asked before the key is
                // so much as checked: a machine older than the policy job
                // would read the sign-in as a setup and add the pool again.
                // Its job is let go rather than left holding a slot.
                policy && XoPolicy.PURPOSE !in setup.can -> {
                    password = ""
                    refusal = olderThanPolicy(hostId)
                    runCatching { fleet.xosetup("cancel", job = setup.job) }
                }
                // AND A SETUP ONLY TO A MACHINE NEW ENOUGH TO HAND THE TOKEN
                // BACK. An older one keeps the pool's token in a file of its
                // own, which is what this app says does not happen, and resets
                // what the fleet may use on the way. Seen: the release on disk,
                // a sidecar still running the one before. `can` came in the
                // release after the hand-off, so an empty one is older than both.
                !policy && setup.can.isEmpty() -> {
                    password = ""
                    refusal = "$hostId is running a Fleetwright older than this app, and an older machine keeps the pool's token itself instead of handing it to this phone. Nothing was sent. Update that machine (Update, then Restart to apply), then try again."
                    runCatching { fleet.xosetup("cancel", job = setup.job) }
                }
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
        // A remembered machine that did not get through is not tried twice.
        val askAll = viaMemory && progress?.state == "failed" && progress?.phase == "connect"
        job = null
        progress = null
        handedBack = null
        refusal = ""
        // A kept password comes back for the next try; a typed one does not.
        password = remembered?.password.orEmpty()
        pendingSave = null
        keepNote = ""
        if (askAll) probe()
        cancelAccepted = false
        cancelText = ""
        pollStopped = false
        pollGone = false
        jobKey = null
        policyKey = null
        inventory = null
        choice = null
        unopened = false
        applied = false
        choiceRefusal = ""
    }

    fun cancelJob(setup: Fleet.Setup) {
        scope.launch {
            cancelling = true
            val r = fleet.xosetup("cancel", job = setup.job)
            if (r.ok) {
                // OFFERED ONCE. The fleet has the cancel; what the host said
                // about it stands in for the button until the state changes.
                cancelAccepted = true
                cancelText = r.text
                r.xosetup?.let { progress = it }
            } else {
                refusal = r.text.ifBlank { "Could not cancel." }
            }
            cancelling = false
        }
    }

    /**
     * `policy`: the choice, sealed to the job's key under its own binding.
     * Off unless XoPolicy finds nothing the machine would refuse, so a
     * refusal here is the machine knowing something this phone did not (the
     * ten minutes ran out, say), and its words are shown on the form, which
     * stays, because the machine is still waiting.
     */
    fun applyChoice(setup: Fleet.Setup) {
        val key = jobKey ?: return
        val inv = inventory ?: return
        val c = choice ?: return
        if (XoPolicy.problem(inv, c) != null) return
        scope.launch {
            applying = true
            choiceRefusal = ""
            val sealed = XoPolicy.sealChoice(key, setup.job, address.trim(), inv, c)
            val r = fleet.xosetup("policy", job = setup.job, sealed = sealed)
            if (r.ok) {
                // Nothing left to open or choose: the key and the pool go.
                applied = true
                policyKey = null
                inventory = null
                choice = null
            } else {
                choiceRefusal = r.text.ifBlank { "The fleet did not answer, so the choice was not applied. Try again." }
            }
            r.xosetup?.let { progress = it }
            applying = false
        }
    }

    // A POOL THIS PHONE HOLDS opens on the machine that got through last
    // time, once per screen: a rotation does not put the prompt up again.
    LaunchedEffect(Unit) {
        if (policy && job == null && !openedOnce) {
            openedOnce = true
            openRemembered()
        }
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
                r.hostId?.let { runningOn = it }
                notePath(r.xosetup)
                val (outcome, inFleet) = XoHandoff.collectAndKeep(settings, fleet, id, r.xosetup)
                outcome?.let { handedBack = it }
                inFleet?.let { fleetNote = it }
                if (r.xosetup.state == "failed" || r.xosetup.state == "cancelled") XoHandoff.forget(settings, id)
                // CHOOSING IS NOT AN END: the loop goes on asking, so this
                // screen hears when the machine lets go. The pool is opened
                // once, the first time it arrives, and never after the
                // choice has gone, whatever a late answer still says.
                val pool = r.xosetup.inventory
                if (policy && r.xosetup.state == "choosing" && pool != null && inventory == null && !applied && !unopened) {
                    val opened = policyKey?.let { XoPolicy.openInventory(pool, id, address.trim(), it) }
                    if (opened != null) {
                        inventory = opened
                        choice = XoPolicy.defaults(opened, anyWayOut).copy(
                            edgeDiskChoice = edgeDisk,
                            imageChoice = canImage,
                            imagesChoice = canImages && opened.imageKinds != null,
                            holderChoice = canHolder && opened.holders != null,
                        )
                    } else {
                        unopened = true
                    }
                }
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

    FullScreen(title = if (policy) "What the fleet may use" else "Add a hypervisor", onDismiss = { password = ""; onDismiss() }) {
        val setup = progress
        val waitingOn = unvouched
        when {
            job != null -> {
                SectionHead(if (policy) address else "Setting up")
                if (runningOn.isNotBlank()) Hint("On $runningOn", color = Design.Palette.ink.now)
                if (setup == null) {
                    if (!pollStopped) Hint("Asking where it has got to…")
                } else {
                    SetupProgress(setup, policy)
                }
                when (val outcome = handedBack) {
                    XoHandoff.Outcome.Kept -> Hint("The token is kept on this phone now, encrypted. No machine in the fleet keeps it on disk.")
                    is XoHandoff.Outcome.Failed -> Hint(outcome.why, color = Design.Palette.bad.now)
                    null -> {}
                }
                if (keepNote.isNotBlank()) Hint(keepNote)
                if (fleetNote.isNotBlank()) Hint(fleetNote)
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
                    // THE FORM, while the machine waits on it, and only then.
                    policy && setup != null && setup.state == "choosing" -> {
                        val inv = inventory
                        val c = choice
                        val machine = runningOn.ifBlank { "The machine" }
                        when {
                            // The machine has the cancel and has not yet said
                            // it let go; nothing is applied before a choice.
                            cancelAccepted -> Hint("Cancelling. Nothing has been changed.", color = Design.Palette.ink.now)
                            applied -> Hint("Sent. $machine is applying it.", color = Design.Palette.ink.now)
                            inv != null && c != null -> {
                                PolicyForm(inv, c, enabled = !applying && !cancelling, canEdge = canEdge, machine = machine, onChange = { choice = it }, canImage = canImage)
                                val problem = XoPolicy.problem(inv, c)
                                Hint("$machine waits ten minutes for your choice, then lets go without changing anything.")
                                // WHY APPLY IS OFF, in the machine's words, so
                                // a switched-off button is never a mystery.
                                if (problem != null) Hint(problem, color = Design.Palette.ink.now)
                                if (choiceRefusal.isNotBlank()) Hint(choiceRefusal, color = Design.Palette.bad.now)
                                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                                    OutlinedButton(
                                        enabled = !applying && !cancelling && problem == null,
                                        onClick = { applyChoice(setup) },
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text(if (applying) "Applying…" else "Apply") }
                                    TextButton(
                                        enabled = !applying && !cancelling,
                                        onClick = { cancelJob(setup) },
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                                }
                            }
                            unopened -> {
                                Hint(
                                    "What the pool has did not open with this screen's key, so it cannot be shown. That key is kept " +
                                        "in memory only, and goes when the screen does: if the phone turned or the app was closed " +
                                        "since, that is why. Cancel, and start again.",
                                    color = Design.Palette.attention.now,
                                )
                                TextButton(
                                    enabled = !cancelling,
                                    onClick = { cancelJob(setup) },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                            }
                            else -> Hint("Opening what the pool has…")
                        }
                    }
                    // AFTER THE CHOICE, nothing to stop: apply is the last
                    // step, and a Cancel there would be a button that lied.
                    policy && applied && setup != null && setup.state == "running" -> {}
                    setup != null && (setup.state == "running" || setup.state == "waiting") && !cancelAccepted -> {
                        TextButton(
                            enabled = !cancelling,
                            onClick = { cancelJob(setup) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                        Hint(
                            if (policy) "It stops between steps, and nothing is changed until you have chosen."
                            else "It stops between steps. What was made so far is tagged fleetwright, and running the setup again picks up from what exists.",
                        )
                    }
                    setup != null && (setup.state == "running" || setup.state == "waiting") -> {
                        Hint(cancelText.ifBlank { "Cancelling after this step." }, color = Design.Palette.ink.now)
                    }
                    policy && setup != null && setup.state == "done" -> {
                        TextButton(onClick = { password = ""; onDismiss() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") }
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
                // MACHINES FROM THIS POOL: its token kept in the fleet, so the
                // boxes this person approved can make them. Kept on every
                // setup from now on; this is for a pool set up before that,
                // and for keeping it again.
                if (policy) {
                    SectionHead("Machines from this pool")
                    OutlinedButton(
                        enabled = !keepingInFleet,
                        onClick = {
                            scope.launch {
                                keepingInFleet = true
                                fleetNote = XoHandoff.keepInFleet(settings, fleet, address.trim())
                                keepingInFleet = false
                            }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (keepingInFleet) "Keeping…" else "Keep its token in the fleet") }
                    if (fleetNote.isNotBlank()) Hint(fleetNote, color = Design.Palette.ink.now)
                    Hint(
                        "The boxes you approved can then make machines on it for your sessions. They hold its token in memory only, " +
                            "and stop being given it when you remove them from your vault.",
                    )
                }
                SectionHead("Where Xen Orchestra answers")
                if (policy) {
                    // FIXED: the pool this phone keeps a token for, as the
                    // setup that made the token was begun.
                    Text(address, style = Design.Style.body, fontFamily = FontFamily.Monospace, color = Design.Palette.ink.now)
                    Hint("Changing what the fleet may use starts the way adding the pool did: a machine that reaches it, and an admin sign-in.")
                } else OutlinedTextField(
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
                    SectionHead(if (policy) "Which machine reads the pool" else "Which machine runs the setup")
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
                            Hint(
                                if (policy) "Only a machine that reaches it can. It signs in, reads the pool, applies what you choose, and keeps nothing afterwards."
                                else "Only a machine that reaches it can. The machine keeps the pool's token afterwards, so pick one that stays.",
                            )
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
                                        // NOT ASKED THIS TIME, so nothing it found is
                                        // claimed: only why it is tried first.
                                        Text(
                                            if (viaMemory && p.hostId == chosen) "Got through last time, so it is tried first" else XoSetup.describe(p),
                                            style = Design.Style.label,
                                            color = Design.Palette.inkDim.now,
                                        )
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
                    val kept = rememberedAccepts(pick)
                    when {
                        plain -> PlainAsk(pick, address, plainAccepted, enabled = !beginning, onAccepted = { plainAccepted = it }, kept = kept)
                        viaMemory && trusted && cert != null -> {
                            // FROM MEMORY, said as when it was checked: nothing
                            // was asked this time, and the machine checks again.
                            Hint("Its certificate checked out when this pool was set up, and ${pick.hostId} checks it again before signing in.", color = Design.Palette.ink.now)
                            PinLines(cert, pick.hostId, address, fromMemory = true)
                        }
                        certificate != null && trusted && cert != null -> {
                            // CALM. It checks out, so nothing is asked; the pin
                            // still shows, because it is what the machine holds
                            // the sign-in to.
                            Hint(XoSetup.trustedLine(certificate), color = Design.Palette.ink.now)
                            PinLines(cert, pick.hostId, address)
                        }
                        // A path from memory has no details to show, and is
                        // taken only for a certificate the person accepted.
                        viaMemory && kept && cert != null && certificate == null -> {
                            PinLines(cert, pick.hostId, address, fromMemory = true)
                            Hint("You accepted this certificate before, and this phone kept that behind your fingerprint or face.")
                        }
                        else -> CertificateAsk(pick, address, acknowledged, enabled = !beginning, onAcknowledged = { acknowledged = it }, kept = kept)
                    }
                    // WHAT THE PERSON HAS SAID YES TO, for the card that was
                    // shown, now or kept: nothing needed for a certificate
                    // that checks out.
                    val consented = if (plain) plainAccepted || kept else (trusted || acknowledged || kept)

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
                    // OFFERED ONLY WHERE IT CAN BE KEPT: a phone with no strong
                    // fingerprint or face enrolled could not make the key (C-2).
                    if (canKeep) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .toggleable(
                                    value = keep,
                                    enabled = !beginning,
                                    role = Role.Checkbox,
                                    onValueChange = { on ->
                                        keep = on
                                        // Unticked over what was kept: forgotten
                                        // now, so the box says what the phone holds.
                                        if (!on && keepLoaded) {
                                            XoSaved.forget(settings, address.trim())
                                            remembered = null
                                            keepLoaded = false
                                        }
                                    },
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = keep, onCheckedChange = null, enabled = !beginning)
                            Spacer(Modifier.width(Design.Space.insideTight))
                            Text("Keep on this phone, behind your fingerprint or face", style = Design.Style.body, color = Design.Palette.ink.now)
                        }
                    }
                    // WHO KEEPS IT, for the box as it stands. The fleet never does.
                    val word = if (trusted) "" else ", and your word for the certificate,"
                    Hint(
                        when {
                            keep && canKeep && policy ->
                                "Used on ${pick.hostId} to read the pool and apply what you choose. It is sealed to that machine on this " +
                                    "phone; the fleet relays it and cannot read it. This phone keeps it$word encrypted behind your " +
                                    "fingerprint or face, once ${pick.hostId} has signed in with it; the fleet never keeps it."
                            keep && canKeep ->
                                "Used on ${pick.hostId} to make a limited fleetwright user and its token. It is sealed to that machine on " +
                                    "this phone; the fleet relays it and cannot read it. This phone keeps it$word encrypted behind your " +
                                    "fingerprint or face, once ${pick.hostId} has signed in with it; the fleet never keeps it."
                            policy ->
                                "Used once, on ${pick.hostId}, to read the pool and apply what you choose, and not kept. " +
                                    "It is sealed to that machine on this phone; the fleet relays it and cannot read it."
                            else ->
                                "Used once, on ${pick.hostId}, to make a limited fleetwright user and its token, then dropped. " +
                                    "It is sealed to that machine on this phone; the fleet relays it and cannot read it."
                        },
                    )
                    // OFF UNTIL THE CERTIFICATE IS EITHER FINE OR ACKNOWLEDGED,
                    // or plain HTTP has been accepted: the host would refuse
                    // anyway, and a button that leads to a refusal is a button
                    // that lied.
                    OutlinedButton(
                        enabled = !beginning && email.isNotBlank() && password.isNotEmpty() && consented,
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) {
                        Text(
                            when {
                                beginning -> "Checking ${pick.hostId}'s key…"
                                policy -> "Read the pool on ${pick.hostId}"
                                else -> "Set up on ${pick.hostId}"
                            },
                        )
                    }
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
private fun PinLines(cert: String, hostId: String, address: String, fromMemory: Boolean = false) {
    Text("Certificate SHA-256", style = Design.Style.label, color = Design.Palette.inkDim.now)
    SelectionContainer {
        Text(
            XoSetup.groupedPin(cert),
            style = Design.Style.label,
            fontFamily = FontFamily.Monospace,
            color = Design.Palette.ink.now,
        )
    }
    Hint(
        if (fromMemory) "The certificate at $address as it was last time. The machine refuses to send the sign-in to any other."
        else "The certificate $hostId saw at $address. Compare it with the one your browser shows for Xen Orchestra; the machine refuses to send the sign-in to any other.",
    )
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
private fun CertificateAsk(probe: Fleet.Probe, address: String, acknowledged: Boolean, enabled: Boolean, onAcknowledged: (Boolean) -> Unit, kept: Boolean = false) {
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
        // THE PERSON'S EARLIER WORD for this same fingerprint, said in place
        // of the box it answers. A different certificate gets the box.
        if (kept) {
            Text(
                "You accepted this certificate before, and this phone kept that behind your fingerprint or face.",
                style = Design.Style.bodySmall,
                color = Design.Palette.inkDim.now,
            )
        } else {
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
private fun PlainAsk(probe: Fleet.Probe, address: String, accepted: Boolean, enabled: Boolean, onAccepted: (Boolean) -> Unit, kept: Boolean = false) {
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
        if (kept) {
            Text(
                "You chose to send it without HTTPS before, and this phone kept that behind your fingerprint or face.",
                style = Design.Style.bodySmall,
                color = Design.Palette.inkDim.now,
            )
        } else {
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
private fun SetupProgress(setup: Fleet.Setup, policy: Boolean = false) {
    val of = setup.of ?: (if (policy) XoPolicy.STEPS.size else XoSetup.STEPS.size)
    val step = setup.step ?: 0
    val ended = setup.state == "done" || setup.state == "failed" || setup.state == "cancelled"
    // THE BUILD'S OWN BAR while the machine says how far it has got. Asked
    // for: "this needs proper progress"; the step alone held the bar at four
    // fifths for the minutes the edge router takes.
    val part = setup.part.takeIf { setup.state == "running" }
    val fraction = when {
        setup.state == "done" -> 1f
        part != null -> part.fill / 1000f
        else -> (step.toFloat() / of.coerceAtLeast(1)).coerceIn(0f, 1f)
    }
    val shown by animateFloatAsState(fraction, animationSpec = Design.Motion.change(), label = "setup progress")
    val tone = when (setup.state) {
        "done" -> Design.Palette.ok.now
        "failed" -> Design.Palette.bad.now
        "cancelled" -> Design.Palette.idle.now
        else -> Design.Palette.active.now
    }
    val words = when (setup.state) {
        "waiting" -> "Waiting for the sign-in"
        "choosing" -> "Waiting for your choice"
        "done" -> if (policy) "Changed" else "Added"
        "failed" -> "Stopped"
        "cancelled" -> "Cancelled"
        else -> if (policy) XoPolicy.stepWords(setup.phase, step, of) else XoSetup.stepWords(setup.phase, step, of)
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
            val line = "Step ${(step + 1).coerceAtMost(of)} of $of" +
                (part?.let { " · building the edge router, part ${it.stage} of ${it.stages} · ${it.fill / 10}%" } ?: "")
            Text(line, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
        // While it waits on the person, the machine's sentence only says so
        // again; the form under it is what to read.
        if (setup.state != "choosing") setup.text?.let { Quoted(it) }
    }
}
