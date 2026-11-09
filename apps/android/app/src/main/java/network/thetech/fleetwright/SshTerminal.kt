package network.thetech.fleetwright

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlin.concurrent.thread

/**
 * This phone's own SSH key, for the terminal in the app (TerminalPage).
 * docs/hypervisors.md, "SSH in the app". The same as iOS (PhoneSSHKey.swift).
 *
 * MADE HERE, KEPT HERE: an Ed25519 key made on this phone the first time it is
 * asked for, encrypted as every secret here is (Settings.putSecret), gone at
 * sign-out. Only its public half leaves, as its own item in your vault
 * (`SSH_KEY_PHONE.<id>`) beside the keys you pasted, because the vault gives
 * nothing back to a phone and adding to the pasted list would mean replacing
 * it. A machine made after that takes it with the rest.
 *
 * A MACHINE'S HOST KEY IS HELD TO THE FIRST ONE IT SHOWED, by its name: each
 * machine is made fresh with a name nobody had.
 */
internal object PhoneSshKey {
    private const val KEY = "ssh-phone-key"
    private const val HOST_KEYS = "ssh-host-keys"
    private val bc = BouncyCastleProvider()

    fun keyPair(settings: Settings): KeyPair {
        settings.secret(KEY)?.let { stored ->
            runCatching {
                val o = JSONObject(stored)
                val factory = KeyFactory.getInstance("Ed25519", bc)
                return KeyPair(
                    factory.generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(o.getString("pub")))),
                    factory.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(o.getString("key")))),
                )
            }
        }
        val pair = KeyPairGenerator.getInstance("Ed25519", bc).generateKeyPair()
        settings.putSecret(
            KEY,
            JSONObject()
                .put("pub", Base64.getEncoder().encodeToString(pair.public.encoded))
                .put("key", Base64.getEncoder().encodeToString(pair.private.encoded))
                .toString(),
        )
        return pair
    }

    /** The public key's 32 bytes: the end of its X.509 encoding. */
    private fun raw(pub: PublicKey): ByteArray = pub.encoded.let { it.copyOfRange(it.size - 32, it.size) }

    /** The line a machine's authorized_keys takes. */
    fun publicLine(settings: Settings): String {
        val name = "ssh-ed25519".toByteArray()
        val key = raw(keyPair(settings).public)
        val blob = java.io.ByteArrayOutputStream().apply {
            write(java.nio.ByteBuffer.allocate(4).putInt(name.size).array()); write(name)
            write(java.nio.ByteBuffer.allocate(4).putInt(key.size).array()); write(key)
        }.toByteArray()
        return "ssh-ed25519 " + Base64.getEncoder().encodeToString(blob) + " fleetwright-phone"
    }

    /** The vault item it is kept under, named by the key, so a new key is a new item. */
    fun itemName(settings: Settings): String =
        "SSH_KEY_PHONE." + MessageDigest.getInstance("SHA-256").digest(raw(keyPair(settings).public)).take(6).joinToString("") { "%02x".format(it) }

    /** Put the public half in the vault. */
    suspend fun add(settings: Settings): Result<String> =
        PhoneVault(settings).keepSecret(Fleet(settings), itemName(settings), publicLine(settings))

    fun hostKey(settings: Settings, machine: String): String? =
        runCatching { JSONObject(settings.secret(HOST_KEYS) ?: "{}").optString(machine).takeIf { it.isNotBlank() } }.getOrNull()

    fun remember(settings: Settings, machine: String, fingerprint: String) {
        val all = runCatching { JSONObject(settings.secret(HOST_KEYS) ?: "{}") }.getOrDefault(JSONObject())
        // A machine lives hours: the list keeps the newest few hundred.
        val kept = if (all.length() > 300) JSONObject() else all
        settings.putSecret(HOST_KEYS, kept.put(machine, fingerprint).toString())
    }
}

/**
 * One SSH shell to a machine of yours, as `fleetwright`, with this phone's
 * key: a pty and a shell, bytes in and out, and the window's size. FROM AWAY,
 * sshj dials the loopback port a tunnel listens on (ConsoleTunnel.openPort),
 * so the machine carrying it and the fleet carry SSH's ciphertext. The same as
 * iOS (SSHTerminal.swift). Nothing here is logged.
 */
internal class SshTerminal(private val settings: Settings, private val machine: String, private val host: String, private val port: Int = 22) {
    @Volatile var onData: (ByteArray) -> Unit = {}
    /** It ended, and why; `refusedKey` when the machine would not take this phone's key. */
    @Volatile var onEnd: (String, Boolean) -> Unit = { _, _ -> }
    @Volatile private var ended = false
    private var client: SSHClient? = null
    private var session: Session? = null
    private var shell: Session.Shell? = null

    /** Connect, sign in and open the shell; throws what stopped it. */
    suspend fun open(cols: Int, rows: Int) = withContext(Dispatchers.IO) {
        val ssh = SSHClient(DefaultConfig())
        ssh.connectTimeout = 15_000
        var other: String? = null
        ssh.addHostKeyVerifier(object : HostKeyVerifier {
            override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                val seen = ProxmoxSsh.fingerprint(key)
                val first = PhoneSshKey.hostKey(settings, machine)
                if (first != null && first != seen) {
                    other = seen
                    return false
                }
                PhoneSshKey.remember(settings, machine, seen)
                return true
            }
            override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
        })
        try {
            ssh.connect(host, port)
        } catch (e: Exception) {
            other?.let { throw IllegalStateException("the machine answered with another host key ($it) than the one it showed first, so nothing was sent") }
            throw e
        }
        client = ssh
        try {
            ssh.authPublickey("fleetwright", ssh.loadKeys(PhoneSshKey.keyPair(settings)))
        } catch (e: UserAuthException) {
            runCatching { ssh.disconnect() }
            throw KeyRefused()
        }
        val s = ssh.startSession()
        session = s
        s.allocatePTY("xterm-256color", maxOf(cols, 20), maxOf(rows, 5), 0, 0, emptyMap<PTYMode, Int>())
        val sh = s.startShell()
        shell = sh
        thread(name = "ssh-terminal", isDaemon = true) {
            val buf = ByteArray(16 * 1024)
            val why = runCatching {
                val input = sh.inputStream
                while (!ended) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) onData(buf.copyOf(n))
                }
            }.exceptionOrNull()?.message
            finish(why ?: "the shell ended", report = true)
        }
    }

    /** The machine would not take this phone's key. */
    class KeyRefused : Exception("the machine refused this phone's key")

    fun send(bytes: ByteArray) {
        val sh = shell ?: return
        if (ended) return
        runCatching { sh.outputStream.write(bytes); sh.outputStream.flush() }
            .onFailure { finish(it.message ?: "the connection closed", report = true) }
    }

    fun resize(cols: Int, rows: Int) {
        runCatching { shell?.changeWindowDimensions(cols, rows, 0, 0) }
    }

    /** Asked to end: nothing is reported to [onEnd]. */
    fun close() = finish("closed here", report = false)

    private fun finish(why: String, report: Boolean) {
        synchronized(this) {
            if (ended) return
            ended = true
        }
        runCatching { session?.close() }
        runCatching { client?.disconnect() }
        if (report) onEnd(why, false)
    }
}
