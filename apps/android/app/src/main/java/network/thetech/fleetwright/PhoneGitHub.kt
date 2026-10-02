package network.thetech.fleetwright

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * This phone's own GitHub sign-in, and the two things it is for: starting a
 * runner with no permanent box in the fleet, and keeping your Claude login for
 * your runners.
 *
 * WHY THE PHONE SIGNS IN AT ALL. A runner is started by a GitHub workflow
 * dispatch, and whoever makes the dispatch is who GitHub says started it,
 * which decides whose repository tokens and whose Claude login the runner is
 * given. That used to be a permanent box, with your GitHub connection. Now it
 * can be this phone, with its own.
 *
 * HOW, WITHOUT ANYTHING IN THE MIDDLE SEEING THE TOKEN:
 *  1. The phone makes a PKCE verifier and a state, and opens GitHub's own page
 *     in a Custom Tab with the App's public client id (DeviceSignIn).
 *  2. GitHub sends the browser to the coordinator's callback, which hands the
 *     code back to this app. The code is no use without the verifier.
 *  3. The phone seals the code and the verifier to the minting Worker's key
 *     (the PIN you saved), and a key of its own for the answer. The minter,
 *     which holds the App's client secret, makes the exchange with GitHub and
 *     seals the token back. The coordinator relays two ciphertexts.
 * Renewal, every eight hours, is the same with the refresh token.
 *
 * The token lives in [Settings.githubSignIn], encrypted under the same
 * Keystore key as this device's fleet credential.
 */
internal class PhoneGitHub(private val settings: Settings) {

    /** What is stored, decoded. Null when this phone has not signed in. */
    data class SignIn(
        val accessToken: String,
        val expiresAt: Long?,
        val refreshToken: String?,
        val refreshExpiresAt: Long?,
        val login: String,
    )

    val signIn: SignIn?
        get() = settings.githubSignIn.takeIf { it.isNotBlank() }?.let { raw ->
            runCatching {
                val j = JSONObject(raw)
                SignIn(
                    accessToken = j.getString("accessToken"),
                    expiresAt = j.optLong("expiresAt").takeIf { j.has("expiresAt") && !j.isNull("expiresAt") },
                    refreshToken = j.optString("refreshToken").ifBlank { null },
                    refreshExpiresAt = j.optLong("refreshExpiresAt").takeIf { j.has("refreshExpiresAt") && !j.isNull("refreshExpiresAt") },
                    login = j.optString("login"),
                )
            }.getOrNull()
        }

    val signedIn: Boolean get() = signIn != null

    fun signOut() {
        settings.githubSignIn = ""
    }

    /**
     * Is [pin] the key the fleet's minter really has? The fleet says what its
     * key is, and that is only worth comparing with: a pin is what whoever
     * runs the fleet told you, by some route that is not the fleet. A
     * coordinator offering a different key is exactly how somebody would read
     * what this phone seals.
     */
    suspend fun checkPin(fleet: Fleet, pin: String): Result<String> = runCatching {
        val p = pin.trim()
        require(Seal.KEY_RE.matches(p)) { "That is not a minter key. It is 87 letters, digits, - and _." }
        val said = fleet.claudeLoginKey()
        val key = said.optString("key")
        if (said.optBoolean("ok") != true || key.isBlank()) error(said.optString("text").ifBlank { "The fleet did not say which key its minter has." })
        if (key != p) error("The fleet's minter has a different key from the one you were given, so nothing was saved. Ask whoever runs your fleet.")
        settings.minterPin = p
        "Saved. This phone seals only to that key."
    }

    /**
     * The key everything this phone sends the minter is sealed to: the pin,
     * when one was saved, and otherwise the key the minter gives for itself
     * at the fleet's address ([Fleet.minterOwnKey]).
     */
    suspend fun minterKey(fleet: Fleet): String =
        settings.minterPin.ifBlank { null }
            ?: fleet.minterOwnKey()
            ?: error("This fleet's minter does not answer for its own key. Paste the key whoever runs your fleet gave you.")

    /** Sign in to GitHub on this phone. Opens GitHub's page; returns once it comes back. */
    suspend fun signInWith(context: Context, fleet: Fleet): Result<String> = runCatching {
        val pin = minterKey(fleet)
        val start = fleet.githubDeviceStart()
        if (start.optBoolean("ok") != true) error(start.optString("text").ifBlank { "The fleet cannot start a GitHub sign-in." })
        val back = DeviceSignIn.run(
            context,
            authorize = "https://github.com/login/oauth/authorize",
            clientId = start.getString("clientId"),
            redirectUri = start.getString("redirectUri"),
            statePrefix = start.optString("statePrefix", "d."),
            host = "github",
        )
        val code = back.code
        val verifier = back.verifier
        val redirectUri = back.redirectUri
        finish(fleet, pin, JSONObject().put("grant", "code").put("code", code).put("verifier", verifier).put("redirectUri", redirectUri))
    }

