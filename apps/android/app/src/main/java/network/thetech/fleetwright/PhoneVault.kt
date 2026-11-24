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
     *
     * `heldBy`, for a Codex sign-in: the machine that holds it, by the name
     * its approval has. A Codex sign-in is given to one machine and no other,
     * so null on a kept one is "no machine has asked for it yet"
     * (docs/engines.md, "Credentials"). Null for anything else.
     */
    data class Item(val name: String, val at: Long, val kind: String? = null, val heldBy: String? = null)

    /**
     * One box this person approved. [key] is the whole SHA-256 of the box's
     * key, as the minter names the grant ([keyHash]); [fingerprint] is its
     * first sixteen characters. [only] is the vault's `only`: the items a box
     * approved for some of the vault may hold, as [approveHolder] writes it
     * for a pool's own machine. Empty is the whole vault.
     */
    data class Grant(val key: String, val fingerprint: String, val label: String, val email: String, val only: List<String> = emptyList())

    /** What this vault says about the key a machine answered with. PhoneVault.swift's `Approval`. */
    enum class Approval {
        /** Approved for the whole vault, under that machine's name, by that key. */
        APPROVED,

        /**
         * Approved for the whole vault under that machine's name, by another
         * key: a machine that was re-keyed would have been re-approved.
         */
        ANOTHER_KEY,

        /** Nothing that counts, which asks the person. */
        NONE,
    }

    /**
     * [custody], for a person's own vault: whether their managers may manage
     * it, who those managers are, and what they changed. Null for a member's
     * vault opened by a custodian, and from a vault older than the organization.
     */
    data class Contents(val items: List<Item>, val grants: List<Grant>, val custody: Custody? = null)

    /**
     * Who else may manage a person's vault, as the vault itself holds it
     * (docs/members.md, "Custodians of a person member"). [member] is the
     * person's own member, by id, or null when the vault's tree has none for them.
     * [custodians] is whoever added this person, and so manages what they
     * keep with no switch asked; it is empty from a vault older than the
     * rule, which is also the truth there. [managers] are their other
     * managers, who wait on [allow].
     */
    data class Custody(
        val allow: Boolean,
        val member: String?,
        val custodians: List<String>,
        val managers: List<String>,
        val log: List<Change>,
    ) {
        /** One thing a manager did, by name and never by value. */
        data class Change(val at: Long, val by: String, val op: String, val name: String?)
    }

    /**
     * The organization as the vault holds it: its admins, this person's
     * standing there, and each member's place and who may act for it. The
     * vault's own copy of the tree, which the fleet's list is never shown as
     * (docs/members.md, "A member's vault"). [youBound] is whether the vault
     * knows this address as this GitHub account's.
     */
    data class Org(val admins: List<String>, val youAdmin: Boolean, val youBound: Boolean, val members: List<OrgMember>) {
        fun member(id: String): OrgMember? = members.firstOrNull { it.id == id }
    }

    /**
     * One member's place in the vault's tree. [custodians] are an agent
     * member's own; for a person, whoever added them when the vault had not
     * met them before. [custody], for a person, is
     * "allowed", "off" or "no_vault", and null for an agent. [may] is
     * everybody who may act for this member's vault now.
     */
    data class OrgMember(
        val id: String,
        val kind: String,
        val email: String?,
        val reportsTo: String?,
        val managers: List<String>,
        val custodians: List<String>,
        val custody: String?,
        val may: List<String>,
    )

    /**
     * A request the fleet or the vault refused: the sentence a screen shows,
     * as it always was, and the `error.code` that came beside it.
     *
     * THE CODE IS FOR A CALLER THAT GOES ON AFTER ONE PARTICULAR REFUSAL, and
     * for nothing drawn. Removing a member asks the vault first, and a vault
     * that never held the member (`no_member`) has nothing to take out, so
     * the fleet is asked anyway (OrgScreen, `remove`). Deciding that from the
     * sentence would be deciding from this week's wording. An
     * IllegalStateException still, as `error()` threw before, so every other
     * caller reads its message exactly as it did. PhoneVault.swift has the
     * same thing under the same name.
     *
     * @param code null from a reply that carried none.
     */
    class Refused(val code: String?, text: String) : IllegalStateException(text)

    /**
     * Whether this fleet keeps a vault at all, for a phone that cannot ask
     * the vault itself because it holds no GitHub sign-in. Asked of the route
     * that gives the minter's key, which needs only the fleet sign-in and
     * refuses with one of [saysNoVault]'s two codes when there is no vault.
     *
     * NO ANSWER IS NOT "NO VAULT" (C-5). Only the fleet saying so in a code
     * is; a request that failed, or any other refusal, counts as a vault that
     * is there, because the caller skips the vault on a false.
     */
    suspend fun isKept(fleet: Fleet): Boolean {
        val said = runCatching { fleet.claudeLoginKey() }.getOrNull() ?: return true
        return !saysNoVault(said.optJSONObject("error")?.optString("code"))
    }

    /**
     * [extra] with the member whose vault this request opens, when it is not
     * the asker's own: the vault's `for` (src/fleet/minter/vault.js).
     */
    private fun aimed(extra: JSONObject, member: String?): JSONObject =
        if (member.isNullOrBlank()) extra else extra.put("for", member)

    private fun strings(array: JSONArray?): List<String> =
        (0 until (array?.length() ?: 0)).mapNotNull { i -> array?.optString(i)?.takeIf { it.isNotBlank() } }

    /** A string the answer carries, or null for a missing one and for JSON's null. */
    private fun textOrNull(o: JSONObject, key: String): String? =
        if (o.isNull(key)) null else o.optString(key).takeIf { it.isNotBlank() }

    /** Seal one request, relay it, open the answer. */
    private suspend fun ask(fleet: Fleet, op: String, extra: JSONObject = JSONObject()): Pair<String, JSONObject> {
        val pin = PhoneGitHub(settings).minterKey(fleet)
        val email = settings.signedInAs.trim().ifBlank { error("Sign in to your fleet again.") }
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
        if (r.optBoolean("ok") != true) {
            throw Refused(
                r.optJSONObject("error")?.optString("code")?.ifBlank { null },
                r.optString("text").ifBlank { "Your fleet refused that." },
            )
        }
        val answer = Seal.open(reply, Seal.VAULT_REPLY_AAD, r.getJSONObject("sealed"))
        return r.optString("text") to answer
    }

    suspend fun list(fleet: Fleet, member: String? = null): Contents {
        val (_, answer) = ask(fleet, "list", aimed(JSONObject(), member))
        val items = answer.optJSONArray("items")
        val grants = answer.optJSONArray("grants")
        val custody = answer.optJSONObject("custody")?.let { c ->
            val log = c.optJSONArray("log")
            Custody(
                allow = c.optBoolean("allow", false),
                member = textOrNull(c, "member"),
                custodians = strings(c.optJSONArray("custodians")),
                managers = strings(c.optJSONArray("managers")),
                log = (0 until (log?.length() ?: 0)).mapNotNull { i ->
                    log?.optJSONObject(i)?.let { Custody.Change(it.optLong("at"), it.optString("by"), it.optString("op"), textOrNull(it, "name")) }
                },
            )
        }
        return Contents(
            custody = custody,
            items = (0 until (items?.length() ?: 0)).mapNotNull { i ->
                items?.optJSONObject(i)?.let { Item(it.optString("name"), it.optLong("at"), it.optString("kind").ifBlank { null }, textOrNull(it, "heldBy")) }
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

    suspend fun keepSecret(fleet: Fleet, name: String, value: String, member: String? = null): Result<String> = runCatching {
        val n = name.trim()
        require(SECRET_NAME.matches(n)) { "A secret's name is up to 64 letters, digits, dots, dashes and underscores." }
        require(value.isNotEmpty()) { "The secret is empty." }
        ask(fleet, "put", aimed(JSONObject().put("name", "secret:$n").put("value", value), member)).first
    }

    /**
     * Keep a Claude login in a MEMBER'S vault: a setup-token, or the whole
     * sign-in one of the fleet's machines made. A person's own goes through
     * PhoneGitHub.depositClaudeLogin, as it always did; this is the same
     * thing as a vault request, because only a vault request can say whose
     * vault it is for.
     */
    suspend fun keepClaude(fleet: Fleet, token: String?, signIn: JSONObject?, member: String): Result<String> = runCatching {
        val extra = JSONObject().put("name", "claude")
        if (signIn != null) {
            extra.put("signIn", signIn)
        } else {
            val value = token.orEmpty().trim()
            require(value.isNotEmpty()) { "The token is empty." }
            extra.put("value", value)
        }
        ask(fleet, "put", aimed(extra, member)).first
    }

    /**
     * Keep the sign-in an engine other than Claude Code runs on
     * (docs/engines.md, "Credentials"): `codex`, the whole text of the
     * `auth.json` that `codex login` writes, `copilot`, one GitHub Copilot
     * token, or `apikey:<provider>`, one API key (docs/api-engines.md). Kept
     * the way a named secret is, under its own name, and the vault checks
     * what it is: its refusal is a sentence, shown as it came. A Codex file
     * is sent as it was pasted, never trimmed here, because the vault reads
     * it whole.
     */
    suspend fun keepEngineSignIn(fleet: Fleet, name: String, value: String, member: String? = null): Result<String> = runCatching {
        require(name in ENGINE_VAULT_ITEMS) { "$name is not an engine's sign-in." }
        require(value.isNotBlank()) { "Nothing to keep yet." }
        ask(fleet, "put", aimed(JSONObject().put("name", name).put("value", value), member)).first
    }

    /**
     * Keep a hypervisor's token in the fleet: the record setup handed this
     * phone, under `hypervisor:<address>`, or one box's own user under
     * `hypervisor:<address>+<box>` (XoHandoff.keepBoxUsers). The minter
     * checks the record names that address, and that box; the boxes this
     * person approved are handed the shared one, and a box its own alone,
     * hold it in memory only (src/fleet/host/xo-pools.js), and make machines
     * on the pool with it.
     */
    suspend fun keepHypervisor(fleet: Fleet, address: String, record: String, box: String? = null): Result<String> = runCatching {
        val name = if (box == null) "hypervisor:$address" else "hypervisor:$address+$box"
        ask(fleet, "put", JSONObject().put("name", name).put("value", record)).first
    }

    /**
     * Keep a sandbox provider in this person's own vault
     * (docs/api-engines.md, "The item"): the provider's API key and the
     * templates to offer, under `sandbox:<provider>`. Never a member's
     * vault: a machine rented with it is its owner's, as a machine on their
     * own hypervisor is.
     *
     * THE WHOLE RECORD EVERY TIME. The vault reads nothing back, so keeping
     * it again replaces the key and every template together.
     */
    suspend fun keepSandbox(fleet: Fleet, provider: String, key: String, templates: List<SandboxTemplate>): Result<String> = runCatching {
        require(templates.isNotEmpty()) { SandboxWords.NEEDS_TEMPLATE }
        val record = requireNotNull(sandboxRecordText(key, templates)) { SandboxWords.NEEDS_KEY }
        ask(fleet, "put", JSONObject().put("name", "sandbox:$provider").put("value", record)).first
    }

    suspend fun forget(fleet: Fleet, name: String, member: String? = null): Result<String> = runCatching {
        ask(fleet, "forget", aimed(JSONObject().put("name", name), member)).first
    }

    /**
     * Whether a kept credential still works, asked by the minter of the
     * service it is for (vault.js, testItem). Anything short of accepted,
     * cannot tell included, comes back as a failure, so it is drawn as one.
     */
    suspend fun test(fleet: Fleet, name: String, member: String? = null): Result<String> = runCatching {
        val (text, answer) = ask(fleet, "test", aimed(JSONObject().put("name", name), member))
        if (answer.optString("state") != "accepted") error(text)
        text
    }

    /** Sign in to GitHub or Cloudflare for the vault: this phone runs the page, the minter keeps the result. */
    suspend fun connect(context: Context, fleet: Fleet, provider: String, member: String? = null): Result<String> = runCatching {
        val start = if (provider == "github") fleet.githubDeviceStart() else fleet.cloudflareDeviceStart()
        if (start.optBoolean("ok") != true) error(start.optString("text").ifBlank { "Your fleet cannot start that sign-in." })
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
            aimed(JSONObject().put("provider", provider).put("code", back.code).put("verifier", back.verifier).put("redirectUri", back.redirectUri), member),
        ).first
    }

    suspend fun approve(fleet: Fleet, host: Fleet.Host, member: String? = null): Result<String> = runCatching {
        val key = host.publicJwk ?: error("${host.hostId} cannot be approved yet. Update your fleet first.")
        ask(fleet, "grant", aimed(JSONObject().put("hostKey", key).put("label", host.hostId), member)).first
    }

    /** A pool's own machine, approved for its pool's record and nothing else of this person's (the vault's `only`). */
    suspend fun approveHolder(fleet: Fleet, hostId: String, key: JSONObject, address: String): Result<String> = runCatching {
        val jwk = JSONObject().put("kty", key.optString("kty")).put("crv", key.optString("crv")).put("x", key.optString("x")).put("y", key.optString("y"))
        ask(fleet, "grant", JSONObject().put("hostKey", jwk).put("label", hostId).put("only", JSONArray().put("hypervisor:$address"))).first
    }

    suspend fun remove(fleet: Fleet, grant: Grant, member: String? = null): Result<String> = runCatching {
        ask(fleet, "revoke", aimed(JSONObject().put("key", grant.key), member)).first
    }

    /** The vault's own copy of the organization's tree, and who may act for each member. */
    suspend fun org(fleet: Fleet): Result<Org> = runCatching {
        val (_, answer) = ask(fleet, "org")
        val you = answer.optJSONObject("you")
        val members = answer.optJSONArray("members")
        Org(
            admins = strings(answer.optJSONArray("admins")),
            youAdmin = you?.optBoolean("admin", false) == true,
            youBound = you?.optBoolean("bound", false) == true,
            members = (0 until (members?.length() ?: 0)).mapNotNull { i ->
                members?.optJSONObject(i)?.let { m ->
                    OrgMember(
                        id = m.optString("id"),
                        kind = m.optString("kind"),
                        email = textOrNull(m, "email"),
                        reportsTo = textOrNull(m, "reportsTo"),
                        managers = strings(m.optJSONArray("managers")),
                        custodians = strings(m.optJSONArray("custodians")),
                        custody = textOrNull(m, "custody"),
                        may = strings(m.optJSONArray("may")),
                    )
                }
            },
        )
    }

    /**
     * Add an admin of the organization in the vault, or remove one. The
     * first is somebody who administers the fleet filing themselves.
     */
    suspend fun fileOrgAdmin(fleet: Fleet, address: String, remove: Boolean = false): Result<String> = runCatching {
        val extra = JSONObject().put("address", address)
        if (remove) extra.put("remove", true)
        ask(fleet, "orgadmin", extra).first
    }

    /**
     * File one member's place in the vault's tree, or take it out. Custody
     * of the member's vault follows what is filed here, and nothing the
     * fleet's own list says. A missing `reportsTo` is the top of the tree.
     */
    suspend fun fileOrgMember(
        fleet: Fleet,
        id: String,
        kind: String,
        address: String?,
        reportsTo: String?,
        managers: List<String>? = null,
        remove: Boolean = false,
    ): Result<String> = runCatching {
        val extra = JSONObject().put("id", id).put("kind", kind)
        if (!reportsTo.isNullOrBlank()) extra.put("reportsTo", reportsTo)
        if (!address.isNullOrBlank()) extra.put("address", address)
        if (managers != null) extra.put("managers", JSONArray(managers))
        if (remove) extra.put("remove", true)
        ask(fleet, "orgmember", extra).first
    }

    /**
     * Add one of an agent member's own custodians, or remove one. The last
     * one stays, and the vault says so.
     */
    suspend fun setCustodian(fleet: Fleet, member: String, address: String, remove: Boolean = false): Result<String> = runCatching {
        val extra = JSONObject().put("member", member).put("address", address)
        if (remove) extra.put("remove", true)
        ask(fleet, "custodian", extra).first
    }

    /** Let this person's managers manage their own vault, or stop. */
    suspend fun setCustody(fleet: Fleet, allow: Boolean): Result<String> = runCatching {
        ask(fleet, "custody", JSONObject().put("allow", allow)).first
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
         * Whether a refusal's code says this fleet keeps no vault at all: the
         * coordinator's with no minting Worker (`no_minter`), and the minting
         * Worker's with no deposit key (`no_deposit_key`, "so it keeps no
         * vault", src/fleet/minter/vault.js).
         */
        fun saysNoVault(code: String?): Boolean = code == "no_minter" || code == "no_deposit_key"

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
         *
         * A WHOLE-VAULT GRANT UNDER THAT NAME BY ANOTHER KEY IS NOT "ASKS"
         * EITHER: it is [Approval.ANOTHER_KEY], a hard stop. A machine that
         * was re-keyed would have been re-approved, so whatever answered with
         * this key under that name is not the machine this phone approved,
         * and the comparison card would be asking the person to vouch for
         * it. iOS stops there too (PhoneVault.swift, `approval`).
         */
        fun approval(grants: List<Grant>, hostId: String, jwk: JSONObject): Approval {
            val named = grants.filter { it.only.isEmpty() && it.label == hostId }
            if (named.any { it.key == keyHash(jwk) }) return Approval.APPROVED
            return if (named.isEmpty()) Approval.NONE else Approval.ANOTHER_KEY
        }

        /**
         * The kept credentials there is a service to ask about. A named secret
         * and a hypervisor's token have none, so they get no Test button.
         */
        fun isTestable(name: String): Boolean = name in setOf("claude", "github", "cloudflare")

        /** What forgetting one costs, said before it is done. */
        fun forgetting(name: String): String = when (name) {
            "claude" ->
                "Your sessions stop using it. Getting it back means adding it again."
            "github", "cloudflare" ->
                "Machines you approved stop being given it. Getting it back means signing in again."
            "codex", "copilot" ->
                "Machines you approved stop being given it. Getting it back means pasting it again."
            else -> {
                val rented = sandboxProviderNameOfItem(name)
                when {
                    // An API key is pasted, as the two sign-ins above are.
                    apiProviderOfItem(name) != null ->
                        "Machines you approved stop being given it. Getting it back means pasting it again."
                    // A SANDBOX PROVIDER: what happens to a machine already
                    // rented is the question somebody forgetting the key
                    // has, and its timer is the provider's own, so that
                    // much is certain.
                    rented != null ->
                        "Machines you approved stop being given it. A machine already rented at $rented still ends on its timer. Getting it back means entering the key and the templates again."
                    else -> "Machines you approved stop being given it. Getting it back means typing it in again."
                }
            }
        }

        /**
         * The same, for a member's vault a custodian is changing: whose
         * sessions stop, by the member's name. The same sentences as iOS.
         */
        fun forgetting(name: String, who: String): String =
            if (name == "claude") "Sessions started as $who stop using it. Getting it back means adding it again."
            else "Machines approved for $who stop being given it. Getting it back means adding it again."

        /**
         * One thing a manager did to this person's vault, as a row: who,
         * what they did to which item, and when. A machine approved or
         * removed is said as that, with no item. The same words as iOS.
         */
        fun custodyLine(change: Custody.Change, whenSaid: String): String {
            val what = change.name?.let { label(it) }.orEmpty()
            val did = when (change.op) {
                "put", "connect" -> "kept $what"
                "forget" -> "removed $what"
                "grant" -> "approved a machine"
                "revoke" -> "removed a machine"
                else -> change.op
            }
            return "${change.by} ${did.trim()} · $whenSaid"
        }

        /** How a vault item is named to a person. */
        fun label(name: String): String = when {
            name == "claude" -> "Claude"
            name == "github" -> "GitHub"
            name == "cloudflare" -> "Cloudflare"
            name == "codex" -> "Codex sign-in"
            name == "copilot" -> "GitHub Copilot token"
            apiProviderOfItem(name) != null -> "${apiProviderOfItem(name)?.says} API key"
            sandboxProviderNameOfItem(name) != null -> "${sandboxProviderNameOfItem(name)}, sandbox provider"
            name.startsWith("secret:") -> name.removePrefix("secret:")
            else -> name
        }
    }
}
