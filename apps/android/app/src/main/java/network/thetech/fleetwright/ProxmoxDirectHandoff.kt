package network.thetech.fleetwright

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * A Proxmox VE setup this phone started on the node itself, followed after
 * its screen has closed: the direct route's half of "the screen may be
 * closed" ([ProxmoxThroughHandoff] is the machine route's). iOS's
 * ProxmoxDirectHandoff says the same. docs/proxmox.md, "One way in".
 *
 * THE SETUP RUNS ON THE NODE, as a unit of its own, whatever the phone does;
 * what needed the screen was reaching the node again to read the line, which
 * takes the root password. So while a run is going, the password is kept in
 * the app's encrypted store under the node's address, beside the host key the
 * person checked and the node's clock at the start. It is wiped the moment
 * the line is in the vault, the run fails, or six hours pass. It never leaves
 * this phone: it goes to the node, as it did when the screen held it, and
 * nowhere else.
 *
 * A LINE TAKEN AND NOT YET KEPT is held there too: taking it removes it from
 * the node, so a vault that did not answer must not lose it. It is kept at
 * the next look.
 */
internal object ProxmoxDirectHandoff {
    const val KEEP_FOR_MS = XoHandoff.KEEP_FOR_MS

    /** A run this phone is still owed a line from. Nothing secret. */
    data class Pending(val address: String, val fingerprint: String, val since: Long, val at: Long)

    sealed interface Outcome {
        /** In the vault, under the cluster's address. */
        data class Kept(val address: String) : Outcome

        /** Over without a line, and why. */
        data class Failed(val text: String) : Outcome
    }

    /** One look per node at a time, so the screen and the front of the app never both take its line. */
    private val looking = Mutex()

    private fun passwordName(address: String) = "pvedirect-password.$address"
    private fun lineName(address: String) = "pvedirect-line.$address"

    /** A run begun: what reaching the node again needs, kept until it ends. */
    fun started(settings: Settings, address: String, fingerprint: String, since: Long, password: String, now: Long = System.currentTimeMillis()) {
        settings.putSecret(passwordName(address), password)
        settings.putSecret(lineName(address), "")
        save(settings, pending(settings).filter { it.address != address } + Pending(address, fingerprint, since, now))
    }

    /** The run is over, or given up on: the password goes. */
    fun forget(settings: Settings, address: String) {
        settings.putSecret(passwordName(address), "")
        settings.putSecret(lineName(address), "")
        save(settings, pending(settings).filter { it.address != address })
    }

    fun isPending(settings: Settings, address: String): Boolean = pending(settings).any { it.address == address }

    /**
     * One look at the run: how far it has got, and, once it has ended, what
     * came of it. Null when this phone follows no run at that address. A
     * failure means the node did not answer, which is said and tried again.
     */
    suspend fun look(settings: Settings, address: String): Result<Pair<ProxmoxSsh.Progress?, Outcome?>>? = looking.withLock {
        val entry = pending(settings).firstOrNull { it.address == address } ?: return@withLock null
        settings.secret(lineName(address))?.let(ProxmoxLine::parse)?.let { record ->
            return@withLock Result.success(null to keep(settings, record, address))
        }
        val password = settings.secret(passwordName(address))?.takeIf { it.isNotEmpty() }
        if (password == null) {
            forget(settings, address)
            return@withLock null
        }
        runCatching {
            val (_, out) = ProxmoxSsh.run(address, entry.fingerprint, password, ProxmoxSsh.pollCommand(entry.since)).getOrThrow()
            val progress = ProxmoxSsh.progressOf(out)
            when {
                progress.lineReady -> {
                    val (_, got) = ProxmoxSsh.run(address, entry.fingerprint, password, ProxmoxSsh.TAKE_LINE).getOrThrow()
                    val record = ProxmoxLine.parse(got)
                    if (record == null) {
                        forget(settings, address)
                        progress to Outcome.Failed("The setup finished, but what it left couldn’t be read. Run it again; it finds what it made.")
                    } else {
                        settings.putSecret(lineName(address), got.trim())
                        progress to keep(settings, record, address)
                    }
                }
                !progress.running -> {
                    forget(settings, address)
                    progress to Outcome.Failed(progress.error ?: "The setup stopped without saying why. On the node: journalctl -u ${ProxmoxSsh.UNIT}")
                }
                else -> progress to null
            }
        }
    }

    /** The line in the vault; held for the next look when the vault did not answer. */
    private suspend fun keep(settings: Settings, record: ProxmoxLine.Record, address: String): Outcome =
        PhoneVault(settings).keepHypervisor(Fleet(settings), record.address, record.json).fold(
            onSuccess = {
                // KEPT HERE TOO, for the console in the app (ProxmoxKept).
                ProxmoxKept.keep(settings, record)
                forget(settings, address)
                Outcome.Kept(record.address)
            },
            onFailure = {
                Outcome.Failed(
                    "The node is set up, but its access isn’t saved yet: ${it.message ?: "it couldn’t be saved."} " +
                        "This phone tries again when it is next open.",
                )
            },
        )

    /** When the app comes back to the front, and at launch: every run still owed a line is looked at once. */
    suspend fun collectPending(settings: Settings, now: Long = System.currentTimeMillis()) {
        for (entry in pending(settings)) {
            if (now - entry.at > KEEP_FOR_MS) {
                forget(settings, entry.address)
                continue
            }
            look(settings, entry.address)
        }
    }

    fun pending(settings: Settings): List<Pending> = runCatching {
        val all = JSONArray(settings.pveDirectPending.ifBlank { "[]" })
        (0 until all.length()).map { i ->
            val o = all.getJSONObject(i)
            Pending(o.getString("address"), o.getString("fingerprint"), o.getLong("since"), o.getLong("at"))
        }
    }.getOrDefault(emptyList())

    private fun save(settings: Settings, all: List<Pending>) {
        settings.pveDirectPending = if (all.isEmpty()) {
            ""
        } else {
            JSONArray(all.map { JSONObject().put("address", it.address).put("fingerprint", it.fingerprint).put("since", it.since).put("at", it.at) }).toString()
        }
    }
}
