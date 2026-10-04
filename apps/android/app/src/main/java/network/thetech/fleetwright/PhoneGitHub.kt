package network.thetech.fleetwright

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
 * Renewal, every eight hours, is the same with the refresh token, one at a
 * time ([accessToken]).
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
     * The key everything this phone sends the minter is sealed to: the one
     * the minter gives for itself at the fleet's address ([Fleet.minterOwnKey]),
     * and a key saved by hand only when nothing answers there.
     *
     * THE MINTER'S ANSWER FIRST, because a saved key goes stale and nobody
     * notices: when the minter's key is rotated, a phone that preferred what
     * it saved would seal every sign-in to the old key and fail, with nothing
     * on the screen saying why. A key is saved only on a fleet whose minter
     * does not answer, which is the case it is for.
     */
    suspend fun minterKey(fleet: Fleet): String =
        fleet.minterOwnKey()
            ?: settings.minterPin.ifBlank { null }
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

    /**
     * A token that is good now, renewed through the minter when it is close to expiring.
     *
     * ONE RENEWAL AT A TIME, FOR THE WHOLE APP. GitHub's refresh tokens work
     * once: each renewal hands back the next. Sessions, New session and the
     * vault each ask for a token as they appear, so two renewals used to go
     * out with the same refresh token, one won, and the other came back as
     * "The refresh token passed is incorrect or expired". Every caller now
     * waits on [renewal] and then uses what the renewal ahead of it kept.
     *
     * NOT CANCELLED WITH THE SCREEN. By the time the minter answers, GitHub
     * has already spent the old refresh token; a renewal cancelled with a
     * LaunchedEffect would drop the only copy of the new one, and this phone
     * could never renew again.
     */
    suspend fun accessToken(fleet: Fleet): String {
        val held = signIn ?: error("Sign in to GitHub on this phone first.")
        if (fresh(held)) return held.accessToken
        renewal.withLock { withContext(NonCancellable) { renew(fleet) } }
        return signIn?.accessToken ?: error("Sign in to GitHub on this phone first.")
    }

    /** Good for five more minutes, or never expires. */
    private fun fresh(held: SignIn): Boolean {
        val expires = held.expiresAt ?: return true
        return expires - System.currentTimeMillis() > 5 * 60_000L
    }

    private suspend fun renew(fleet: Fleet) {
        // Asked again inside: the renewal this caller waited behind may
        // already have done it.
        val held = signIn ?: error("Sign in to GitHub on this phone first.")
        if (fresh(held)) return
        val refresh = held.refreshToken ?: run {
            signOut()
            error("This phone's GitHub sign-in has run out. Sign in to GitHub again.")
        }
        finish(fleet, minterKey(fleet), JSONObject().put("grant", "refresh").put("refreshToken", refresh))
    }

    /** Seal a request to the minter, relay it, open the answer, keep it. */
    private suspend fun finish(fleet: Fleet, pin: String, request: JSONObject): String {
        val reply = Seal.newKey()
        request.put("v", 1).put("reply", reply.publicKey).put("at", System.currentTimeMillis())
        val sealed = Seal.seal(pin, Seal.GITHUB_REQUEST_AAD, request)
        val r = fleet.githubDeviceToken(sealed)
        if (r.optBoolean("ok") != true) {
            // A SPENT REFRESH TOKEN IS NOT A SIGN-IN. Kept, it would fail the
            // same way on every screen that needs a token; dropped, those
            // screens offer "Sign in to GitHub" instead.
            if (r.optJSONObject("error")?.optString("code") == "sign_in_again") signOut()
            error(r.optString("text").ifBlank { "The fleet refused the GitHub sign-in." })
        }
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

    /**
     * Finish a token one of your machines is making, and keep it: send the code
     * with a key made for this one answer, open what comes back, and deposit it
     * exactly as a pasted token is deposited. The token exists in the clear only
     * in this function's memory, between the two seals.
     */
    suspend fun keepTokenFromMachine(fleet: Fleet, host: String, code: String): Result<String> = runCatching {
        val key = Seal.newKey()
        val reply = fleet.setupToken(host, code = code, reply = key.publicKey)
        val sealed = reply.sealed
        if (!reply.ok || sealed == null) error(reply.text.ifBlank { "$host did not make a token." })
        val token = Seal.open(key, Seal.SETUP_TOKEN_AAD, sealed).optString("token")
        if (token.isBlank()) error("The answer did not open with this phone's key, so it was not used.")
        depositClaudeLogin(fleet, token).getOrThrow()
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

    private companion object {
        /** Shared by every PhoneGitHub, since a screen builds its own. */
        val renewal = Mutex()
    }
}
