package network.thetech.fleetwright

import org.json.JSONObject

/**
 * Adding Fleetwright's reconnect watchdog to a Xen Orchestra that predates it:
 * the half that is arithmetic and words, kept apart from the screen so a JVM
 * test can run it, as XoDeploy is for an install. docs/hypervisors.md, "When
 * Xen Orchestra loses a pool"; the machine's half is the `watchdog` phase in
 * src/fleet/host/xo-setup.js and src/fleet/host/xo-watchdog.js.
 *
 * WHY THROUGH THE POOL MASTER. Xen Orchestra's API can load a plugin and
 * cannot install one, and one Fleetwright installed has no login. What does
 * reach inside it is the pool master that runs its VM, with its root
 * password: the VM is shut down, its disk opened on the pool master, the
 * watchdog put in, and the VM started again.
 *
 * WHAT THE PHONE HAS TO GET RIGHT is an install's first half (XoDeploy), with
 * names of its own:
 *
 *   1. The pool master's SSH host key is shown and compared before anything
 *      is begun, and `watchdog` is pinned to its SHA-256 in hex.
 *   2. The machine signs the job's key under this job's own context
 *      (`xowatchdog-key`), which this checks ([signingInput]): an install's
 *      key, or a setup's, does not pass, so a key made for one can never be
 *      sent a root password for the other.
 *   3. The root password is sealed under this job's own binding ([aad]), so
 *      a root password sealed for this is never opened as an install's, which
 *      would also make a VM. Beside it goes where Xen Orchestra answers, the
 *      address the machine finds its VM by. Nothing is handed back, so there
 *      is no reply key.
 */
internal object XoWatchdog {

    /** What the sealed message names as its purpose, what `can` holds, and what progress says it is. */
    const val PURPOSE = "watchdog"

    /**
     * Its steps, in XOWATCHDOG_STEPS order (src/fleet/protocol/intents.js),
     * each with the words this app says for it: the host's own (STEP_WORDS in
     * xo-setup.js). `reach` is an install's first step, said the same.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "reach" to "Reaching the pool master",
        "find" to "Finding Xen Orchestra’s VM",
        "stop" to "Shutting it down",
        "add" to "Adding the watchdog to its disk",
        "start" to "Starting it again",
    )

    /** The words for one of its steps, or null for a key that is not one. */
    fun words(phase: String?): String? = STEPS.firstOrNull { it.first == phase }?.second

    fun stepWords(phase: String?, step: Int, of: Int): String {
        if (phase == "done") return "Done"
        words(phase)?.let { return it }
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        return "Step $n of ${maxOf(of, 1)}"
    }

    /** The ongoing notification's title, and the screen's once it ends: the coordinator's words (WATCHDOG_TITLES in core.js). */
    fun title(state: String): String = when (state) {
        "done" -> "Watchdog added"
        "failed" -> "The watchdog was not added"
        "cancelled" -> "Adding the watchdog cancelled"
        else -> "Adding the reconnect watchdog"
    }

    /**
     * What will happen, said before the root password is asked for, because
     * it takes Xen Orchestra away for a while and the person should choose
     * when.
     */
    const val WHAT_HAPPENS =
        "Xen Orchestra’s VM is shut down for a minute or two while the watchdog is put on its disk, then started again. " +
            "Xen Orchestra is unavailable meanwhile."

    fun passwordFooter(host: String): String =
        "The root password signs in to the pool master over SSH once, and $host forgets it as soon as it has. It is sealed on " +
            "this phone to a key only $host holds."

    /**
     * What one machine found over SSH, for this job. The same reading as an
     * install's (XoDeploy.describe), in this job's words where they differ:
     * null is cannot tell, and an answer with no `ssh` is a machine too old to
     * have looked.
     */
    fun describe(probe: Fleet.Probe): String {
        val ssh = probe.ssh ?: return "Too old to add the watchdog. Update it, then ask again."
        if (ssh.reachable != true) return XoDeploy.describe(probe)
        return when {
            XoDeploy.canInstall(probe) -> "Reached its SSH server"
            ssh.deploy == false && ssh.missing.isNotEmpty() ->
                "Reached its SSH server, and has no ${ssh.missing.joinToString(", ")} to sign in with"
            else -> "Reached its SSH server, and cannot tell whether it can sign in from there"
        }
    }

    /**
     * The bytes the machine signed for this job: its own context, then the
     * four values as canonical JSON, keys sorted (src/fleet/crypto.js
     * `signingInput`). Every value is held to its own shape first, and none
     * of those shapes can hold a quote or a backslash, so writing the JSON by
     * hand is safe.
     */
    fun signingInput(address: String, job: String, key: String, pin: String): ByteArray {
        require(XoSetup.ADDRESS_RE.matches(address)) { "not a pool master address" }
        require(XoSetup.JOB_RE.matches(job)) { "not a setup job" }
        require(Seal.KEY_RE.matches(key)) { "not a P-256 public key" }
        require(XoSetup.PIN_RE.matches(pin)) { "not a host key's SHA-256" }
        return "agent-fleet/v1/xowatchdog-key\n{\"address\":\"$address\",\"job\":\"$job\",\"key\":\"$key\",\"pin\":\"$pin\"}"
            .toByteArray(Charsets.UTF_8)
    }

    /** What the root password is sealed under (xowatchdogAad in src/fleet/seal.js): the pool master's address, as begun. */
    fun aad(job: String, address: String): String = "fleetwright-xowatchdog/v1:$job:$address"

    /**
     * The root password and where Xen Orchestra answers, sealed to the job's
     * key, as the one string `run` carries. [address] is the pool master's,
     * as the job was begun; [xoAddress] is the one this phone keeps the pool
     * under. Built and returned rather than kept: the caller clears the
     * field the moment this returns.
     */
    fun sealRoot(key: String, job: String, address: String, rootPassword: String, xoAddress: String): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("purpose", PURPOSE)
            .put("root", JSONObject().put("password", rootPassword))
            .put("xo", JSONObject().put("address", xoAddress))
        val sealed = Seal.seal(key, aad(job, address), payload)
        return "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
    }
}
