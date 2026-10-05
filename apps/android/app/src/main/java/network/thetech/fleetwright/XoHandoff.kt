package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * Where a hypervisor's token goes once setup has made it: to this phone, and
 * nowhere in the fleet. The same design as XOSetupHandoff.swift.
 *
 * WHY HERE. The machine that ran the setup is only the one that could reach
 * Xen Orchestra when somebody wanted to add it. The first version left the
 * token in a file on that machine, which made it the one thing holding the
 * pool's key: retire or rebuild it and the pool could no longer be managed.
 * Now the phone makes a key for the token to come back to and sends it inside
 * the sealed sign-in, so the coordinator, which relays everything, cannot put
 * a key of its own there; the machine seals the token to it and keeps nothing
 * (src/fleet/host/xo-setup.js, hand-off). This is the phone-direct model
 * docs/manage.md sets out for managing the pool itself.
 *
 * THE KEY OUTLIVES THE SCREEN. A setup takes minutes, and the ongoing
 * notification is how the person watches it with the app closed. So the key's
 * private half is kept, encrypted under the Keystore key the fleet credential
 * uses, until the token has been collected, and every sign-in and launch
 * collects what is waiting. The machine holds the sealed copy for six hours,
 * after which the key goes too, because there is nothing left for it to open.
 */
internal object XoHandoff {
    /** How long a job's key is worth keeping: the machine forgets a finished job after six hours. */
    const val KEEP_FOR_MS = 6 * 60 * 60 * 1000L

    /** What collecting came to, for the screen to say. */
    sealed interface Outcome {
        object Kept : Outcome
        data class Failed(val why: String) : Outcome
    }

    /** A job whose token has not been collected yet. Nothing secret: the key is kept apart, encrypted. */
    data class Pending(val job: String, val address: String, val at: Long)

    /**
     * The binding the machine seals the token under: the same job and address
     * as the sign-in, under a name of its own, so a sealed sign-in and a
     * sealed token can never be taken for each other (xosetupHandoffAad in
     * src/fleet/seal.js).
     */
    fun aad(job: String, address: String): String = "fleetwright-xosetup-handoff/v1:$job:$address"

    private fun replyName(job: String) = "xosetup-reply.$job"
    fun tokenName(address: String) = "hypervisor.$address"

    /** A key for one job's token to come back to, kept until it has been used. */
    fun newKey(settings: Settings, job: String, address: String, now: Long = System.currentTimeMillis()): Seal.OneUseKey {
        val key = Seal.newKey()
        val kept = JSONObject()
            .put("d", Base64.getEncoder().encodeToString(key.privateKey.encoded))
            .put("pub", key.publicKey)
        settings.putSecret(replyName(job), kept.toString())
        save(settings, pending(settings).filter { it.job != job } + Pending(job, address, now))
        return key
    }

    /** The job ended without a token, or the token is in: the key goes. */
    fun forget(settings: Settings, job: String) {
        settings.putSecret(replyName(job), "")
        save(settings, pending(settings).filter { it.job != job })
    }

    /**
     * The record a machine sealed, as the JSON kept, or null for anything
     * that does not open under this job and address with this key, or opens
     * to something with no token for that address in it.
     */
    fun open(handoff: String, job: String, address: String, key: Seal.OneUseKey): String? = runCatching {
        val parts = handoff.split(".")
        require(parts.size == 3)
        val sealed = JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2])
        val record = Seal.open(key, aad(job, address), sealed)
        require(record.optString("token").isNotEmpty() && record.optString("address") == address)
        record.toString()
    }.getOrNull()

    /**
     * Open the token a finished job handed back and keep it. Null when there
     * is nothing to collect: not this phone's job, or not done yet.
     */
    fun collect(settings: Settings, job: String, setup: Fleet.Setup): Outcome? {
        if (setup.state != "done") return null
        val entry = pending(settings).firstOrNull { it.job == job } ?: return null
        val handoff = setup.handoff
        if (handoff == null) {
            // DONE AND NOTHING HANDED BACK is a machine older than the
            // hand-off, which kept the token where the first version did.
            forget(settings, job)
            return Outcome.Failed("The machine finished but handed no token back; it is older than this app and kept the token itself. Update it and run the setup again.")
        }
        val key = settings.secret(replyName(job))?.let { restore(it) }
        val record = key?.let { open(handoff, job, entry.address, it) }
        forget(settings, job)
        if (record == null) {
            return Outcome.Failed("The token the machine handed back did not open with this phone's key, so it was not kept. Run the setup again to make a new one.")
        }
        settings.putSecret(tokenName(entry.address), record)
        hold(settings, entry.address)
        return Outcome.Kept
    }

    /**
     * A pool this phone keeps a token for, as Machines lists it. [pools] is
     * the pool names the machine put in the record it sealed, NULL when the
     * record names none this phone can read: said as that, never as a pool
     * with no name.
     */
    data class Held(val address: String, val pools: List<String>?)

    /**
     * The pools this phone keeps a token for, in the order they were added.
     * An address whose token is no longer here (a Keystore key lost to a
     * restore makes every kept secret unreadable) is not listed: this phone
     * no longer holds it, whatever the list says.
     */
    fun held(settings: Settings): List<Held> =
        heldAddresses(settings).mapNotNull { address ->
            settings.secret(tokenName(address))?.let { Held(address, poolNames(it)) }
        }

    /**
     * The pool names in a kept token record (`pools: [{ id, name }]`, written
     * at hand-off), or null when it has none to read. A pool whose name is
     * blank is left out rather than shown as nothing.
     */
    fun poolNames(record: String): List<String>? = runCatching {
        val pools = JSONObject(record).optJSONArray("pools") ?: return@runCatching null
        (0 until pools.length()).mapNotNull { i -> pools.optJSONObject(i)?.optString("name")?.takeIf { it.isNotBlank() && it != "null" } }
    }.getOrNull()

    private fun heldAddresses(settings: Settings): List<String> = runCatching {
        val all = JSONArray(settings.xoHeld.ifBlank { "[]" })
        (0 until all.length()).map { all.getString(it) }
    }.getOrDefault(emptyList())

    /** Recorded once per address: a second setup of the same pool replaces its token, not its row. */
    private fun hold(settings: Settings, address: String) {
        val all = heldAddresses(settings)
        if (address !in all) settings.xoHeld = JSONArray(all + address).toString()
    }

    /**
     * On sign-in and launch: every job this phone is still owed a token for
     * is asked about once. Done is collected, over is dropped, still running
     * is left for next time or the screen.
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
                setup.state == "done" -> collect(settings, entry.job, setup)
                setup.state == "failed" || setup.state == "cancelled" -> forget(settings, entry.job)
            }
        }
    }

    fun pending(settings: Settings): List<Pending> = runCatching {
        val all = JSONArray(settings.xoPending.ifBlank { "[]" })
        (0 until all.length()).map { i ->
            val o = all.getJSONObject(i)
            Pending(o.getString("job"), o.getString("address"), o.getLong("at"))
        }
    }.getOrDefault(emptyList())

    private fun save(settings: Settings, all: List<Pending>) {
        settings.xoPending = if (all.isEmpty()) "" else JSONArray(all.map { JSONObject().put("job", it.job).put("address", it.address).put("at", it.at) }).toString()
    }

    private fun restore(kept: String): Seal.OneUseKey? = runCatching {
        val o = JSONObject(kept)
        val private = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(o.getString("d"))))
        Seal.OneUseKey(private, o.getString("pub"))
    }.getOrNull()
}
