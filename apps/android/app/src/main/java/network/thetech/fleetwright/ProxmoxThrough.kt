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
import org.json.JSONObject

/**
 * Setting up Proxmox VE through a machine of the fleet, for when this phone
 * cannot reach the node: the half that is arithmetic and words, kept apart
 * from the screen so a JVM test can run it, as XoWatchdog is. docs/proxmox.md,
 * "Through a machine"; the machine's half is src/fleet/host/pve-setup.js.
 *
 * THE SAME WAY AS EVERYTHING ELSE that reaches a server this phone cannot:
 *
 *   1. The node's SSH host key, as a machine that reaches it saw it, is shown
 *      and compared before anything is begun, and `pve` is pinned to its
 *      SHA-256 in hex.
 *   2. The machine signs the job's key under this job's own context
 *      (`pvesetup-key`), which this checks ([signingInput]): no other job's
 *      key passes, so a key made for another can never be sent this password.
 *   3. The root password is sealed under this job's own binding ([aad]), with
 *      a key for the line to come back to, which it does sealed under its own
 *      name ([handoffAad]). The key is kept until the line is in the vault,
 *      so the screen may be closed while it runs ([ProxmoxThroughHandoff]).
 */
internal object ProxmoxThrough {

    /** What the sealed message names as its purpose, what `can` holds, and what progress says it is. */
    const val PURPOSE = "pve"

    /**
     * Its steps, in PVESETUP_STEPS order (src/fleet/protocol/intents.js),
     * each with the words the host leaves on the job (PVE_STEP_WORDS in
     * xo-setup.js). Its own, because `user`, `token` and `image` name other
     * things in a Xen Orchestra job.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "node" to "Reaching the node",
        "pool" to "Making the pool",
        "user" to "Making the user and its roles",
        "token" to "Making its token",
        "fence" to "Making the firewall group",
        "networks" to "Making lab and group networks",
        "image" to "Building the machine image",
        "line" to "Handing over the line",
    )

    fun stepWords(phase: String?, step: Int, of: Int): String {
        if (phase == "done") return "Done"
        STEPS.firstOrNull { it.first == phase }?.second?.let { return it }
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        return "Step $n of ${maxOf(of, 1)}"
    }

    /** The ongoing notification's title, and the screen's once it ends: the coordinator's words (PVE_TITLES in core.js). */
    fun title(state: String): String = when (state) {
        "done" -> "Proxmox VE set up"
        "failed" -> "Proxmox VE was not set up"
        "cancelled" -> "Setting up Proxmox VE cancelled"
        else -> "Setting up Proxmox VE"
    }

    /** Said when this phone tried the node and could not reach it. */
    fun unreachable(node: String): String =
        "This phone could not reach $node, so one of your machines that can sets it up: the same steps, run on the node over SSH. " +
            "The root password is sealed on this phone to that machine alone."

    const val INTRO =
        "When this phone cannot reach the node, one of your machines that can does the setup for it: the same steps, run on the node " +
            "over SSH. The root password is sealed on this phone to that machine alone."

    const val MAY_CLOSE =
        "With the machine image this takes several minutes, and you need not watch: the setup goes on on the node, " +
            "and the line comes back sealed to this phone, which keeps it in your vault when Fleetwright is next open."

    fun passwordFooter(host: String): String =
        "It signs in to the node over SSH once, and $host forgets it as soon as it has. The line comes back sealed to this phone, and " +
            "$host keeps no copy."

    /** The bytes the machine signed for this job, as src/fleet/crypto.js `signingInput` writes them; every value held to its shape first. */
    fun signingInput(address: String, job: String, key: String, pin: String): ByteArray {
        require(XoSetup.ADDRESS_RE.matches(address)) { "not a node address" }
        require(XoSetup.JOB_RE.matches(job)) { "not a setup job" }
        require(Seal.KEY_RE.matches(key)) { "not a P-256 public key" }
        require(XoSetup.PIN_RE.matches(pin)) { "not a host key's SHA-256" }
        return "agent-fleet/v1/pvesetup-key\n{\"address\":\"$address\",\"job\":\"$job\",\"key\":\"$key\",\"pin\":\"$pin\"}"
            .toByteArray(Charsets.UTF_8)
    }

    /** What the root password is sealed under (pvesetupAad in src/fleet/seal.js): the node's address, as begun. */
    fun aad(job: String, address: String): String = "fleetwright-pvesetup/v1:$job:$address"

    /** What the line comes back sealed under (pvesetupHandoffAad in src/fleet/seal.js). */
    fun handoffAad(job: String, address: String): String = "fleetwright-pvesetup-handoff/v1:$job:$address"

