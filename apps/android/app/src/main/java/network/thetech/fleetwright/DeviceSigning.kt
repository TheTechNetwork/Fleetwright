package network.thetech.fleetwright

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * What this phone signs when it asks a box for something, so the box obeys the
 * person and not whoever relayed the request. DeviceSigning.swift is the same
 * on iOS. docs/signed-intents.md has the design; this is phase 2: the phone
 * signs, and boxes still only count what they find.
 *
 * WHERE THE BOX GETS THIS PHONE'S KEY. Not from the coordinator. The phone
 * lists its key with the fleet's minter, in a vault request sealed to the
 * minter and carrying this phone's GitHub sign-in (PhoneVault `devicekey`),
 * and boxes are given the list signed by the minter's own key, which they take
 * from the fleet's address and keep. So the phone signs only once the minter
 * has its key under the account it is signed in as: before that, a signature
 * would reach the box as a key it has never heard of.
 *
 * WHAT IS SIGNED: the verb, the parameters exactly as sent, the box it is for,
 * the person, the request's id and the time, in the bytes
 * src/fleet/protocol/intent-signature.js builds. Only an intent that names its
 * box is signed, because the signature is for one box; one the coordinator
 * places is sent unsigned, and so is one it changes on the way (it drops the
 * signature rather than send one that no longer holds).
 *
 * THE KEY is made in the Android Keystore, in StrongBox where the phone has
 * one, and cannot be read out of it. Signing asks for nothing: a prompt on
 * every tap is how a safety feature gets switched off.
 */
object IntentSigning {
    /** The bytes signed for one intent to one box, as `intentSigningInput`. */
    fun input(actor: String, id: String, issuedAt: Long, params: Map<String, Any?>, verb: String, host: String): String =
        signingInput("intent", mapOf("actor" to actor, "host" to host, "id" to id, "issuedAt" to issuedAt, "params" to params, "verb" to verb))

    /**
     * The bytes signed for a delegation, as `delegationSigningInput`: the
     * grant, every field of it (`v`, `id`, `actor`, `verbs`, `hosts`, `match`,
     * `issuedAt`, `expires`).
     */
    fun delegationInput(grant: Map<String, Any?>): String = signingInput("delegation", grant)

    /**
     * Verbs a box answers whoever asks, or takes from the fleet with nobody's
     * signature (`UNSIGNED_VERBS` and `COORDINATOR_UNSIGNED_VERBS` in
     * intent-signature.js): nothing to sign or delegate for these.
     */
    val unsignedVerbs = setOf("list", "status", "health", "updates", "profiles", "forgetperson", "vmlogin", "mint")

    /** `agent-fleet/v1/<context>\n<canonical JSON>`, as src/fleet/crypto.js `signingInput`. */
    fun signingInput(context: String, payload: Any?): String = "agent-fleet/v1/$context\n${canonical(payload)}"

    /**
     * JSON as JavaScript's `JSON.stringify` writes it, with every object's keys
     * sorted by UTF-16 code unit: crypto.js `canonical`. Not JSONObject, which
     * neither sorts keys nor escapes the way JavaScript does (it writes `\/`),
     * and a single byte of difference is a signature that does not hold.
     * test/fixtures/parity/intent-signing.json holds the cases where encoders
     * differ, and IntentSigningTest checks this against every one.
     */
    fun canonical(value: Any?): String = when (value) {
        null -> "null"
        JSONObject.NULL -> "null"
        is String -> quote(value)
        is Boolean -> value.toString()
        is Int, is Long, is Short, is Byte -> value.toString()
        is Number -> value.toDouble().let { d -> if (d % 1.0 == 0.0) d.toLong().toString() else d.toString() }
        is JSONObject -> canonical(value.keys().asSequence().associateWith { value.opt(it) })
        is JSONArray -> canonical((0 until value.length()).map { value.opt(it) })
        is Map<*, *> -> value.entries.associate { it.key.toString() to it.value }.let { m ->
            m.keys.sorted().joinToString(",", "{", "}") { k -> "${quote(k)}:${canonical(m[k])}" }
        }
        is List<*> -> value.joinToString(",", "[", "]") { canonical(it) }
        else -> "null"
    }

    /**
     * A string as `JSON.stringify` quotes it: a quote and a backslash escaped,
     * \b \f \n \r \t by name, every other control character as \u00XX in lower
     * case, and everything else (a slash, DEL, U+2028, anything outside ASCII)
     * as itself.
     */
    fun quote(s: String): String {
        val out = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c.code < 0x20 -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }

