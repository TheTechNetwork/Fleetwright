package network.thetech.fleetwright

import org.json.JSONObject

/**
 * Reconnecting a pool's servers in Xen Orchestra, from this phone: the half
 * that is arithmetic and words, kept apart from the screen so a JVM test can
 * run it, as XoPolicy is for changing what the fleet may use.
 *
 * WHY IT EXISTS. Asked for: "When Xen shows no pool, reconnecting all hosts
 * usually fixes it. Why don't we do it instead of me logging in?" The fleet
 * notices a pool its token no longer sees and pushes (`pool-lost`); one tap
 * on Reconnect opens the admin sign-in this phone kept behind a fingerprint
 * or face (XoSaved), seals it to one job, and a machine that reaches Xen
 * Orchestra reconnects its servers. `server.getAll`, `server.enable` and
 * `server.disable` are admin-only, and the boxes hold only the limited
 * `fleetwright` token, so the admin sign-in has to come from here.
 *
 * THE SAME JOB AS A POLICY CHANGE, WITH ANOTHER PURPOSE. Begun exactly as one
 * (a probe, a machine, its key checked before anything is sealed), and
 * different in three places, all here:
 *
 *   1. The sealed sign-in carries `purpose: "reconnect"` INSIDE the seal, in
 *      exactly the shape a policy sign-in does, with a key made on this phone
 *      for the outcome to come back to. In memory only, as a policy job's is.
 *      [sealSignIn].
 *   2. The machine refuses nothing it was not asked: it reconnects only the
 *      servers that are not connected, leaves a server somebody turned off
 *      off, and changes nothing else. A machine that can says so in `can`,
 *      and the screen seals nothing to one that does not.
 *   3. What each server came to, and the pools the admin sign-in sees at the
 *      end, come back sealed to that key under
 *      `fleetwright-xosetup-reconnect/v1:<job>:<address>`, because server
 *      labels and host addresses are not the coordinator's to read. The
 *      coordinator carries counts and the address only. [openResult].
 *
 * C-5 THROUGHOUT. A state this app does not know is said as that, never
 * drawn as connected or as gone, and a pool name the phone kept from setup
 * that the admin sign-in still does not see is named as still not shown.
 */
internal object XoReconnect {

    /** What the sealed sign-in names as its purpose, and what `can` must hold. Inside the seal, never a param. */
    const val PURPOSE = "reconnect"

