package network.thetech.fleetwright

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The install's push key, held by the Android Keystore.
 *
 * PURPOSE_AGREE_KEY AND NOTHING ELSE. The private half never enters the process:
 * the agreement runs in the keystore, which is the point of not doing this
 * with a key a test could export. No user authentication. A notification
 * arrives while the phone is locked, and a key that asked for a biometric
 * could not be used by the service that has to open it. The device does not
 * have to be unlocked either — the default — for the same reason.
 *
 * ANDROID 12 AND LATER. PURPOSE_AGREE_KEY, and ECDH in the keystore with it,
 * arrived in API 31; this app runs from 30. An Android 11 phone registers no
 * key and keeps the plaintext notifications it has always had.
 */
internal object PushKey {
    private const val ALIAS = "fleetwright.push"
    private const val KEYSTORE = "AndroidKeyStore"

    /**
     * The key registration sends, or null when this phone cannot open what
     * would be sealed to it. Throws when the keystore did not answer, and the
     * caller then registers nothing this time.
     *
     * WHY A THROW AND NOT A NULL. The coordinator keeps a key only when the
     * registration sends one (core.js, registerDevice), so a registration
     * without it is a phone put back on plaintext until the next one. Over a
     * hiccup that is the wrong trade; the next launch registers again.
     *
     * NULL ONLY FOR A PHONE THAT CANNOT: Android 11; a keystore that will not
     * make an agreement key, which on a phone with no key yet leaves nothing
     * at the coordinator to lose; or a key that fails the self-test, sealing
     * a probe to it in software and opening it in the keystore. A key that
     * fails it is deleted, so the next launch makes a fresh one rather than
     * failing the same way for good.
     */
    fun forRegistration(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val ks = keyStore()
        val fresh = !ks.containsAlias(ALIAS)
        if (fresh) {
            try {
                val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setUserAuthenticationRequired(false)
                    .build()
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
                    initialize(spec)
                    generateKeyPair()
                }
            } catch (_: GeneralSecurityException) {
                return null
            } catch (_: RuntimeException) {
                // ProviderException, and whatever else a keystore that
                // cannot make this kind of key says it with. No key was ever
                // registered from this install, so none is lost.
                return null
            }
        }
        // A KEY MADE JUST NOW HAS NEVER BEEN SENT, so nothing it fails at
        // can cost a key the coordinator holds: it goes, and this phone
        // registers without one. A key from an earlier launch that cannot be
        // read this time is the hiccup the throw is for.
        return try {
            checked(ks)
        } catch (e: Exception) {
            if (!fresh) throw e
            runCatching { ks.deleteEntry(ALIAS) }
            null
        }
    }

    /** The key's public half, encoded, once it has opened its own seal; null when it cannot. */
    private fun checked(ks: KeyStore): String? {
        val privateKey = ks.getKey(ALIAS, null) as? PrivateKey ?: throw KeyStoreException("the push key has no private half")
        val public = ks.getCertificate(ALIAS)?.publicKey as? ECPublicKey ?: throw KeyStoreException("the push key has no public half")
        val raw = PushCrypto.uncompressed(public)
        if (!PushCrypto.opensItsOwnSeal(privateKey, raw, KEYSTORE)) {
            runCatching { ks.deleteEntry(ALIAS) }
            return null
        }
        return PushCrypto.b64e(raw)
    }

    /** The opened notification, or null. Never throws: a bad envelope is the fallback. */
    fun open(envelope: String): PushCrypto.Opened? = try {
        val ks = keyStore()
        val privateKey = ks.getKey(ALIAS, null) as? PrivateKey ?: return null
        val public = ks.getCertificate(ALIAS)?.publicKey as? ECPublicKey ?: return null
        PushCrypto.open(privateKey, PushCrypto.uncompressed(public), envelope, KEYSTORE)
    } catch (_: Exception) {
        null
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
}
