package network.thetech.fleetwright

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The person's vault, from this phone: what they keep in the fleet's minting
 * Worker once, and which of their boxes may hold it. See docs/vault.md, and
 * src/fleet/minter/vault.js for the other end.
 *
 * EVERY REQUEST IS SEALED to the minter's key (PhoneGitHub.minterKey), with this
 * phone's GitHub token inside so the minter can ask GitHub whose vault it is,
 * and the fleet account it is for. The answer comes back sealed to a key this
 * phone made for that one request. The coordinator relays both and reads
 * neither.
 *
 * APPROVING A BOX names the box's own public key, as the fleet listed it. This
 * phone works out the fingerprint from that key itself ([fingerprint]) for the
 * person to compare with `fleetwright-sidecar identity` on the box, because a
 * coordinator that wanted a person's credentials would offer its own key here.
 */
internal class PhoneVault(private val settings: Settings) {

    data class Item(val name: String, val at: Long)

    data class Grant(val key: String, val fingerprint: String, val label: String, val email: String)

    data class Contents(val items: List<Item>, val grants: List<Grant>)

    /** Seal one request, relay it, open the answer. */
    private suspend fun ask(fleet: Fleet, op: String, extra: JSONObject = JSONObject()): Pair<String, JSONObject> {
        val pin = PhoneGitHub(settings).minterKey(fleet)
        val email = settings.signedInAs.trim().ifBlank { error("This phone does not know which fleet account it is signed in as. Sign in to the fleet again.") }
        val github = PhoneGitHub(settings).accessToken(fleet)
        val reply = Seal.newKey()
        val payload = JSONObject(extra.toString())
            .put("v", 1)
            .put("github", github)
            .put("email", email)
            .put("op", op)
            .put("at", System.currentTimeMillis())
            .put("reply", reply.publicKey)
        val r = fleet.vault(Seal.seal(pin, Seal.VAULT_REQUEST_AAD, payload))
        if (r.optBoolean("ok") != true) error(r.optString("text").ifBlank { "The vault refused that." })
        val answer = Seal.open(reply, Seal.VAULT_REPLY_AAD, r.getJSONObject("sealed"))
        return r.optString("text") to answer
    }

    suspend fun list(fleet: Fleet): Contents {
        val (_, answer) = ask(fleet, "list")
        val items = answer.optJSONArray("items")
        val grants = answer.optJSONArray("grants")
        return Contents(
            items = (0 until (items?.length() ?: 0)).mapNotNull { i ->
                items?.optJSONObject(i)?.let { Item(it.optString("name"), it.optLong("at")) }
            },
            grants = (0 until (grants?.length() ?: 0)).mapNotNull { i ->
                grants?.optJSONObject(i)?.let {
                    Grant(it.optString("key"), it.optString("fingerprint"), it.optString("label"), it.optString("email"))
                }
            },
        )
    }

    suspend fun keepSecret(fleet: Fleet, name: String, value: String): Result<String> = runCatching {
        val n = name.trim()
        require(SECRET_NAME.matches(n)) { "A secret's name is up to 64 letters, digits, dots, dashes and underscores." }
        require(value.isNotEmpty()) { "The secret is empty." }
        ask(fleet, "put", JSONObject().put("name", "secret:$n").put("value", value)).first
    }

    suspend fun forget(fleet: Fleet, name: String): Result<String> = runCatching {
        ask(fleet, "forget", JSONObject().put("name", name)).first
    }

    /** Sign in to GitHub or Cloudflare for the vault: this phone runs the page, the minter keeps the result. */
    suspend fun connect(context: Context, fleet: Fleet, provider: String): Result<String> = runCatching {
        val start = if (provider == "github") fleet.githubDeviceStart() else fleet.cloudflareDeviceStart()
        if (start.optBoolean("ok") != true) error(start.optString("text").ifBlank { "The fleet cannot start that sign-in." })
        val back = if (provider == "github") {
            DeviceSignIn.run(
                context,
                authorize = "https://github.com/login/oauth/authorize",
                clientId = start.getString("clientId"),
                redirectUri = start.getString("redirectUri"),
                statePrefix = start.optString("statePrefix", "d."),
                host = "github",
            )
        } else {
            DeviceSignIn.run(
                context,
                authorize = start.getString("authorizeUrl"),
                clientId = start.getString("clientId"),
                redirectUri = start.getString("redirectUri"),
                statePrefix = start.optString("statePrefix", "d."),
                host = "cloudflare",
                extra = mapOf("response_type" to "code", "scope" to start.optString("scopes")),
            )
        }
        ask(
            fleet,
            "connect",
            JSONObject().put("provider", provider).put("code", back.code).put("verifier", back.verifier).put("redirectUri", back.redirectUri),
        ).first
    }

    suspend fun approve(fleet: Fleet, host: Fleet.Host): Result<String> = runCatching {
        val key = host.publicJwk ?: error("The fleet did not list ${host.hostId}'s key, so it cannot be approved from here. Update the fleet.")
        ask(fleet, "grant", JSONObject().put("hostKey", key).put("label", host.hostId)).first
    }

    suspend fun remove(fleet: Fleet, grant: Grant): Result<String> = runCatching {
        ask(fleet, "revoke", JSONObject().put("key", grant.key)).first
    }

    companion object {
        val SECRET_NAME = Regex("^[A-Za-z0-9_.-]{1,64}$")

        /**
         * A box key's fingerprint, worked out here from the key: sixteen hex
         * characters of SHA-256 over `{"crv","kty","x","y"}` in that order,
         * exactly as src/fleet/crypto.js `fingerprint` makes it and
         * `fleetwright-sidecar identity` prints it.
         */
        fun fingerprint(jwk: JSONObject): String {
            val canonical = "{\"crv\":${JSONObject.quote(jwk.optString("crv"))},\"kty\":${JSONObject.quote(jwk.optString("kty"))}," +
                "\"x\":${JSONObject.quote(jwk.optString("x"))},\"y\":${JSONObject.quote(jwk.optString("y"))}}"
            val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
            return digest.take(8).joinToString("") { "%02x".format(it) }
        }

        /** How a vault item is named to a person. */
        fun label(name: String): String = when {
            name == "claude" -> "Claude"
            name == "github" -> "GitHub"
            name == "cloudflare" -> "Cloudflare"
            name.startsWith("secret:") -> name.removePrefix("secret:")
            else -> name
        }
    }
}