    /**
     * A reconnect's steps, in XORECONNECT_STEPS order (src/fleet/protocol/
     * intents.js): onboarding's first two, then reading the servers,
     * reconnecting them one at a time, and waiting for the pools to show.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "connect" to "Reaching Xen Orchestra",
        "sign-in" to "Signing in",
        "servers" to "Reading Xen Orchestra’s servers",
        "reconnect" to "Reconnecting the servers",
        "wait" to "Waiting for the pools to show again",
    )

    fun stepWords(phase: String?, step: Int, of: Int): String {
        if (phase == "done") return "Done"
        STEPS.firstOrNull { it.first == phase }?.let { return it.second }
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        return "Step $n of ${maxOf(of, 1)}"
    }

    /**
     * The admin sign-in for a reconnect, sealed to the job's key under
     * setup's binding (XoSetup.aad), with [reply], the key the outcome comes
     * back to, and the purpose beside it: XoPolicy.sealSignIn's shape with
     * this purpose. Returned rather than kept: the caller clears the password
     * the moment this returns.
     */
    fun sealSignIn(key: String, job: String, address: String, email: String, password: String, reply: String): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("xo", JSONObject().put("email", email).put("password", password))
            .put("reply", reply)
            .put("purpose", PURPOSE)
        return joined(Seal.seal(key, XoSetup.aad(job, address), payload))
    }

    /** What the machine did to one server, in its words (`action` in the sealed result). */
    enum class Action(val raw: String) {
        LEFT("left"),
        ENABLED("enabled"),
        CYCLED("cycled"),
        SKIPPED_DISABLED("skipped-disabled"),
        FAILED("failed"),
    }

    /**
     * One of Xen Orchestra's servers, before and after. [before] and [after]
     * are null when the machine said something this app does not read, and
     * [action] is null for an action it does not know: cannot tell, never a
     * guess.
     */
    data class Server(
        val label: String,
        val host: String,
        val before: String?,
        val enabled: Boolean?,
        val after: String?,
        val action: Action?,
        val error: String?,
    )

    data class Pool(val id: String, val name: String)

    /** [pools] is null when the machine did not say: cannot tell, never "no pools". */
    data class Result(val servers: List<Server>, val pools: List<Pool>?)

    private val STATES = setOf("connected", "connecting", "disconnected")

    /**
     * The outcome as the machine sealed it, or null for anything that does
     * not open under this job and address with this key, or opens to
     * something that is not an outcome.
     */
    fun openResult(sealed: String, job: String, address: String, key: Seal.OneUseKey): Result? = runCatching {
        val parts = sealed.split(".")
        require(parts.size == 3)
        val box = JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2])
        parse(Seal.open(key, Seal.xosetupReconnectAad(job, address), box))
    }.getOrNull()

    /**
     * An outcome, read tolerantly: a server is kept whatever it says, with
     * what could not be read left null, and a pool without an id is dropped.
     * No `pools` at all is null, which is said as cannot tell.
     */
    fun parse(json: JSONObject): Result? {
        if (json.optInt("v", 0) != 1) return null
        val servers = json.optJSONArray("servers") ?: return null
        fun text(o: JSONObject, key: String): String? = o.takeIf { it.has(key) && !it.isNull(key) }?.optString(key)?.takeIf { it.isNotBlank() }
        val list = (0 until servers.length()).mapNotNull { i ->
            val s = servers.optJSONObject(i) ?: return@mapNotNull null
            Server(
                label = text(s, "label") ?: text(s, "host") ?: "A server with no name",
                host = text(s, "host").orEmpty(),
                before = text(s, "before")?.takeIf { it in STATES },
                enabled = if (s.has("enabled") && !s.isNull("enabled")) s.opt("enabled") as? Boolean else null,
                after = text(s, "after")?.takeIf { it in STATES },
                action = text(s, "action")?.let { raw -> Action.values().firstOrNull { it.raw == raw } },
                error = text(s, "error"),
            )
        }
        val pools = json.optJSONArray("pools")?.let { a ->
            (0 until a.length()).mapNotNull { i ->
                val p = a.optJSONObject(i) ?: return@mapNotNull null
                val id = text(p, "id") ?: return@mapNotNull null
                Pool(id, text(p, "name") ?: id)
            }
        }
        return Result(list, pools)
    }

    /** A server's state in words. Anything else is said as not known. */
    fun stateWords(state: String?): String = when (state) {
        "connected" -> "connected"
        "connecting" -> "still connecting"
        "disconnected" -> "disconnected"
        else -> "in a state this app does not know"
    }

    /** What happened to one server, in one plain sentence. */
    fun serverLine(s: Server): String = when (s.action) {
        Action.LEFT -> "Already connected, so it was left as it was."
        Action.ENABLED ->
            if (s.after == "connected") "Connected again."
            else "Turned back on. Xen Orchestra says it is ${stateWords(s.after)}."
        Action.CYCLED ->
            if (s.after == "connected") "Disconnected and connected again."
            else "Disconnected and turned back on. Xen Orchestra says it is ${stateWords(s.after)}."
        Action.SKIPPED_DISABLED -> "Turned off in Xen Orchestra, so it was left off. Only a person turns a server back on."
        Action.FAILED -> s.error?.let { "Not reconnected: $it" } ?: "Not reconnected. Xen Orchestra gave no reason."
        null -> "The machine said something about it this app does not know."
    }

    /** Whether a server's line is a failure, which is the one line set in the bad tone (the words carry it too). */
    fun failed(s: Server): Boolean = s.action == Action.FAILED

    /** How the servers stand now, counted: nothing named, as the plain text through the coordinator is. */
    fun summary(r: Result): String {
        val n = r.servers.size
        if (n == 0) return "Xen Orchestra lists no servers, so there was nothing to reconnect."
        if (r.servers.all { it.action == Action.LEFT }) return "Every server was already connected, so nothing was changed."
        val connected = r.servers.count { it.after == "connected" }
        return "$connected of $n ${if (n == 1) "server is" else "servers are"} connected now."
    }

    /** The line over the pools the admin sign-in sees at the end, or the sentence that says it sees none. */
    fun poolsLine(r: Result): String = when {
        r.pools == null -> "Cannot tell which pools Xen Orchestra shows now: the machine did not say."
        r.pools.isEmpty() -> "Xen Orchestra still shows no pools, even to the admin sign-in."
        else -> "Xen Orchestra shows ${if (r.pools.size == 1) "this pool" else "these pools"} now:"
    }

    /**
     * The pool names this phone kept from setup that the admin sign-in still
     * does not see, or null when it kept none, every one is back, or the
     * machine did not say which pools it sees. A name is what the phone has,
     * so it is what is compared.
     */
    fun stillMissing(held: List<String>?, r: Result): String? {
        val seen = r.pools?.map { it.name }?.toSet() ?: return null
        val missing = held.orEmpty().filter { it !in seen }
        return if (missing.isEmpty()) null else "Still not shown: ${missing.joinToString(", ")}."
    }

    /**
     * WHETHER THE POOL'S PAGE OFFERS IT (C-2, C-5). An admin's row, drawn
     * only once the page has read the pool, directly or through a machine,
     * and only when what it read shows no pool at all, or lacks a pool name
     * this phone kept from setup. A page that has not loaded has said
     * nothing either way, so it offers nothing.
     */
    fun offered(admin: Boolean?, loaded: Boolean, seen: List<String>, held: List<String>?): Boolean =
        admin == true && loaded && (seen.isEmpty() || held.orEmpty().any { it !in seen })

    /** The ongoing notification's title, by state: the same words the coordinator sends (RECONNECT_TITLES in core.js). */
    fun title(state: String): String = when (state) {
        "done" -> "Pools back"
        "failed" -> "The pools did not come back"
        "cancelled" -> "Reconnecting cancelled"
        else -> "Reconnecting Xen Orchestra’s servers"
    }

    private fun joined(sealed: JSONObject): String = "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
}
