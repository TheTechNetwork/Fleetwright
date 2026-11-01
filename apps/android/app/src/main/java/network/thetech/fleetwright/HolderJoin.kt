package network.thetech.fleetwright

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
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
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
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
 * THE SECRETS ARE KEPT ON THIS PHONE ONLY, a few per Xen Orchestra, because
 * one address can have a pool's own machine on each of its pools, and THE
 * PHONE THAT MADE A MACHINE LETS IT IN BY ITSELF: the proof is the
 * authorisation, carried from Apply to the request. Asked for: "If I
 * authorize the creation of a holder why do I need to let it in? We can carry
 * the authorization from the creation: if it's the same VM, allow it in." So
 * a secret is sealed to an AES key in the Keystore that needs nobody, as the
 * fleet credential is (Settings), readable by this app with the phone in a
 * pocket, and a request it proves is let in the moment this phone sees it:
 * on Machines, or when the asks-to-join push reaches it (HolderNotice).
 *
 * WHAT THE OWNER'S CHECK GUARDED, and why it is not needed here. It stood
 * between a process running as this app and the approval. That process
 * already holds the fleet credential and the signing key that approve any
 * box's key in the vault with no check (PhoneVault.approve, DeviceSigning),
 * so the check on this one item guarded nothing the rest of the phone did not
 * already give away; what it cost was a second tap for a machine the person
 * had just asked for. The proof is what carries the security: only the
 * machine that read this phone's secret off its own cloud-init drive can make
 * it, the coordinator never has the secret, and the grant it earns is one
 * item, the pool's.
 *
 * A SECRET FROM BEFORE is still sealed to the RSA key whose private half
 * needs the owner for each use, and is opened only from a tap, by the prompt
 * handed the cipher (a CryptoObject): only the cipher the system gives back
 * after a real check opens it, never a yes or no the app believes. Never
 * quietly.
 */
