package network.thetech.fleetwright

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * An OAuth sign-in this phone runs itself, up to the code, for the minting
 * Worker to finish: the phone's own GitHub sign-in (PhoneGitHub) and a GitHub
 * or Cloudflare sign-in kept in the person's vault (PhoneVault).
 *
 * The phone makes the PKCE verifier and a state beginning `d.`, opens the
 * provider's own page in a Custom Tab, and waits for the coordinator's
 * callback to hand the code back at `fleetwright://<host>`. It checks the state
 * is the one it made, because a custom scheme is anybody's to send. The code
 * is no use without the verifier, which goes to the minter sealed and nowhere
 * else.
 */
internal object DeviceSignIn {

    data class Back(val code: String, val verifier: String, val redirectUri: String)

    /**
     * @param host which `fleetwright://` host the answer comes back on, `github` or `cloudflare`
     * @param extra query parameters the provider wants beside the PKCE ones, such as Cloudflare's scopes
     */
    suspend fun run(
        context: Context,
        authorize: String,
        clientId: String,
        redirectUri: String,
        statePrefix: String,
        host: String,
        extra: Map<String, String> = emptyMap(),
    ): Back {
        val verifier = randomToken(32)
        val state = statePrefix + randomToken(24)
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val query = (extra + mapOf(
            "client_id" to clientId,
            "redirect_uri" to redirectUri,
            "state" to state,
            "code_challenge" to challenge,
            "code_challenge_method" to "S256",
        )).entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }
        // Listening before the page opens: a callback that arrived before the
        // collector would be lost, and the flow does not replay.
        val back: Uri = coroutineScope {
            val waiting = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeoutOrNull(10 * 60_000L) {
                    WebAuth.returned.first { it.host == host && it.getQueryParameter("state") == state }
                }
            }
            withContext(Dispatchers.Main) { WebAuth.open(context, "$authorize?$query") }
            waiting.await()
        } ?: error("The sign-in did not come back within ten minutes. Try again.")
        val code = back.getQueryParameter("code").orEmpty().ifBlank { error("The sign-in came back without a code.") }
        return Back(code, verifier, redirectUri)
    }

    private fun randomToken(bytes: Int): String = b64(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    private fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
