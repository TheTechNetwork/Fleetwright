package network.thetech.fleetwright

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.IOUtils
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Security
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * THE PROXMOX SETUP RUN FROM THIS PHONE, over SSH to the node as root.
 * docs/proxmox.md, "From the phone". The same steps as iOS's ProxmoxSSH, and
 * the same commands, which test/pve-pools.test.js holds equal.
 *
 * THE ROOT PASSWORD GOES FROM THIS PHONE TO THE NODE AND NOWHERE ELSE. No
 * machine of the fleet is in the path, so there is nothing to seal it to and
 * nobody but the node to read it; it lives in the screen's memory while the
 * screen is open.
 *
 * THE NODE IS WHO IT SAYS ONLY ONCE ITS KEY IS. The first connection reads the
 * host key and goes no further; the person compares its fingerprint with the
 * node's console, and only then is the password sent, to a node holding that
 * key and no other. The fingerprint is kept for the address, so a later run
 * goes straight through, and a different key is refused and said.
 *
 * THE JOB OUTLIVES THE CONNECTION. The setup takes minutes, mostly building
 * the image, and a phone locks: it runs under `systemd-run` as a unit of its
 * own, and the phone asks it how far it has got rather than holding a pipe
 * open. The line it ends with, which is the token, is written to a file only
 * root reads and never printed, so the journal the phone reads never holds it.
 */
internal object ProxmoxSsh {
    init {
        // ANDROID'S OWN "BC" IS A CUT-DOWN BOUNCYCASTLE that lacks what sshj
        // asks for (curve25519, among others); the full one takes its name.
        Security.removeProvider("BC")
        Security.insertProviderAt(BouncyCastleProvider(), 1)
    }

    const val UNIT = "fleetwright-pve-setup"
    const val LINE_FILE = "/root/.fleetwright-pve-line"

    /** The node's clock at the start, so the journal is read from this run alone. */
    const val NOW = "date +%s"

    /**
     * Start the setup as a unit of its own, with the command the phone shows
     * for running it by hand, and the line to a file. A run already going is
     * stopped first: the person asked again.
     */
    fun startCommand(coordinator: String): String {
        val run = ProxmoxLine.setupCommand(coordinator) + " --line-file $LINE_FILE"
        return "systemctl stop $UNIT 2>/dev/null; systemctl reset-failed $UNIT 2>/dev/null; rm -f $LINE_FILE; " +
            "systemd-run --unit=$UNIT --collect /bin/bash -c '$run'"
    }

    /**
     * How far it has got: its step and error lines since `since`, the last
     * `fleetwright-part:` line of the step it is on, whether it runs, and
     * whether the line is there.
     */
    fun pollCommand(since: Long): String =
        "journalctl -u $UNIT --since @$since -o cat --no-pager | " +
            "awk '/^fleetwright-(step|error):/ {print} /^fleetwright-step:/ {p=0} /^fleetwright-part:/ {p=$0} END {if (p) print p}'; " +
            "echo \"state=$(systemctl is-active $UNIT)\"; test -f $LINE_FILE && echo line=ready"

    /** The line, read once and removed. */
    const val TAKE_LINE = "cat $LINE_FILE && rm -f $LINE_FILE"

    /** What a poll said; [part] is how far into the step it is on, null when it said nothing of this step. */
    data class Progress(val steps: List<String>, val error: String?, val running: Boolean, val lineReady: Boolean, val part: Part? = null)

    /** [fill] in thousandths, or null when the script measured nothing, and what it is doing. pve-setup.js, partOf, reads it the same way. */
    data class Part(val fill: Int?, val text: String)

