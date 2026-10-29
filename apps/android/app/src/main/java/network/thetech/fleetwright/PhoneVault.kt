package network.thetech.fleetwright

import android.content.Context
import org.json.JSONArray
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

    /**
     * `kind`, for Claude: `login`, the sign-in Remote Control needs, or `token`,
     * a setup-token that runs sessions only. Null for anything else, and from a
     * minter from before it said.
     */
    data class Item(val name: String, val at: Long, val kind: String? = null)

    /**
     * One box this person approved. [key] is the whole SHA-256 of the box's
     * key, as the minter names the grant ([keyHash]); [fingerprint] is its
     * first sixteen characters. [only] is the vault's `only`: the items a box
     * approved for some of the vault may hold, as [approveHolder] writes it
     * for a pool's own machine. Empty is the whole vault.
     */
    data class Grant(val key: String, val fingerprint: String, val label: String, val email: String, val only: List<String> = emptyList())

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
                items?.optJSONObject(i)?.let { Item(it.optString("name"), it.optLong("at"), it.optString("kind").ifBlank { null }) }
            },
            grants = (0 until (grants?.length() ?: 0)).mapNotNull { i ->
                grants?.optJSONObject(i)?.let {
                    val only = it.optJSONArray("only")
                    Grant(
                        it.optString("key"), it.optString("fingerprint"), it.optString("label"), it.optString("email"),
                        (0 until (only?.length() ?: 0)).map { i -> only!!.optString(i) },
                    )
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

    /**
     * Keep a hypervisor's token in the fleet: the record setup handed this
     * phone, under `hypervisor:<address>`. The minter checks the record names
     * that address; the boxes this person approved are handed it and hold it
     * in memory only (src/fleet/host/xo-pools.js), and make machines on the
     * pool with it.
     */
    suspend fun keepHypervisor(fleet: Fleet, address: String, record: String, box: String? = null): Result<String> = runCatching {
        val name = if (box == null) "hypervisor:$address" else "hypervisor:$address+$box"
        ask(fleet, "put", JSONObject().put("name", name).put("value", record)).first
    }

    suspend fun forget(fleet: Fleet, name: String): Result<String> = runCatching {
        ask(fleet, "forget", JSONObject().put("name", name)).first
    }

    /**
     * Whether a kept credential still works, asked by the minter of the
     * service it is for (vault.js, testItem). Anything short of accepted,
     * cannot tell included, comes back as a failure, so it is drawn as one.
     */
    suspend fun test(fleet: Fleet, name: String): Result<String> = runCatching {
        val (text, answer) = ask(fleet, "test", JSONObject().put("name", name))
        if (answer.optString("state") != "accepted") error(text)
        text
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

    /** A pool's own machine, approved for its pool's record and nothing else of this person's (the vault's `only`). */
    suspend fun approveHolder(fleet: Fleet, hostId: String, key: JSONObject, address: String): Result<String> = runCatching {
        val jwk = JSONObject().put("kty", key.optString("kty")).put("crv", key.optString("crv")).put("x", key.optString("x")).put("y", key.optString("y"))
        ask(fleet, "grant", JSONObject().put("hostKey", jwk).put("label", hostId).put("only", JSONArray().put("hypervisor:$address"))).first
    }

    suspend fun remove(fleet: Fleet, grant: Grant): Result<String> = runCatching {
        ask(fleet, "revoke", JSONObject().put("key", grant.key)).first
    }

    /**
     * List this phone's signing key under the account it is signed in as, so
     * the fleet's boxes are given it by the minter and can check what this
     * phone signs (DeviceSigning.kt, docs/signed-intents.md). The minter files
     * it under the GitHub account this request carries, and refuses it when
     * that address's keys are another account's.
     */
    suspend fun listDeviceKey(fleet: Fleet, key: DeviceKey): Result<String> = runCatching {
        val label = if (key.hardware) "Android phone (Keystore hardware)" else "Android phone (Keystore)"
        ask(fleet, "devicekey", JSONObject().put("key", key.jwk).put("label", label)).first
    }

    /**
     * Take back a delegation, at the minter: the coordinator carries
     * delegations, so telling it alone would leave a dishonest one carrying
     * this. Boxes refuse it from the next key list they take.
     */
    suspend fun revokeDelegation(fleet: Fleet, id: String, until: Long): Result<String> = runCatching {
        ask(fleet, "revokedelegation", JSONObject().put("id", id).put("until", until)).first
    }

    companion object {
        val SECRET_NAME = Regex("^[A-Za-z0-9_.-]{1,64}$")

        /**
         * A box key's fingerprint, worked out here from the key: sixteen hex
         * characters of SHA-256 over `{"crv","kty","x","y"}` in that order,
         * exactly as src/fleet/crypto.js `fingerprint` makes it and
         * `fleetwright-sidecar identity` prints it.
         */
        fun fingerprint(jwk: JSONObject): String = keyHash(jwk).take(16)

        /** The whole of that SHA-256, in hex: what the minter names a grant by (boxKeyHash in src/fleet/minter/vault.js), and [Grant.key]. */
        fun keyHash(jwk: JSONObject): String {
            val canonical = "{\"crv\":${JSONObject.quote(jwk.optString("crv"))},\"kty\":${JSONObject.quote(jwk.optString("kty"))}," +
                "\"x\":${JSONObject.quote(jwk.optString("x"))},\"y\":${JSONObject.quote(jwk.optString("y"))}}"
            val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }

        /**
         * Whether these grants approve [jwk] as [hostId]'s for an admin's
         * secret, which is the person's word that it is that machine's key
         * and skips the comparison.
         *
         * A GRANT SCOPED BY `only` IS NOT THAT WORD. It is the one this phone
         * writes when it lets a pool's own machine in to hold its pool's
         * record and nothing else ([approveHolder]), and nobody compared a key
         * for it the way the comparison asks. Counted, any grant at all with a
         * matching sixteen-character prefix handed the Xen Orchestra admin's
         * sign-in to a machine holding one pool's record, without anyone being
         * asked. So only a whole-vault grant counts, under the name that
         * answered, by the whole hash of the key; anything else asks.
         */
        fun approves(grants: List<Grant>, hostId: String, jwk: JSONObject): Boolean {
            val hash = keyHash(jwk)
            return grants.any { it.only.isEmpty() && it.label == hostId && it.key == hash }
        }

        /**
         * The kept credentials there is a service to ask about. A named secret
         * and a hypervisor's token have none, so they get no Test button.
         */
        fun isTestable(name: String): Boolean = name in setOf("claude", "github", "cloudflare")

        /** What forgetting one costs, said before it is done. */
        fun forgetting(name: String): String = when (name) {
            "claude" ->
                "Runners you start go back to the runner repository's API key, and boxes stop being given it. " +
                    "Getting it back means a new token from claude setup-token."
            "github", "cloudflare" ->
                "Boxes stop being given it when they next ask. Getting it back means signing in again from this page."
            else -> "Boxes stop being given it when they next ask. Getting it back means typing it in again."
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
