package network.thetech.fleetwright

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * Where a Proxmox VE setup run through a machine hands its line back: to this
 * phone, which keeps it in the person's vault, whether or not the screen that
 * started it is still open. iOS's ProxmoxThroughHandoff says the same.
 *
 * ASKED FOR, from a phone held on "Step 7 of 8" for ten minutes: "Why no
 * background processing why do I need to wait there". The first version held
 * the key the line comes back sealed to in the screen's memory, so closing
 * the screen left the node set up with a line nobody could open. Now the
 * key's private half is kept encrypted under the job, as a hypervisor
 * setup's is ([XoHandoff]), and the line is collected and kept in the vault
 * by whichever comes first: the screen seeing the job end, the app coming
 * back to the front, or a launch. The machine holds the sealed copy for six
 * hours (FINISHED_TTL_MS in xo-setup.js), after which the key goes too.
 *
 * A KEEP THE VAULT REFUSED IS TRIED AGAIN at the next of those, for as long
 * as the machine holds the copy: the line is the cluster's token, and a
 * network that blinked is no reason to lose it.
 */
internal object ProxmoxThroughHandoff {
    const val KEEP_FOR_MS = XoHandoff.KEEP_FOR_MS

    data class Pending(val job: String, val address: String, val at: Long)

    /** What collecting came to, for the screen to say. */
    sealed interface Outcome {
        /** Kept in the vault, under the cluster's address. */
        data class Kept(val address: String) : Outcome

        /** Not kept, and why; [again] when it is tried again later. */
        data class Failed(val text: String, val again: Boolean) : Outcome
    }

    /** One collect at a time, so the screen and the front of the app do not both keep one line. */
    private val collecting = Mutex()

    private fun replyName(job: String) = "pvesetup-reply.$job"

    /** A key for one job's line to come back to, kept until the line is in. */
    fun newKey(settings: Settings, job: String, address: String, now: Long = System.currentTimeMillis()): Seal.OneUseKey {
        val key = Seal.newKey()
        val kept = JSONObject()
            .put("d", Base64.getEncoder().encodeToString(key.privateKey.encoded))
            .put("pub", key.publicKey)
        settings.putSecret(replyName(job), kept.toString())
        save(settings, pending(settings).filter { it.job != job } + Pending(job, address, now))
        return key
    }

    /** The job ended without a line, or the line is kept: the key goes. */
    fun forget(settings: Settings, job: String) {
        settings.putSecret(replyName(job), "")
        save(settings, pending(settings).filter { it.job != job })
    }

    /**
     * Open the line a finished job handed back and keep it in the vault. Null
     * when there is nothing to collect: not this phone's job, not done yet, or
     * kept already.
     */
    suspend fun collect(settings: Settings, fleet: Fleet, job: String, setup: Fleet.Setup): Outcome? = collecting.withLock {
        if (setup.state != "done") return@withLock null
        val entry = pending(settings).firstOrNull { it.job == job } ?: return@withLock null
        val key = settings.secret(replyName(job))?.takeIf { it.isNotBlank() }?.let(::restore)
        val record = if (key == null) null else setup.handoff?.let { ProxmoxThrough.openLine(it, job, entry.address, key) }
        if (record == null) {
            forget(settings, job)
            return@withLock Outcome.Failed(
                "The node is set up, but what came back couldn’t be read. Run the setup again; it finds what it made.",
                again = false,
            )
        }
        PhoneVault(settings).keepHypervisor(fleet, record.address, record.json).fold(
            onSuccess = {
                // KEPT HERE TOO, for the console in the app (ProxmoxKept).
                ProxmoxKept.keep(settings, record)
                forget(settings, job)
                Outcome.Kept(record.address)
            },
            onFailure = {
                Outcome.Failed(
                    "The node is set up, but its access isn’t saved yet: ${it.message ?: "it couldn’t be saved."} " +
                        "This phone tries again when it is next open.",
                    again = true,
                )
            },
        )
    }

    /**
     * When the app comes back to the front, and at launch: every job this
     * phone is still owed a line for is asked about once. Done is collected,
     * over is dropped, still running is left for next time or the screen.
     */
    suspend fun collectPending(settings: Settings, fleet: Fleet, now: Long = System.currentTimeMillis()) {
        for (entry in pending(settings)) {
            if (now - entry.at > KEEP_FOR_MS) {
                forget(settings, entry.job)
                continue
            }
            val r = runCatching { fleet.xosetup("status", job = entry.job) }.getOrNull() ?: continue
            val setup = r.xosetup
            when {
                // The fleet no longer knows the job, so nothing will come.
                setup == null -> if (r.code == "unknown_job") forget(settings, entry.job)
                setup.state == "done" -> collect(settings, fleet, entry.job, setup)
                setup.state == "failed" || setup.state == "cancelled" -> forget(settings, entry.job)
            }
        }
    }

    fun pending(settings: Settings): List<Pending> = runCatching {
        val all = JSONArray(settings.pvePending.ifBlank { "[]" })
        (0 until all.length()).map { i ->
            val o = all.getJSONObject(i)
            Pending(o.getString("job"), o.getString("address"), o.getLong("at"))
        }
    }.getOrDefault(emptyList())

    private fun save(settings: Settings, all: List<Pending>) {
        settings.pvePending = if (all.isEmpty()) "" else JSONArray(all.map { JSONObject().put("job", it.job).put("address", it.address).put("at", it.at) }).toString()
    }

    private fun restore(kept: String): Seal.OneUseKey? = runCatching {
        val o = JSONObject(kept)
        val private = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(o.getString("d"))))
        Seal.OneUseKey(private, o.getString("pub"))
    }.getOrNull()
}
