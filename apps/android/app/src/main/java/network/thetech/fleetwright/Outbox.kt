package network.thetech.fleetwright

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Commands the phone is holding because the fleet was not reachable.
 *
 * The app used to send on tap and, when that failed, say so and lose the
 * command. That is the wrong answer on a phone: the ordinary case is a lift, a
 * tunnel, or a coordinator restarting, and "try again in a minute" asks
 * somebody to remember what they wanted and to be watching when it comes back.
 *
 * So a command that could not be DELIVERED is held on the device and sent when
 * the fleet answers again. Four rules make that safe, each load-bearing:
 *
 *  1. **The idempotency key is minted here, when the command is queued, and
 *     reused on every retry.** This is the whole reason holding a command is
 *     safe: the coordinator honours the key, so a `start` that was delivered
 *     but whose reply was lost returns the original outcome rather than
 *     starting a second session. An id minted at send time — which is what the
 *     app did before — would make a retry a second command.
 *  2. **Only a delivery failure is held.** A 401, a 403, a refusal from the
 *     fleet: those are ANSWERS. Holding an answer and replaying it later is how
 *     somebody's revoked credential retries all night.
 *  3. **Never a verb carrying a secret.** `link` and `renew` take a credential.
 *     Writing one to device storage to send later is exactly what this project
 *     refuses everywhere else, and a queue is a file — see [HOLDABLE].
 *  4. **It expires.** A command sent a day later is a surprise, and a surprise
 *     that starts a session on somebody's machine. Expired entries are shown as
 *     expired rather than dropped quietly: a queue that forgets is one that lies.
 */
class Outbox(context: Context) {

    data class Held(
        val id: String,
        val verb: String,
        val params: Map<String, String>,
        val host: String?,
        val queuedAt: Long,
        /** What the person asked for, in their words, for the pending list. */
        val summary: String,
        val attempts: Int = 0,
        val lastProblem: String? = null,
    ) {
        val isExpired: Boolean get() = System.currentTimeMillis() - queuedAt > EXPIRY_MS
    }

    companion object {
        /**
         * A held command older than this is not sent. Long enough to cover a
         * commute and a night's sleep, short enough that nobody is surprised.
         */
        const val EXPIRY_MS = 12L * 3600 * 1000

        /**
         * Verbs worth holding.
         *
         * READS ARE ABSENT ON PURPOSE. A `list` that failed is worth repeating
         * now, not in an hour — the answer would be stale before it arrived,
         * and the app refreshes anyway.
         *
         * `link`, `renew` and `connect` are absent for a stronger reason: they
         * carry or mint credentials, and a queue is a file on a phone.
         */
        val HOLDABLE = setOf(
            "start", "stop", "resume", "forget", "restore", "purge", "answer",
            "writefile", "copyfile", "deletefile",
        )

        /** What the person asked for, for the pending list. */
        fun describe(verb: String, params: Map<String, String>): String {
            val name = params["name"] ?: ""
            val path = params["path"] ?: "a file"
            return when (verb) {
                "start" -> if (name.isEmpty()) "Starting a session" else "Starting $name"
                "stop" -> "Stopping $name"
                "resume" -> "Resuming $name"
                "forget" -> "Forgetting $name"
                "restore" -> "Restoring $name"
                "purge" -> "Purging $name"
                "answer" -> "Answering $name"
                "writefile" -> "Writing $path in $name"
                "copyfile" -> "Copying $path in $name"
                "deletefile" -> "Deleting $path in $name"
                else -> verb
            }
        }
    }

    // filesDir, not SharedPreferences: a held `writefile` carries the file, and
    // preferences are the wrong shape for a payload measured in kilobytes.
    private val store = File(context.filesDir, "outbox.json")

    private var entries: MutableList<Held> = load().toMutableList()

    val held: List<Held> get() = entries.sortedBy { it.queuedAt }

