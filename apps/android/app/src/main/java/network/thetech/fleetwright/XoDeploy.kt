package network.thetech.fleetwright

import org.json.JSONObject

/**
 * Installing Xen Orchestra on a pool that has none: the half that is
 * arithmetic and words, kept apart from the screen so a JVM test can run it,
 * the same as XoSetup. docs/hypervisors.md, "A pool without Xen Orchestra";
 * the machine's half is src/fleet/host/xo-deploy.js, and the words are iOS's
 * (DeployWords in DeployXOView.swift).
 *
 * WHAT THE PHONE HAS TO GET RIGHT, beyond what a setup does:
 *
 *   1. The pool master's SSH host key is shown and compared before anything
 *      is begun, because the root password goes only to a server answering
 *      with that key. Nobody vouches for an SSH key, so it is always asked.
 *   2. `deploy` is pinned to that key's SHA-256 in hex, and the machine signs
 *      the job's key under the install's own context over it, which this checks
 *      ([signingInput]): a setup's key, or one signed over another pool
 *      master's key, does not pass.
 *   3. Both passwords are sealed under the install's own binding ([aad]), so
 *      a sealed root password is never opened as a setup's sign-in.
 */
internal object XoDeploy {

    /** An SSH host key fingerprint, as OpenSSH prints it (SSH_HOST_KEY_RE). */
    val SSH_KEY_RE = Regex("^SHA256:[A-Za-z0-9+/]{43}$")

    /** The shortest admin password the machine takes (MIN_ADMIN_PASSWORD in xo-deploy.js). */
    const val MIN_ADMIN_PASSWORD = 12
    const val ADMIN_PASSWORD_SHORT = "At least 12 characters."

    /**
     * An install's own steps, in the host's order (XODEPLOY_STEPS before
     * onboarding's, which XoSetup.STEPS words), each with the words this app
     * says for it.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "reach" to "Reaching the pool master",
        "installer" to "Fetching the installer",
        "network" to "Setting up its network",
        "image" to "Getting Debian 13",
        "vm" to "Making its VM",
        "boot" to "Booting it",
        "packages" to "Installing packages",
        "build" to "Building Xen Orchestra",
        "admin" to "Replacing the default admin password",
    )

    /** The words for an install's own step, or null for a key that is not one. */
    fun words(phase: String?): String? = STEPS.firstOrNull { it.first == phase }?.second

    fun adminPasswordOk(p: String): Boolean = p.length in MIN_ADMIN_PASSWORD..256

    /** Reached the SSH server, saw a host key, and can install from there. */
    fun canInstall(probe: Fleet.Probe): Boolean {
        val ssh = probe.ssh ?: return false
        return ssh.reachable == true && ssh.deploy == true && hostKey(probe) != null
    }

    /** The key to pin: Ed25519 when the server has one, then ECDSA, then RSA. */
    fun hostKey(probe: Fleet.Probe): Fleet.SshKey? {
        val keys = probe.ssh?.keys.orEmpty()
        for (type in listOf("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa")) {
            keys.firstOrNull { it.type == type && SSH_KEY_RE.matches(it.fingerprint) && XoSetup.PIN_RE.matches(it.sha256) }?.let { return it }
        }
        return null
    }

    /** What prints that key's fingerprint on an XCP-ng host. */
    fun keygenCommand(type: String): String = when (type) {
        "ssh-ed25519" -> "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
        "ssh-rsa" -> "ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub"
        else -> "ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub"
    }

    /**
     * What one machine found over SSH, as a row's word. Null is cannot tell,
     * said as Can’t check and never as unreachable (C-5); an answer with no
     * `ssh` is a machine too old to have looked, which an update mends. The
     * same words for the watchdog and for Proxmox VE through a machine.
     */
    fun describe(probe: Fleet.Probe): String {
        val ssh = probe.ssh ?: return "Needs update"
        return when (ssh.reachable) {
            true -> when {
                ssh.deploy == true && hostKey(probe) != null -> "Ready"
                ssh.deploy == false && ssh.missing.isNotEmpty() -> "Missing ${ssh.missing.joinToString(", ")}"
                else -> "Can’t check"
            }
            false -> "Unreachable"
            null -> "Can’t check"
        }
    }

    /**
     * Why no machine is offered when none reached the SSH server; null when
     * one did, and its row says the rest. The verdict first, then one quiet
     * line naming the machines that could not check and the ones that need
     * an update: they did not find it unreachable, and are not said to have.
     * Adding the watchdog and Proxmox VE through a machine ask the same of
     * the same probe, in the same words.
     */
    fun nobody(probes: List<Fleet.Probe>, address: String): String? {
        if (probes.isEmpty()) return "No machines online. Add or start one first."
        if (probes.any { it.ssh?.reachable == true }) return null
        val missed = probes.any { it.ssh?.reachable == false }
        val unsure = probes.filter { p -> p.ssh?.let { it.reachable == null } == true }.map { it.hostId }.sorted()
        val old = probes.filter { it.ssh == null }.map { it.hostId }.sorted()
        val lines = mutableListOf(if (missed) "Couldn’t reach $address over SSH." else "No machine could check $address.")
        if (unsure.isNotEmpty()) lines += "${unsure.joinToString(", ")} couldn’t check."
        if (old.isNotEmpty()) lines += "${old.joinToString(", ")} need${if (old.size == 1) "s" else ""} an update."
        return lines.joinToString("\n")
    }

    /** The footer says the result; the custody is behind the disclosure (docs/reviews/copy-2026-11-06.md, "The rule to adopt"). */
    const val PASSWORDS_FOOTER = "Sets the password for admin@admin.net. Neither password is stored."
    const val CUSTODY_TITLE = "How your password is protected"
    fun custody(host: String): String =
        "The root password signs in to the pool master over SSH once, and $host forgets it as soon as it has. " +
            "Both passwords are encrypted on this phone so that only $host can read them."

    /** "Step 4 of 17", and "Step 4 of 17 · 42%" while the download says how far. */
    fun stepLine(step: Int, of: Int, fill: Int?): String {
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        val line = "Step $n of ${maxOf(of, 1)}"
        return if (fill != null) "$line · ${fill / 10}%" else line
    }

    fun signInLine(address: String): String =
        "Sign in to Xen Orchestra at https://$address as admin@admin.net with the password you chose."

    /**
     * The bytes the machine signed for an install: its own context, then the
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
        return "agent-fleet/v1/xodeploy-key\n{\"address\":\"$address\",\"job\":\"$job\",\"key\":\"$key\",\"pin\":\"$pin\"}"
            .toByteArray(Charsets.UTF_8)
    }

    /** What an install's passwords are sealed under (xodeployAad in src/fleet/seal.js). */
    fun aad(job: String, address: String): String = "fleetwright-xodeploy/v1:$job:$address"

    /**
     * Both passwords, sealed to the job's key, as the one string `run`
     * carries. Built and returned rather than kept: the caller clears both
     * fields the moment this returns. [reply] goes inside the same seal, the
     * key the machine seals the token back to (XoHandoff).
     */
    fun sealPasswords(key: String, job: String, address: String, rootPassword: String, adminPassword: String, reply: String): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("purpose", "deploy")
            .put("root", JSONObject().put("password", rootPassword))
            .put("xo", JSONObject().put("password", adminPassword))
            .put("reply", reply)
        val sealed = Seal.seal(key, aad(job, address), payload)
        return "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
    }
}
