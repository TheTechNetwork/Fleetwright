package dev.agentfleet.app

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Talking to the coordinator.
 *
 * Deliberately HttpURLConnection rather than a client library. The whole API is
 * four endpoints returning flat JSON — §7 designed it that way so a Shortcut
 * could call it — and a dependency here would be carried for the life of the
 * app to save about thirty lines.
 */
class Fleet(private val settings: Settings) {

    /** A session as the coordinator reports it, with its host attached. */
    data class Session(
        val name: String,
        val title: String?,
        val status: String,
        val hostId: String?,
        val rcUrl: String?,
        val resumable: Boolean,
    ) {
        /** What to show. The name is the identity; the title is for people. */
        val label: String get() = title?.takeIf { it.isNotBlank() } ?: name
    }

    data class Reply(val ok: Boolean, val text: String, val sessions: List<Session>)

    suspend fun list(): Reply = intent("list")

    suspend fun start(name: String?): Reply =
        intent("start", buildMap { if (!name.isNullOrBlank()) put("name", name) })

    suspend fun stop(name: String): Reply = intent("stop", mapOf("name" to name))

    suspend fun resume(name: String, choice: String? = null): Reply =
        intent("resume", buildMap {
            put("name", name)
            if (choice != null) put("choice", choice)
        })

    /**
     * Register this device for push.
     *
     * Called with whatever token the messaging SDK hands us. Kept separate from
     * the SDK on purpose: the server side of push is finished and testable, and
     * this is the single line that connects it once Firebase exists.
     */
    suspend fun registerDevice(token: String): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("platform", "android")
            .put("token", token)
        runCatching { post("/api/devices", body).optBoolean("ok", false) }.getOrDefault(false)
    }

    /**
     * Every action is one intent. The coordinator decides which host it lands
     * on — an app that picked the host would have to know which box holds which
     * session, which is exactly the thing the coordinator exists to know.
     */
    private suspend fun intent(verb: String, params: Map<String, String> = emptyMap()): Reply =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("verb", verb)
                .put("params", JSONObject(params.toMap()))
                .put("actor", "app:android")
                // An idempotency key the SERVER honours: a retry of `start`
                // returns the original outcome instead of a second session.
                .put("id", "app-" + java.util.UUID.randomUUID().toString())
            try {
                val json = post("/api/intent", body)
                Reply(
                    ok = json.optBoolean("ok", false),
                    text = json.optString("text", ""),
                    sessions = parseSessions(json.optJSONArray("sessions")),
                )
            } catch (e: Exception) {
                Reply(ok = false, text = e.message ?: "could not reach the coordinator", sessions = emptyList())
            }
        }

    private fun parseSessions(array: JSONArray?): List<Session> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            val o = array.optJSONObject(i) ?: return@mapNotNull null
            Session(
                name = o.optString("name"),
                title = o.optString("title").takeIf { it.isNotBlank() && it != "null" },
                status = o.optString("status", "unknown"),
                hostId = o.optString("hostId").takeIf { it.isNotBlank() },
                rcUrl = o.optString("rcUrl").takeIf { it.isNotBlank() && it != "null" },
                resumable = o.optBoolean("resumable", o.optString("uuid").isNotBlank()),
            )
        }
    }

    private fun post(path: String, body: JSONObject): JSONObject {
        val base = settings.coordinatorUrl.trimEnd('/')
        val connection = (URL("$base$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            // Long, because a `start` waits out the Remote Control check on the
            // host — up to about twenty seconds — and a short timeout here
            // reports a working fleet as unreachable.
            connectTimeout = 15_000
            readTimeout = 120_000
            setRequestProperty("content-type", "application/json")
            if (settings.apiToken.isNotBlank()) {
                setRequestProperty("authorization", "Bearer ${settings.apiToken}")
            }
        }
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        val status = connection.responseCode
        val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (status == 401) throw IllegalStateException("The coordinator rejected the token")
        return runCatching { JSONObject(text) }
            .getOrElse { throw IllegalStateException("Unexpected reply from the coordinator (HTTP $status)") }
    }
}

/**
 * Where the coordinator is and how to authenticate to it.
 *
 * §5 is explicit that a credential must never be baked into an app binary — it
 * is public the moment somebody pulls the APK — so this is entered once and
 * kept on the device.
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("agent-fleet", Context.MODE_PRIVATE)

    var coordinatorUrl: String
        get() = prefs.getString("coordinatorUrl", "") ?: ""
        set(value) = prefs.edit().putString("coordinatorUrl", value.trim()).apply()

    var apiToken: String
        get() = prefs.getString("apiToken", "") ?: ""
        set(value) = prefs.edit().putString("apiToken", value.trim()).apply()

    val configured: Boolean get() = coordinatorUrl.isNotBlank()
}