    /** A key's id: the whole SHA-256 of its JWK in canonical form, as the minter files it (`keyId`). */
    fun kid(x: String, y: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(canonical(mapOf("crv" to "P-256", "kty" to "EC", "x" to x, "y" to y)).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** A curve coordinate as the JWK carries it: 32 bytes, big-endian, unsigned. */
    fun coordinate(v: BigInteger): String {
        val bytes = v.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
        return b64(ByteArray(32 - bytes.size) + bytes)
    }

    /**
     * java.security's ECDSA signature, which is DER, as the r || s of 32 bytes
     * each that crypto.js `verify` takes. Sent as DER, every box would refuse it.
     */
    fun derToRaw(der: ByteArray): ByteArray {
        require(der.size >= 8 && der[0] == 0x30.toByte()) { "not a DER signature" }
        var i = if ((der[1].toInt() and 0x80) != 0) 2 + (der[1].toInt() and 0x7f) else 2
        fun integer(): ByteArray {
            require(der[i] == 0x02.toByte()) { "not a DER signature" }
            val len = der[i + 1].toInt() and 0xff
            val body = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            val trimmed = body.dropWhile { it == 0.toByte() }.toByteArray()
            require(trimmed.size <= 32) { "not a P-256 signature" }
            return ByteArray(32 - trimmed.size) + trimmed
        }
        return integer() + integer()
    }
}

/** This phone's signing key, made once and kept in the Keystore. */
class DeviceKey(
    val x: String,
    val y: String,
    /** Inside secure hardware (StrongBox or the TEE), as the Keystore reports it. */
    val hardware: Boolean,
    private val signer: (ByteArray) -> ByteArray,
) {
    val jwk: JSONObject get() = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", x).put("y", y)

    /** As the minter files the key and a box looks it up. */
    val kid: String get() = IntentSigning.kid(x, y)

    /** ECDSA P-256 with SHA-256, r || s, base64url. */
    fun sign(message: String): String = IntentSigning.b64(signer(message.toByteArray(Charsets.UTF_8)))

    companion object {
        private const val ALIAS = "fleetwright.device-signing"

        /** A key and its public half, signing as java.security does. Also what the tests sign with. */
        fun of(privateKey: PrivateKey, publicKey: ECPublicKey, hardware: Boolean): DeviceKey =
            DeviceKey(IntentSigning.coordinate(publicKey.w.affineX), IntentSigning.coordinate(publicKey.w.affineY), hardware) { message ->
                Signature.getInstance("SHA256withECDSA").run {
                    initSign(privateKey)
                    update(message)
                    IntentSigning.derToRaw(sign())
                }
            }

        /** The kept key, or a new one kept now. */
        fun load(): DeviceKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (!store.containsAlias(ALIAS)) {
                try {
                    generate(strongBox = true)
                } catch (e: ProviderException) {
                    // StrongBoxUnavailableException, or what some phones throw
                    // instead of it: the Keystore without StrongBox.
                    generate(strongBox = false)
                }
            }
            val entry = store.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
            val hardware = runCatching {
                val info = KeyFactory.getInstance(entry.privateKey.algorithm, "AndroidKeyStore")
                    .getKeySpec(entry.privateKey, KeyInfo::class.java)
                @Suppress("DEPRECATION")
                info.isInsideSecureHardware
            }.getOrDefault(false)
            return of(entry.privateKey, entry.certificate.publicKey as ECPublicKey, hardware)
        }

        private fun generate(strongBox: Boolean) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setIsStrongBoxBacked(strongBox)
                        // Deliberately NOT setUserAuthenticationRequired: a
                        // notification's action has to be sendable on a locked
                        // phone, as the fleet credential's key is.
                        .build(),
                )
                generateKeyPair()
            }
        }
    }
}

/** When this phone signs, and listing its key so that it can. */
internal class DeviceSigning(private val settings: Settings) {
    data class Signed(val sig: String, val kid: String, val issuedAt: Long)

    private val email: String get() = settings.signedInAs.trim()

    /**
     * The signature for an intent to [host], when this phone's key is listed
     * for the account it is signed in as. Null otherwise, and the intent goes
     * as it always has.
     */
    fun signature(verb: String, params: Map<String, Any?>, id: String, host: String): Signed? {
        if (email.isEmpty() || host.isBlank()) return null
        val key = runCatching { DeviceKey.load() }.getOrNull() ?: return null
        if (settings.deviceKeyListed != "${key.kid} $email") return null
        val issuedAt = System.currentTimeMillis()
        val sig = runCatching { key.sign(IntentSigning.input(email, id, issuedAt, params, verb, host)) }.getOrNull() ?: return null
        return Signed(sig, key.kid, issuedAt)
    }

    /**
     * A delegation: what this phone signs to let the fleet send [verbs] to
     * [hosts] (`["*"]` for whichever box it places them on) in this person's
     * name for [lifetimeMs], each parameter in [match] exactly as given
     * (docs/signed-intents.md, "Delegations"). A box checks it as it checks a
     * signature. Null until this phone's key is listed, as [signature] is.
     */
    fun delegation(verbs: List<String>, hosts: List<String>, match: Map<String, Any?>, lifetimeMs: Long): JSONObject? {
        if (email.isEmpty()) return null
        val key = runCatching { DeviceKey.load() }.getOrNull() ?: return null
        if (settings.deviceKeyListed != "${key.kid} $email") return null
        val now = System.currentTimeMillis()
        // A delegation's id is what it is revoked by, so never reused.
        val grant = mapOf(
            "v" to 1, "id" to java.util.UUID.randomUUID().toString().replace("-", ""), "actor" to email,
            "verbs" to verbs, "hosts" to hosts, "match" to match, "issuedAt" to now, "expires" to now + lifetimeMs,
        )
        val sig = runCatching { key.sign(IntentSigning.delegationInput(grant)) }.getOrNull() ?: return null
        return JSONObject().put("grant", JSONObject(grant)).put("sig", sig).put("kid", key.kid)
    }

    /**
     * List this phone's key with the minter for the account it is signed in
     * as, when it has a GitHub sign-in to do that with and has not already. At
     * most once in ten minutes, so a minter that is down is not asked on every
     * tap. Never throws: until it is listed, nothing is signed.
     */
    suspend fun listIfNeeded(fleet: Fleet) {
        if (email.isEmpty() || !PhoneGitHub(settings).signedIn) return
        val key = runCatching { DeviceKey.load() }.getOrNull() ?: return
        val listedAs = "${key.kid} $email"
        if (settings.deviceKeyListed == listedAs) return
        val now = System.currentTimeMillis()
        if (now - settings.deviceKeyListTriedAt < 600_000) return
        settings.deviceKeyListTriedAt = now
        if (PhoneVault(settings).listDeviceKey(fleet, key).isSuccess) settings.deviceKeyListed = listedAs
    }
}