    /** Hold a command. Returns null when this verb must not be held. */
    fun hold(verb: String, params: Map<String, String>, host: String?): Held? {
        if (verb !in HOLDABLE) return null
        val entry = Held(
            // MINTED NOW, NOT AT SEND. See rule 1 — the line that makes a retry
            // safe rather than a duplicate.
            id = "app-" + UUID.randomUUID().toString(),
            verb = verb,
            params = params,
            host = host,
            queuedAt = System.currentTimeMillis(),
            summary = describe(verb, params),
        )
        entries.add(entry)
        save()
        return entry
    }

    fun drop(id: String) {
        entries.removeAll { it.id == id }
        save()
    }

    fun dropExpired() {
        val before = entries.size
        entries.removeAll { it.isExpired }
        if (entries.size != before) save()
    }

    private fun mark(id: String, problem: String) {
        val i = entries.indexOfFirst { it.id == id }
        if (i < 0) return
        entries[i] = entries[i].copy(attempts = entries[i].attempts + 1, lastProblem = problem)
        save()
    }

    /**
     * Try everything held, oldest first, stopping at the first that still
     * cannot be delivered.
     *
     * STOPS RATHER THAN CONTINUES: a fleet unreachable for one command is
     * unreachable for all of them, and marching through the queue turns one
     * outage into N timeouts. Order is preserved because `stop` then `resume`
     * and `resume` then `stop` are different intentions.
     */
    suspend fun flush(send: suspend (Held) -> Result<Unit>): Int {
        dropExpired()
        var sent = 0
        for (entry in held) {
            val result = send(entry)
            if (result.isSuccess) {
                drop(entry.id)
                sent++
            } else {
                mark(entry.id, result.exceptionOrNull()?.message ?: "could not be sent")
                return sent
            }
        }
        return sent
    }

    // --- storage --------------------------------------------------------------

    private fun load(): List<Held> = runCatching {
        if (!store.exists()) return emptyList()
        val array = JSONArray(store.readText())
        (0 until array.length()).mapNotNull { i ->
            val o = array.optJSONObject(i) ?: return@mapNotNull null
            val params = mutableMapOf<String, String>()
            o.optJSONObject("params")?.let { p ->
                p.keys().forEach { k -> params[k] = p.optString(k) }
            }
            Held(
                id = o.optString("id"),
                verb = o.optString("verb"),
                params = params,
                host = o.optString("host").takeIf { it.isNotBlank() && it != "null" },
                queuedAt = o.optLong("queuedAt"),
                summary = o.optString("summary"),
                attempts = o.optInt("attempts"),
                lastProblem = o.optString("lastProblem").takeIf { it.isNotBlank() && it != "null" },
            )
        }.filter { it.id.isNotBlank() && it.verb in HOLDABLE }
    }.getOrElse { emptyList() }

    private fun save() {
        runCatching {
            val array = JSONArray()
            entries.forEach { e ->
                array.put(
                    JSONObject()
                        .put("id", e.id)
                        .put("verb", e.verb)
                        .put("params", JSONObject(e.params.toMap()))
                        .put("host", e.host)
                        .put("queuedAt", e.queuedAt)
                        .put("summary", e.summary)
                        .put("attempts", e.attempts)
                        .put("lastProblem", e.lastProblem),
                )
            }
            store.writeText(array.toString())
        }
    }
}

/**
 * Is this failure a failure to DELIVER, or an answer we did not like?
 *
 * Only the first may be held. A refusal replayed later is a refusal replayed all
 * night, and an expired credential retrying every time the app opens is how an
 * account gets locked.
 *
 * Matched on the exception TYPE rather than on its message: an IOException from
 * OkHttp or the JDK is "the bytes did not arrive". Anything this app threw
 * itself — a bad URL, cleartext refused, a message from the coordinator — is an
 * answer, and waiting does not change it.
 */
fun isDeliveryFailure(e: Throwable?): Boolean = when (e) {
    is java.net.UnknownHostException,
    is java.net.SocketTimeoutException,
    is java.net.ConnectException,
    is java.net.NoRouteToHostException,
    is javax.net.ssl.SSLException,
    -> true
    // The general case last: a plain IOException is a transport failure, but a
    // subclass this app defines is not.
    is java.io.IOException -> e.javaClass.name.startsWith("java.") || e.javaClass.name.startsWith("javax.")
    else -> false
}