    /** A token that is good now, renewed through the minter when it is close to expiring. */
    suspend fun accessToken(fleet: Fleet): String {
        val held = signIn ?: error("Sign in to GitHub on this phone first.")
        val expires = held.expiresAt ?: return held.accessToken
        if (expires - System.currentTimeMillis() > 5 * 60_000L) return held.accessToken
        val refresh = held.refreshToken ?: error("Your GitHub sign-in has expired. Sign in again.")
        val pin = minterKey(fleet)
        finish(fleet, pin, JSONObject().put("grant", "refresh").put("refreshToken", refresh))
        return signIn?.accessToken ?: error("Your GitHub sign-in could not be renewed. Sign in again.")
    }

    /** Seal a request to the minter, relay it, open the answer, keep it. */
    private suspend fun finish(fleet: Fleet, pin: String, request: JSONObject): String {
        val reply = Seal.newKey()
        request.put("v", 1).put("reply", reply.publicKey).put("at", System.currentTimeMillis())
        val sealed = Seal.seal(pin, Seal.GITHUB_REQUEST_AAD, request)
        val r = fleet.githubDeviceToken(sealed)
        if (r.optBoolean("ok") != true) error(r.optString("text").ifBlank { "The fleet refused the GitHub sign-in." })
        val token = Seal.open(reply, Seal.GITHUB_REPLY_AAD, r.getJSONObject("sealed"))
        settings.githubSignIn = JSONObject()
            .put("accessToken", token.getString("accessToken"))
            .put("expiresAt", token.opt("expiresAt") ?: JSONObject.NULL)
            .put("refreshToken", token.opt("refreshToken") ?: JSONObject.NULL)
            .put("refreshExpiresAt", token.opt("refreshExpiresAt") ?: JSONObject.NULL)
            .put("login", token.optString("login"))
            .toString()
        val login = token.optString("login")
        return if (login.isBlank()) "Signed in to GitHub." else "Signed in to GitHub as $login."
    }

    /**
     * Start a runner from this phone: the coordinator mints the ticket and
     * says where, and this phone asks GitHub with its own sign-in. No box.
     */
    suspend fun startRunner(fleet: Fleet, platform: String, minutes: Int?, start: Map<String, String>?): Fleet.Reply {
        val plan = fleet.prepareRunnerDispatch(platform, minutes, start)
        if (plan.optBoolean("ok") != true) return Fleet.Reply(false, plan.optString("text").ifBlank { "The fleet would not start a machine." }, emptyList())
        val repo = plan.getString("repo")
        val workflow = plan.getString("workflow")
        val token = accessToken(fleet)
        return withContext(Dispatchers.IO) {
            val about = github("GET", "https://api.github.com/repos/$repo", token, null)
            if (about.first !in 200..299) return@withContext Fleet.Reply(false, refusal(about.first, "the repository $repo"), emptyList())
            val ref = runCatching { JSONObject(about.second).optString("default_branch") }.getOrNull().orEmpty().ifBlank { "main" }
            val body = JSONObject().put("ref", ref).put("inputs", plan.getJSONObject("inputs"))
            val sent = github("POST", "https://api.github.com/repos/$repo/actions/workflows/$workflow/dispatches", token, body)
            when (sent.first) {
                204 -> Fleet.Reply(
                    true,
                    "Asked GitHub for a $platform machine from $repo, as you. It takes a few minutes to boot and then " +
                        "appears in the fleet as a host of yours.",
                    emptyList(),
                )
                422 -> Fleet.Reply(
                    false,
                    "GitHub refused the dispatch (422). $repo has $workflow, but it does not take the inputs this fleet " +
                        "sends. Update it from github.com/TheTechNetwork/Fleetwright-Runners-Template.",
                    emptyList(),
                )
                else -> Fleet.Reply(false, refusal(sent.first, "$workflow in $repo"), emptyList())
            }
        }
    }

    /**
     * Keep your Claude login with the minter for your runners, or forget it
     * ([claudeToken] null). Sealed to the minter's key with this phone's GitHub token
     * inside, which is how the minter learns whose it is without asking the
     * coordinator.
     */
    suspend fun depositClaudeLogin(fleet: Fleet, claudeToken: String?): Result<String> = runCatching {
        val pin = minterKey(fleet)
        val github = accessToken(fleet)
        val payload = JSONObject().put("v", 1).put("github", github)
            .put("claude", claudeToken?.trim()?.ifBlank { null } ?: JSONObject.NULL)
            .put("at", System.currentTimeMillis())
        val r = fleet.depositClaudeLogin(Seal.seal(pin, Seal.DEPOSIT_AAD, payload))
        if (r.optBoolean("ok") != true) error(r.optString("text").ifBlank { "The minter refused it." })
        r.optString("text")
    }

    private fun github(method: String, url: String, token: String, body: JSONObject?): Pair<Int, String> {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("authorization", "Bearer $token")
            setRequestProperty("accept", "application/vnd.github+json")
            setRequestProperty("x-github-api-version", "2022-11-28")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json")
            }
        }
        if (body != null) c.outputStream.use { it.write(body.toString().toByteArray()) }
        val status = c.responseCode
        val text = (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return status to text
    }

    private fun refusal(status: Int, what: String): String = when (status) {
        401 -> "GitHub rejected this phone's sign-in (401). Sign in to GitHub again."
        403 -> "GitHub refused $what (403). Your account needs write access there."
        404 -> "GitHub cannot see $what from your account (404)."
        else -> "GitHub refused $what ($status)."
    }
}
