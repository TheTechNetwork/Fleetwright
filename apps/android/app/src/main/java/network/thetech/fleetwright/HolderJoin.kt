package network.thetech.fleetwright

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec
import kotlin.coroutines.resume

/**
 * A pool's own machine asking to join, from this phone: the secret the phone
 * gives the policy job that makes it, the proof the machine asks with, and the
 * one approval that lets it in and lets it hold its pool. HolderJoin.swift is
 * the same on iOS; src/fleet/protocol/holder-join.js is the machine's half and
 * the coordinator's, and test/fixtures/parity/holder-join.json holds all three
 * to one proof.
 *
 * ASKED FOR: "Should it ask us for a pin we request it from the app it gets
 * Face ID". The pin a holder was booted with lasted ten minutes, and a first
 * boot that took longer left it outside the fleet for good.
 *
 * THE PHONE CHECKS THE PROOF, NOT THE COORDINATOR, which relays the request and
 * never has the secret, so a coordinator that offered a key of its own under
 * the holder's name has no proof to offer with it.
 *
 * THE SECRETS ARE KEPT behind the phone's owner, as on iOS: written without
 * asking, read only after a fingerprint, face or the screen lock. A Keystore
 * key that needs a check for every use needs one to encrypt as well, so they
 * are encrypted to the public half of an RSA key pair kept in the Keystore,
 * which anybody may use, and opened with its private half, which works for
 * thirty seconds after the check. A few are kept per Xen Orchestra, because
 * one address can have a pool's own machine on each of its pools.
 */
internal object HolderJoin {
    private const val KEY_ALIAS = "fleetwright.holder-join"
    const val KEPT_PER_ADDRESS = 4

    /** One name the fleet holds for a pool's own machine, and the requests made under it. */
    data class Waiting(val hostId: String, val address: String, val madeAt: Long, val until: Long, val requests: List<Request>)

    data class Request(val key: String, val publicJwk: JSONObject, val proof: String, val at: Long) {
        override fun equals(other: Any?): Boolean = other is Request && other.key == key && other.proof == proof && other.at == at
        override fun hashCode(): Int = (key + proof).hashCode()
    }

    fun waitingFrom(o: JSONObject): Waiting? {
        val hostId = o.optString("hostId").takeIf { it.isNotBlank() } ?: return null
        val list = o.optJSONArray("requests") ?: JSONArray()
        val requests = (0 until list.length()).mapNotNull { i ->
            val r = list.optJSONObject(i) ?: return@mapNotNull null
            val jwk = r.optJSONObject("publicJwk") ?: return@mapNotNull null
            Request(key = r.optString("key"), publicJwk = jwk, proof = r.optString("proof"), at = r.optLong("at", 0L))
        }
        return Waiting(hostId, o.optString("address"), o.optLong("madeAt", 0L), o.optLong("until", 0L), requests)
    }

    // The proof

    /** What the proof is a MAC over, exactly as holder-join.js writes it. */
    fun message(hostId: String, address: String, keyHash: String): String =
        "fleetwright-holder-join/1\n$hostId\n$address\n$keyHash"

