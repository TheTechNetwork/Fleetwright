package network.thetech.fleetwright

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

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

    /**
     * Start a session.
     *
     * Everything past `name` is optional and stays optional: a spoken start
     * cannot open a text field, so there has to be a good outcome when none of
     * it is supplied.
     *
     * `title` and `brief` are prose and travel as intent PARAMETERS. On the far
     * side the sidecar keeps them out of the command line for the same reason a
     * title reading "refactor auth --dangerous" must never arrive as a flag.
     *
     * No `host`: the coordinator's dispatch() has no placement preference to
     * hand one to, so it would be accepted, ignored, and look like it worked.
     */
    suspend fun start(
        name: String? = null,
        title: String? = null,
        brief: String? = null,
        mode: String? = null,
        host: String? = null,
    ): Reply = intent(
        "start",
        buildMap {
            if (!name.isNullOrBlank()) put("name", name)
            if (!title.isNullOrBlank()) put("title", title)
            if (!brief.isNullOrBlank()) put("brief", brief)
            if (!mode.isNullOrBlank()) put("mode", mode)
        },
        // A placement PREFERENCE, beside the intent and never inside it —
        // `start` declares no host parameter, and a host receiving one would
        // refuse the whole intent. The coordinator refuses a bad pick by name.
        host = host,
    )

    suspend fun stop(name: String): Reply = intent("stop", mapOf("name" to name))

    /**
     * The last lines of a session's pane — what it is actually doing.
     *
     * The verb that makes this more than a list of names. Everything else says
     * a session exists; this says whether it is stuck.
     */
    suspend fun peek(name: String): Reply = intent("peek", mapOf("name" to name))

    /** Forget a session and delete its volumes. Not undoable — the UI asks first. */
    suspend fun forget(name: String): Reply = intent("forget", mapOf("name" to name))

    /**
     * Ask the coordinator to send this device a notification now.
     *
     * Push fails silently by nature: a registration that never arrived and a
     * provider that was never configured look identical from a phone, which is
     * to say they look like nothing at all. This is the only way to find out
     * before the notification that matters.
     */
    suspend fun testPush(token: String?): Reply = withContext(Dispatchers.IO) {
        val body = JSONObject().apply { if (token != null) put("token", token) }
        runCatching {
            val json = post("/api/devices/test", body)
            Reply(ok = json.optBoolean("ok", false), text = json.optString("text"), sessions = emptyList())
        }.getOrElse { Reply(ok = false, text = it.message ?: "could not reach the coordinator", sessions = emptyList()) }
    }

    suspend fun resume(name: String, choice: String? = null): Reply =
        intent("resume", buildMap {
            put("name", name)
            if (choice != null) put("choice", choice)
        })

    /**
     * Spend an ID token for a credential of this device's own.
     *
     * The reply is the ONLY time the credential exists in full — the
     * coordinator keeps a hash of it. Losing it means signing in again, which
     * is the correct cost: a coordinator that could hand back an existing
     * credential is a coordinator that could be made to.
     */
    suspend fun signIn(idToken: String, deviceName: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("idToken", idToken).put("deviceName", deviceName)
        val json = post("/api/session", body, authenticated = false)
        if (!json.optBoolean("ok", false)) {
            throw IllegalStateException(json.optString("text").ifBlank { "The coordinator refused the sign-in." })
        }
        val token = json.optString("token")
        if (token.isBlank()) throw IllegalStateException("The coordinator issued no credential.")
        // The name it chose looks like "Pixel 9 (someone@example.com)". The
        // address inside it is what the app shows, so a phone signed into the
        // wrong account is visible rather than merely wrong.
        val label = json.optJSONObject("client")?.optString("name") ?: ""
        token to (Regex("\\(([^)]*@[^)]*)\\)").find(label)?.groupValues?.get(1) ?: "")
    }

    /** The machines in this fleet, with their key fingerprints. */
    suspend fun enrolledHosts(): List<Host> = withContext(Dispatchers.IO) {
        runCatching {
            val json = get("/api/hosts/enrolled")
            val array = json.optJSONArray("hosts") ?: return@runCatching emptyList<Host>()
            (0 until array.length()).mapNotNull { i ->
                val o = array.optJSONObject(i) ?: return@mapNotNull null
                Host(
                    hostId = o.optString("hostId"),
                    fingerprint = o.optString("fingerprint"),
                    revoked = o.optLong("revokedAt", 0L) > 0L,
                )
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Mint a six-digit pin for a machine to join with.
     *
     * This is how a host gets in now: no shared token to copy onto every box,
     * one pin, ten minutes, single use.
     */
    suspend fun mintHostPin(): String = withContext(Dispatchers.IO) {
        val json = post("/api/enroll", JSONObject().put("kind", "host"))
        json.optString("code").ifBlank {
            throw IllegalStateException(json.optString("text").ifBlank { "Could not mint a pin." })
        }
    }

    /** Remove a machine from the fleet. It is disconnected as well as revoked. */
    suspend fun revokeHost(hostId: String): Reply = withContext(Dispatchers.IO) {
        runCatching {
            val json = send("DELETE", "/api/hosts/" + hostId, null)
            Reply(json.optBoolean("ok", false), json.optString("text"), emptyList())
        }.getOrElse { Reply(false, it.message ?: "could not reach the coordinator", emptyList()) }
    }

    data class Host(val hostId: String, val fingerprint: String, val revoked: Boolean)

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
    private suspend fun intent(verb: String, params: Map<String, String> = emptyMap(), host: String? = null): Reply =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("verb", verb)
                .put("params", JSONObject(params.toMap()))
                .put("actor", "app:android")
                // An idempotency key the SERVER honours: a retry of `start`
                // returns the original outcome instead of a second session.
                .put("id", "app-" + java.util.UUID.randomUUID().toString())
            if (!host.isNullOrBlank()) body.put("host", host)
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

    private fun post(path: String, body: JSONObject, authenticated: Boolean = true): JSONObject =
        send("POST", path, body, authenticated)

    private fun get(path: String): JSONObject = send("GET", path, null)

    private fun send(
        method: String,
        path: String,
        body: JSONObject?,
        authenticated: Boolean = true,
    ): JSONObject {
        val base = settings.coordinatorUrl.trimEnd('/')
        val connection = (URL("$base$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            doOutput = body != null
            // Long, because a `start` waits out the Remote Control check on the
            // host — up to about twenty seconds — and a short timeout here
            // reports a working fleet as unreachable.
            connectTimeout = 15_000
            readTimeout = 120_000
            setRequestProperty("content-type", "application/json")
            if (authenticated && settings.credential.isNotBlank()) {
                setRequestProperty("authorization", "Bearer ${settings.credential}")
            }
        }
        if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray()) }
        val status = connection.responseCode
        val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        if (status == 401) {
            // A credential is revoked by somebody deliberately removing this
            // device. Clearing it here is what turns "every request fails" into
            // "sign in again", which is the actual remedy.
            if (authenticated && settings.credential.isNotBlank()) {
                settings.credential = ""
                settings.signedInAs = ""
                throw IllegalStateException("This device is no longer allowed in. Sign in again.")
            }
            throw IllegalStateException(
                runCatching { JSONObject(text).optString("text") }.getOrNull()?.ifBlank { null }
                    ?: "The coordinator refused that.",
            )
        }
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

    /** Not sensitive: an origin, and the app talks to no other. */
    var coordinatorUrl: String
        get() = prefs.getString("coordinatorUrl", "") ?: ""
        set(value) = prefs.edit().putString("coordinatorUrl", value.trim()).apply()

    /**
     * This device's own credential, encrypted with a key held in the Android
     * Keystore that never leaves it.
     *
     * The same reasoning as the iOS keychain: this credential can start and
     * stop sessions on every machine in the fleet. MODE_PRIVATE keeps other
     * apps out on a healthy device, but the file is plain text on disk —
     * readable with root, in some backup configurations, and by anything that
     * gets at the data directory. The ciphertext is still kept in
     * SharedPreferences; only the key is special, and it is not extractable.
     *
     * NOTHING IS CARRIED OVER from the build that asked for an admin token.
     * That token was the fleet's break-glass credential and every phone had the
     * same one; silently promoting it to this device's credential would
     * preserve exactly what this replaces. It is deleted, and the app asks the
     * person to sign in.
     */
    var credential: String
        get() = prefs.getString("credential.enc", null)?.let { decrypt(it) } ?: ""
        set(value) {
            val trimmed = value.trim()
            prefs.edit().apply {
                if (trimmed.isEmpty()) remove("credential.enc") else putString("credential.enc", encrypt(trimmed))
                // Swept on every write, so an upgrade removes the old one the
                // first time anybody signs in.
                remove("apiToken")
                remove("apiToken.enc")
            }.apply()
        }

    /** Who this device is signed in as. Not a secret — it is displayed. */
    var signedInAs: String
        get() = prefs.getString("signedInAs", "") ?: ""
        set(value) = prefs.edit().putString("signedInAs", value).apply()

    /**
     * Reachable AND allowed in. Both matter: a URL with no credential gets a
     * 401 on every call, which reads as a broken fleet rather than as a phone
     * that has not signed in.
     */
    val configured: Boolean get() = coordinatorUrl.isNotBlank() && credential.isNotBlank()
    val hasCoordinator: Boolean get() = coordinatorUrl.isNotBlank()

    // --- AES-GCM with a non-extractable Keystore key -------------------------
    //
    // No dependency, in keeping with the rest of this app. androidx.security's
    // EncryptedSharedPreferences would do the same job, but it has sat in alpha
    // for years and is a large surface for one string.

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Deliberately NOT setUserAuthenticationRequired: a push
                // notification has to be actionable on a locked phone, which is
                // the entire point of the app.
                .build(),
        )
        return generator.generateKey()
    }

    /** iv:ciphertext, both base64. The IV is not a secret and must not repeat. */
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.doFinal(value.toByteArray())
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? = runCatching {
        val (iv, body) = stored.split(":", limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
        )
        String(cipher.doFinal(Base64.decode(body, Base64.NO_WRAP)))
    }.getOrNull() // A key lost to a backup restore or a reinstall means re-entering the token, not a crash.

    private companion object {
        const val KEY_ALIAS = "fleetwright.credential"
    }
}