    /** The root password and the key the line comes back to, sealed to the job's key, as the one string `run` carries. */
    fun sealRoot(key: String, job: String, address: String, rootPassword: String, reply: String, vmids: String = ""): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("purpose", PURPOSE)
            .put("root", JSONObject().put("password", rootPassword))
            .put("reply", reply)
            .put("vmids", if (ProxmoxLine.isVmids(vmids)) vmids else "")
        val sealed = Seal.seal(key, aad(job, address), payload)
        return "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
    }

    /** The line the machine sealed back, or null for anything that does not open under this job and node with this key, or is not a line. */
    fun openLine(handoff: String, job: String, address: String, key: Seal.OneUseKey): ProxmoxLine.Record? {
        val parts = handoff.split(".")
        if (parts.size != 3) return null
        val inside = runCatching {
            Seal.open(key, handoffAad(job, address), JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2]))
        }.getOrNull() ?: return null
        return ProxmoxLine.parse(inside.optString("line"))
    }
}

/**
 * The screen: the node, which machine reaches it, its host key, the root
 * password, and the steps as the machine runs them. The same pieces and
 * words as adding the watchdog (XoWatchdogSheet), which is the job it is
 * modelled on. The line is handed to [keep], the Add Proxmox VE screen's.
 *
 * THE PASSWORD AND THE REPLY KEY ARE IN MEMORY ONLY, never saveable.
 */