    /** The whole SHA-256 of a key over `{"crv","kty","x","y"}` in that order, hex. */
    fun keyHash(jwk: JSONObject): String {
        val canonical = "{\"crv\":${JSONObject.quote(jwk.optString("crv"))},\"kty\":${JSONObject.quote(jwk.optString("kty"))}," +
            "\"x\":${JSONObject.quote(jwk.optString("x"))},\"y\":${JSONObject.quote(jwk.optString("y"))}}"
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** HMAC-SHA-256 of the message under the secret, hex; null for a secret that is not 64 hex characters. */
    fun proof(secret: String, hostId: String, address: String, keyHash: String): String? {
        if (!Regex("^[0-9a-f]{64}$").matches(secret)) return null
        val raw = secret.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(raw, "HmacSHA256")) }
        return mac.doFinal(message(hostId, address, keyHash).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** The request one of these secrets proves, and the secret: null is none. */
    fun proven(waiting: Waiting, secrets: List<String>): Pair<Request, String>? {
        for (request in waiting.requests) {
            if (request.key != keyHash(request.publicJwk)) continue
            val secret = secrets.firstOrNull { proof(it, waiting.hostId, waiting.address, request.key) == request.proof }
            if (secret != null) return request to secret
        }
        return null
    }

    // The secrets

    /**
     * A new secret for a machine about to be made for [address], kept here
     * before it is sent, or null when the Keystore would not keep it, in which
     * case nothing is sent and the machine joins with its pin.
     */
    fun newSecret(settings: Settings, address: String): String? = runCatching {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply { init(Cipher.ENCRYPT_MODE, publicKey(), OAEP) }
        val sealed = Base64.encodeToString(cipher.doFinal(secret.toByteArray(Charsets.US_ASCII)), Base64.NO_WRAP)
        settings.putHolderSecrets(address, (listOf(sealed) + settings.holderSecrets(address)).take(KEPT_PER_ADDRESS))
        secret
    }.getOrNull()

    /** One kept secret, and the sealed form it is kept as. */
    data class Secret(val sealed: String, val value: String)

    /**
     * The secrets kept for [address], after the system's check with [title]
     * on it. Null when the person cancels or the check fails; empty when this
     * phone keeps none for it.
     */
    suspend fun unlock(context: Context, settings: Settings, address: String, title: String): List<Secret>? {
        val kept = settings.holderSecrets(address)
        if (kept.isEmpty()) return emptyList()
        if (!authenticate(context, title, address)) return null
        val key = privateKey() ?: return emptyList()
        return kept.mapNotNull { sealed ->
            runCatching {
                val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply { init(Cipher.DECRYPT_MODE, key, OAEP) }
                Secret(sealed, String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.US_ASCII))
            }.getOrNull()
        }
    }

    /** The one that let a machine in, gone: it proves nothing it should. */
    fun spent(settings: Settings, address: String, secret: Secret) {
        settings.putHolderSecrets(address, settings.holderSecrets(address).filter { it != secret.sealed })
    }

    /** SHA-256 for the digest and SHA-1 for MGF1, which is what the Keystore's private half takes. */
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)

    /** The public half, as a software key: encrypting needs no check. */
    private fun publicKey(): PublicKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val cert = store.getCertificate(KEY_ALIAS) ?: run {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
                initialize(
                    KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setKeySize(2048)
                        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                        // THE PRIVATE HALF ONLY AFTER THE PHONE'S OWNER, for
                        // thirty seconds: long enough to open every secret
                        // kept for one address after one check.
                        .setUserAuthenticationRequired(true)
                        .setUserAuthenticationParameters(30, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                        .build(),
                )
            }.generateKeyPair()
            store.getCertificate(KEY_ALIAS)
        }
        return KeyFactory.getInstance(cert.publicKey.algorithm).generatePublic(X509EncodedKeySpec(cert.publicKey.encoded))
    }

    private fun privateKey(): PrivateKey? = runCatching {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        store.getKey(KEY_ALIAS, null) as? PrivateKey
    }.getOrNull()

    /** The system's own check: a strong fingerprint or face, or the screen lock. */
    private suspend fun authenticate(context: Context, title: String, address: String): Boolean =
        suspendCancellableCoroutine { cont ->
            val signal = CancellationSignal()
            cont.invokeOnCancellation { signal.cancel() }
            val prompt = BiometricPrompt.Builder(context)
                .setTitle(title)
                .setSubtitle(address)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build()
            runCatching {
                prompt.authenticate(
                    signal,
                    context.mainExecutor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            if (cont.isActive) cont.resume(true)
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (cont.isActive) cont.resume(false)
                        }
                    },
                )
            }.onFailure { if (cont.isActive) cont.resume(false) }
        }

    // What both phones say

    fun asks(hostId: String) = "$hostId asks to join"
    fun toHold(address: String) = "To hold $address. This phone checks it is the machine you made before it lets it in."
    fun notYet(hostId: String) = "$hostId has not asked to join yet. If it never does, make it again from the pool’s policy."
    fun reason(hostId: String, address: String) = "Let $hostId join and hold $address"
    fun notProven(hostId: String) =
        "None of the requests under $hostId was made by the machine this phone made, so nothing was let in. " +
            "Decline it, and make the pool’s own machine again if it never asks."
    fun notThisPhone(hostId: String) =
        "This phone did not make $hostId, so it cannot check it. Let it in from the phone that applied the policy, or make it again from this one."
    fun joined(hostId: String, address: String) = "$hostId has joined and holds $address."
    fun joinedNotHolding(hostId: String, why: String) =
        "$hostId has joined, and could not be approved to hold its pool: $why Approve it under its page."
}