internal object HolderJoin {
    /** The key that needs nobody: what a secret is sealed to now. */
    private const val QUIET_KEY_ALIAS = "fleetwright.holder-join.3"
    /** What a secret sealed to [QUIET_KEY_ALIAS] is kept as: `3:` then iv:ciphertext, both base64. */
    private const val QUIET = "3:"
    /** The key whose private half needs the owner for every use, from before: read from a tap only. */
    private const val KEY_ALIAS = "fleetwright.holder-join.2"
    /** The one that was usable for thirty seconds after any check; deleted, and nothing sealed to it is read. */
    private const val OLD_KEY_ALIAS = "fleetwright.holder-join"
    /** What a secret sealed to [KEY_ALIAS] is kept as: one sealed to the old key has no such mark. */
    private const val SEALED = "2:"
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
     * case nothing is sent and the machine joins with its pin. Sealed to the
     * key that needs nobody, so the push that says the machine asks can be
     * answered with the phone in a pocket (see the top of this file).
     */
    fun newSecret(settings: Settings, address: String): String? = runCatching {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, quietKey()) }
        val sealed = QUIET + Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(secret.toByteArray(Charsets.US_ASCII)), Base64.NO_WRAP)
        settings.putHolderSecrets(address, (listOf(sealed) + kept(settings, address)).take(KEPT_PER_ADDRESS))
        secret
    }.getOrNull()

    /** The secrets kept for [address] that this phone will open, newest first: quietly, or from before behind the owner. */
    private fun kept(settings: Settings, address: String) = settings.holderSecrets(address).filter { it.startsWith(QUIET) || it.startsWith(SEALED) }

    /** Whether this phone keeps a secret for [address]: whether it made a machine there it would let in by itself. */
    fun made(settings: Settings, address: String): Boolean = kept(settings, address).isNotEmpty()

    /** One kept secret, and the sealed form it is kept as. */
    data class Secret(val sealed: String, val value: String)

    /**
     * The secrets this phone opens by itself for [address]: the ones sealed
     * to the key that needs nobody. Empty when it keeps none such.
     */
    fun secrets(settings: Settings, address: String): List<Secret> {
        val key = runCatching { quietKey() }.getOrNull() ?: return emptyList()
        return kept(settings, address).filter { it.startsWith(QUIET) }.mapNotNull { sealed ->
            runCatching {
                val (iv, body) = sealed.removePrefix(QUIET).split(":", limit = 2)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))) }
                Secret(sealed, String(cipher.doFinal(Base64.decode(body, Base64.NO_WRAP)), Charsets.US_ASCII))
            }.getOrNull()
        }
    }

    /**
     * The secrets kept for [waiting]'s address, for a tap: the ones this
     * phone opens by itself, and, when it keeps none such, the ones from
     * before, each opened by its own check with [title] on it, newest first,
     * until one proves a request [waiting] holds. Null when the person
     * cancels or a check fails; empty when this phone keeps none it can open.
     */
    suspend fun unlock(context: Context, settings: Settings, waiting: Waiting, title: String): List<Secret>? {
        val quiet = secrets(settings, waiting.address)
        if (quiet.isNotEmpty()) return quiet
        val kept = kept(settings, waiting.address).filter { it.startsWith(SEALED) }
        if (kept.isEmpty()) return emptyList()
        val key = privateKey() ?: return emptyList()
        val opened = mutableListOf<Secret>()
        for (sealed in kept) {
            val cipher = runCatching {
                Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply { init(Cipher.DECRYPT_MODE, key, OAEP) }
            }.getOrElse {
                // A new fingerprint or face, or the screen lock removed: the
                // key is gone for good, and so is every secret sealed to it.
                if (it is KeyPermanentlyInvalidatedException) dropKey(KEY_ALIAS)
                return opened
            }
            val unlocked = authenticate(context, cipher, title, waiting.address) ?: return null
            val value = runCatching {
                String(unlocked.doFinal(Base64.decode(sealed.removePrefix(SEALED), Base64.NO_WRAP)), Charsets.US_ASCII)
            }.getOrNull() ?: continue
            opened += Secret(sealed, value)
            if (proven(waiting, listOf(value)) != null) break
        }
        return opened
    }

    /** The one that let a machine in, gone: it proves nothing it should. */
    fun spent(settings: Settings, address: String, secret: Secret) {
        settings.putHolderSecrets(address, settings.holderSecrets(address).filter { it != secret.sealed })
    }

    /**
     * The key that needs nobody: AES in the Keystore, non-extractable, with
     * no owner check, as Settings keeps the fleet credential under. Made the
     * first time a secret is sealed.
     */
    private fun quietKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(QUIET_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(QUIET_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Deliberately NOT setUserAuthenticationRequired: the asks-to-join
                // push is answered with the phone in a pocket (the top of this file).
                .build(),
        )
        return generator.generateKey()
    }

    /** SHA-256 for the digest and SHA-1 for MGF1, which is what the Keystore's private half takes. */
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)

    /** The public half, as a software key: encrypting needs no check. */
    private fun publicKey(): PublicKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        // The old key goes the first time a secret is kept under the new one.
        if (store.containsAlias(OLD_KEY_ALIAS)) dropKey(OLD_KEY_ALIAS)
        val cert = store.getCertificate(KEY_ALIAS) ?: run {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
                initialize(
                    KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setKeySize(2048)
                        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                        // THE PRIVATE HALF ONLY AFTER THE PHONE'S OWNER, for
                        // each use: 0 is per operation, so a check is good for
                        // the one cipher the prompt was handed and nothing else.
                        .setUserAuthenticationRequired(true)
                        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
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

    private fun dropKey(alias: String) {
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }
    }

    /**
     * The system's own check, a strong fingerprint or face or the screen lock,
     * with the cipher it authorises: the one the system hands back, or null
     * for cancelled or failed. Never a yes or no; see the top of this file.
     */
    private suspend fun authenticate(context: Context, cipher: Cipher, title: String, address: String): Cipher? =
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
                    BiometricPrompt.CryptoObject(cipher),
                    signal,
                    context.mainExecutor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            if (cont.isActive) cont.resume(result.cryptoObject?.cipher)
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (cont.isActive) cont.resume(null)
                        }
                    },
                )
            }.onFailure { if (cont.isActive) cont.resume(null) }
        }

    // Letting it in

    /** How letting a machine in ended, in the words the card and a notification say. */
    sealed class Outcome(val said: String?, val isIn: Boolean) {
        /** In, and holding its pool. */
        class Joined(said: String) : Outcome(said, true)
        /** In, and the vault would not let it hold the pool: said, with what to do. */
        class JoinedNotHolding(said: String) : Outcome(said, true)
        /** Said and not let in: this phone did not make it, no request is proved, or the fleet refused. */
        class Refused(said: String) : Outcome(said, false)
        /** Nothing to say: the person cancelled the check, or, quietly, the only secrets are from before and need a tap. */
        object Unsaid : Outcome(null, false)
    }

    /**
     * THE ONE APPROVAL, from a tap or by itself ([quietly]). The request one
     * of this phone's secrets proves is the one let in: the fleet enrols that
     * key, and the vault lets the same key hold that pool and nothing else of
     * this person's. A request none of them proves is said as such and
     * nothing is let in. Quietly, only the secrets this phone opens by itself
     * are looked at, so nothing puts a check up from a background.
     */
    suspend fun admit(context: Context, settings: Settings, waiting: Waiting, quietly: Boolean): Outcome {
        if (waiting.requests.isEmpty()) return Outcome.Unsaid
        val secrets = if (quietly) {
            val quiet = secrets(settings, waiting.address)
            // Only secrets from before: a tap opens them, this does not.
            if (quiet.isEmpty() && made(settings, waiting.address)) return Outcome.Unsaid
            quiet
        } else {
            unlock(context, settings, waiting, reason(waiting.hostId, waiting.address)) ?: return Outcome.Unsaid
        }
        if (secrets.isEmpty()) return Outcome.Refused(notThisPhone(waiting.hostId))
        val (request, value) = proven(waiting, secrets.map { it.value }) ?: return Outcome.Refused(notProven(waiting.hostId))
        val fleet = Fleet(settings)
        val answer = fleet.approveHolder(waiting.hostId, request.key).getOrElse {
            return Outcome.Refused(it.message ?: "The fleet did not let ${waiting.hostId} in.")
        }
        if (!answer.ok) return Outcome.Refused(answer.text.ifBlank { "The fleet did not let ${waiting.hostId} in." })
        secrets.firstOrNull { it.value == value }?.let { spent(settings, waiting.address, it) }
        return PhoneVault(settings).approveHolder(fleet, waiting.hostId, request.publicJwk, waiting.address).fold(
            onSuccess = { Outcome.Joined(joined(waiting.hostId, waiting.address)) },
            onFailure = { Outcome.JoinedNotHolding(joinedNotHolding(waiting.hostId, it.message ?: "the vault did not answer.")) },
        )
    }

    /**
     * By itself, from the push that says a machine asks (HolderNotice): the
     * one waited on under that name, let in when this phone's secret proves
     * its request. Null when there is no such name, or nothing to say.
     */
    suspend fun admit(context: Context, settings: Settings, hostId: String): Outcome? {
        val waiting = Fleet(settings).holders().getOrNull()?.firstOrNull { it.hostId == hostId } ?: return null
        return admit(context, settings, waiting, quietly = true).takeIf { it !is Outcome.Unsaid }
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
    /** Under a name nothing has asked under yet, on the phone that made it. */
    fun byItself(hostId: String) = "This phone made $hostId, so it lets it in by itself once it asks. Nothing to tap."
    /** The notification, once it is in: the title, and [joined] under it. */
    fun joinedTitle(hostId: String) = "$hostId joined"
    /** The one action on the asks-to-join notification. */
    const val LET_IN_WORD = "Let it in"
}