    fun progressOf(out: String): Progress {
        val lines = out.lines()
        val afterStep = lines.indexOfLast { it.startsWith("fleetwright-step: ") } + 1
        return Progress(
            steps = lines.filter { it.startsWith("fleetwright-step: ") }.map { it.removePrefix("fleetwright-step: ").trim() },
            error = lines.lastOrNull { it.startsWith("fleetwright-error: ") }?.removePrefix("fleetwright-error: ")?.trim(),
            running = lines.any { it == "state=active" || it == "state=activating" },
            lineReady = lines.any { it == "line=ready" },
            part = lines.drop(afterStep).lastOrNull { it.startsWith("fleetwright-part: ") }?.let(::partOf),
        )
    }

    /** One `fleetwright-part:` line, or null for one not shaped as the script writes it. */
    fun partOf(line: String): Part? {
        val m = Regex("^fleetwright-part: (-|\\d{1,4}) (.+)$").find(line.trim()) ?: return null
        val text = m.groupValues[2].replace(Regex("[\\u0000-\\u001f\\u007f]+"), " ").trim().take(160)
        return Part(if (m.groupValues[1] == "-") null else minOf(1000, m.groupValues[1].toInt()), text)
    }

    /** A step as the person reads it. */
    fun stepWords(step: String): String = when (step) {
        "pool" -> "The pool"
        "user" -> "The user and its roles"
        "token" -> "Its token"
        "fence" -> "The firewall group"
        "networks" -> "Lab and group networks"
        "image" -> "The machine image, which takes a few minutes"
        "line" -> "The line for this phone"
        "done" -> "Done"
        else -> step
    }

    /** A key's fingerprint as `ssh-keygen -lf` prints it: SHA256 and unpadded base64. */
    fun fingerprint(key: PublicKey): String {
        val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
        return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob))
    }

    /** Address and port, as typed: `host`, `host:port`, or `[v6]:port`. */
    fun hostAndPort(address: String): Pair<String, Int> {
        val a = address.trim()
        Regex("^\\[([^\\]]+)\\](?::(\\d+))?$").find(a)?.let { return it.groupValues[1] to (it.groupValues[2].toIntOrNull() ?: 22) }
        val i = a.lastIndexOf(':')
        return if (i > 0 && a.indexOf(':') == i) a.substring(0, i) to (a.substring(i + 1).toIntOrNull() ?: 22) else a to 22
    }

    /** The node's host key, without signing in: the first look. */
    suspend fun hostKey(address: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val (host, port) = hostAndPort(address)
            var seen: String? = null
            val ssh = SSHClient(DefaultConfig())
            ssh.connectTimeout = 10_000
            ssh.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    seen = fingerprint(key)
                    return false
                }
                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
            })
            runCatching { ssh.connect(host, port) }
            runCatching { ssh.disconnect() }
            seen ?: error("$host:$port did not answer as an SSH server.")
        }
    }

    /**
     * Run one command as root on the node, with the key it must hold. Answers
     * the output and the exit status.
     */
    suspend fun run(address: String, fingerprint: String, password: String, command: String): Result<Pair<Int, String>> = withContext(Dispatchers.IO) {
        runCatching {
            val (host, port) = hostAndPort(address)
            val ssh = SSHClient(DefaultConfig())
            ssh.connectTimeout = 10_000
            ssh.timeout = 60_000
            var other: String? = null
            ssh.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    val f = fingerprint(key)
                    if (f != fingerprint) other = f
                    return f == fingerprint
                }
                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
            })
            try {
                try {
                    ssh.connect(host, port)
                } catch (e: Exception) {
                    other?.let { error("$host answered with another key ($it) than the one you checked. Nothing was sent.") }
                    throw e
                }
                ssh.authPassword("root", password)
                ssh.startSession().use { session ->
                    val cmd = session.exec(command)
                    val out = IOUtils.readFully(cmd.inputStream).toString(Charsets.UTF_8.name())
                    cmd.join(60, TimeUnit.SECONDS)
                    (cmd.exitStatus ?: -1) to out
                }
            } finally {
                runCatching { ssh.disconnect() }
            }
        }
    }
}