@Composable
internal fun ProxmoxThroughSheet(
    settings: Settings,
    startNode: String,
    password: String = "",
    /** The range of machine numbers the person gave, or empty (ProxmoxSheet). */
    vmids: String = "",
    /** Opened because this phone could not reach the node: machines are asked at once, and the first that reached it is chosen. */
    auto: Boolean = false,
    kept: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }

    var address by rememberSaveable { mutableStateOf(startNode.trim()) }
    var probing by remember { mutableStateOf(false) }
    var probes by remember { mutableStateOf<List<Fleet.Probe>?>(null) }
    var probeText by remember { mutableStateOf("") }
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    var matched by rememberSaveable { mutableStateOf(false) }
    var rootPassword by remember { mutableStateOf(password) }
    var beginning by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf("") }
    var unvouched by remember { mutableStateOf<Begun?>(null) }

    var job by remember { mutableStateOf<String?>(null) }
    var jobAddress by remember { mutableStateOf("") }
    var runningOn by remember { mutableStateOf("") }
    var progress by remember { mutableStateOf<Fleet.Setup?>(null) }
    var cancelling by remember { mutableStateOf(false) }
    var cancelAccepted by remember { mutableStateOf(false) }
    var lineKept by remember { mutableStateOf(false) }
    var keepAgain by remember { mutableStateOf(false) }
    var keeping by remember { mutableStateOf(false) }

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
                // The first that reached it, when there is a choice to make for
                // the person; any other is one tap away in the list.
                val fit = r.probes.filter { XoDeploy.canInstall(it) }
                (if (auto) fit.firstOrNull() else fit.singleOrNull())?.let { chosen = it.hostId }
            } else {
                probeText = r.text.ifBlank { "The fleet did not try that address." }
            }
            probing = false
        }
    }

    LaunchedEffect(Unit) {
        if (auto && probes == null && job == null && addressOk) probe()
    }

    suspend fun run(b: Begun) {
        val key = b.setup.key ?: return
        // THE KEY THE LINE COMES BACK TO OUTLIVES THIS SCREEN: kept under the
        // job until the line is in the vault (ProxmoxThroughHandoff).
        val back = ProxmoxThroughHandoff.newKey(settings, b.setup.job, b.where)
        val sealed = ProxmoxThrough.sealRoot(key, b.setup.job, b.where, rootPassword, back.publicKey, vmids)
        rootPassword = ""
        val r = fleet.xosetup("run", job = b.setup.job, sealed = sealed)
        if (!r.ok) {
            ProxmoxThroughHandoff.forget(settings, b.setup.job)
            refusal = r.text.ifBlank { "${b.hostId} did not take the root password." }
            return
        }
        job = b.setup.job
        jobAddress = b.where
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
            val r = fleet.xosetup("pve", address = where, pin = pin, host = p.hostId)
            val setup = r.xosetup
            val hostId = r.hostId ?: p.hostId
            when {
                !r.ok || setup == null -> refusal = r.text.ifBlank { "${p.hostId} did not begin setting up Proxmox VE." }
                // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under
                // this job's own context and over the host key compared.
                setup.key == null || !XoSetup.verifyKeySig(setup.hostKey, setup.keySig, runCatching { ProxmoxThrough.signingInput(where, setup.job, setup.key, pin) }.getOrDefault(ByteArray(0))) -> {
                    rootPassword = ""
                    refusal = "That key did not come from $hostId. Nothing was sent. Something between this phone and that machine is not what it says it is, so check the fleet before trying again."
                    runCatching { fleet.xosetup("cancel", job = setup.job) }
                }
                else -> {
                    val fingerprint = PhoneVault.fingerprint(setup.hostKey!!)
                    val listed = runCatching { fleet.enrolledHosts() }.getOrDefault(emptyList())
                        .firstOrNull { it.hostId == hostId }?.publicJwk?.let { PhoneVault.fingerprint(it) }
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

    fun startAgain() {
        job = null
        progress = null
        lineKept = false
        keepAgain = false
        refusal = ""
        matched = false
        cancelAccepted = false
    }

    // ONCE IT IS DONE, the line opened with the kept key and put in the
    // vault, and the key dropped; a job that ended otherwise drops its key.
    suspend fun keepLine(id: String, done: Fleet.Setup) {
        keeping = true
        when (val got = ProxmoxThroughHandoff.collect(settings, fleet, id, done)) {
            is ProxmoxThroughHandoff.Outcome.Kept -> {
                lineKept = true
                keepAgain = false
                kept(got.address)
            }
            is ProxmoxThroughHandoff.Outcome.Failed -> {
                keepAgain = got.again
                refusal = got.text
            }
            // Gone from the list: kept already, from the front of the app.
            null -> if (ProxmoxThroughHandoff.pending(settings).none { it.job == id }) {
                lineKept = true
                kept(jobAddress)
            } else {
                keepAgain = true
            }
        }
        keeping = false
    }

    // THE POLL, ONLY WHILE THIS IS ON SCREEN; the job goes on without it.
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
            refusal = r.text.ifBlank { "The fleet did not answer about the setup." }
            if (r.code == "unknown_job" || unanswered >= 5) break
        }
        val done = progress
        if (done?.state == "failed" || done?.state == "cancelled") ProxmoxThroughHandoff.forget(settings, id)
        if (done?.state == "done" && !lineKept) keepLine(id, done)
    }

    FullScreen(title = "Through a machine", onDismiss = { rootPassword = ""; onDismiss() }) {
        val setup = progress
        val waitingOn = unvouched
        when {
            job != null -> {
                SectionHead("Setting it up")
                if (runningOn.isNotBlank()) Hint("On $runningOn, for the node at $jobAddress", color = Design.Palette.ink.now)
                // THE SCREEN MAY BE CLOSED: said while it runs, so nobody
                // waits on it for minutes thinking they must.
                if (!lineKept) Hint(ProxmoxThrough.MAY_CLOSE)
                if (setup == null) {
                    Hint("Asking where it has got to…")
                } else {
                    DeployProgress(setup, stateWords = ::pveStateWords, stepWords = ProxmoxThrough::stepWords)
                }
                when {
                    setup != null && (setup.state == "running" || setup.state == "waiting") && !cancelAccepted ->
                        TextButton(enabled = !cancelling, onClick = {
                            scope.launch {
                                cancelling = true
                                val r = fleet.xosetup("cancel", job = setup.job)
                                if (r.ok) { cancelAccepted = true; r.xosetup?.let { progress = it } } else refusal = r.text.ifBlank { "Could not cancel." }
                                cancelling = false
                            }
                        }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (cancelling) "Cancelling…" else "Cancel") }
                    setup != null && setup.state == "done" && lineKept ->
                        TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") }
                    setup != null && setup.state == "done" && keepAgain ->
                        TextButton(
                            enabled = !keeping,
                            onClick = { scope.launch { keepLine(setup.job, setup) } },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(if (keeping) "Keeping…" else "Keep the line") }
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
                Hint(if (auto) ProxmoxThrough.unreachable(address.trim()) else ProxmoxThrough.INTRO, color = Design.Palette.ink.now)
                SectionHead("The node")
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
                    label = { Text("The node's address") },
                    supportingText = { Text("Its host name or address, as you would SSH to it as root.") },
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
                    SectionHead("Which machine sets it up")
                    XoDeploy.nobody(found, address.trim(), doing = "set up Proxmox VE")?.let { Hint(it.replace("the pool master", "the node"), color = Design.Palette.attention.now) }
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
                            // Said, and not offered (C-2): it reached the node,
                            // and cannot sign in to it from there.
                            Text("${p.hostId} · ${XoWatchdog.describe(p)}", style = Design.Style.label, color = Design.Palette.attention.now)
                        }
                    }
                }

                val key = pick?.let { XoDeploy.hostKey(it) }
                if (pick != null && key != null) {
                    HostKeyAsk(pick.hostId, address.trim(), key, matched, enabled = !beginning, onMatched = { matched = it }, node = true)

                    SectionHead("Root password")
                    OutlinedTextField(
                        value = rootPassword,
                        onValueChange = { rootPassword = it },
                        label = { Text("Root password of the node") },
                        singleLine = true,
                        enabled = !beginning,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Hint(ProxmoxThrough.passwordFooter(pick.hostId))
                    OutlinedButton(
                        enabled = !beginning && matched && rootPassword.isNotEmpty(),
                        onClick = { begin() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (beginning) "Checking ${pick.hostId}'s key…" else "Set it up from ${pick.hostId}") }
                }
            }
        }
        if (refusal.isNotBlank()) Hint(refusal, color = Design.Palette.bad.now)
    }
}

/** This job's words for a state that is not one of its steps, or null for one that is. */
private fun pveStateWords(state: String): String? = when (state) {
    "waiting" -> "Waiting for the root password"
    "done", "failed", "cancelled" -> ProxmoxThrough.title(state)
    else -> null
}
