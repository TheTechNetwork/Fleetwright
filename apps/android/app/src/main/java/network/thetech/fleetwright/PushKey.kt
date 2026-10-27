package network.thetech.fleetwright

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The install's push key, held by the Android Keystore.
 *
 * PURPOSE_AGREE AND NOTHING ELSE. The private half never enters the process:
 * the agreement runs in the keystore, which is the point of not doing this
 * with a key a test could export. No user authentication. A notification
 * arrives while the phone is locked, and a key that asked for a biometric
 * could not be used by the service that has to open it. The device does not
 * have to be unlocked either — the default — for the same reason.
 *
 * A failure here is a registration with no `pushKey`. The notification then
 * stays in the clear, which is the trade the fallback exists for: no
 * notification at all is worse for somebody waiting on a session.
 */
internal object PushKey {
    private const val ALIAS = "fleetwright.push"

    /** base64url of the uncompressed public point, or nil when the keystore declines. */
    fun publicKey(): String? = try {
        encode(certificatePublic())
    } catch (_: Exception) {
        null
    }

    /** The opened notification, or nil. Never throws: a bad envelope is the fallback. */
    fun open(envelope: String): PushCrypto.Opened? = try {
        val ks = keyStore()
        val privateKey = ks.getKey(ALIAS, null) as? PrivateKey ?: return null
        val public = certificatePublic()
        PushCrypto.open(privateKey, uncompressed(public), envelope)
    } catch (_: Exception) {
        null
    }

    private fun certificatePublic(): ECPublicKey {
        val ks = keyStore()
        if (!ks.containsAlias(ALIAS)) {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setUserAuthenticationRequired(false)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(spec)
                generateKeyPair()
            }
        }
        val cert = ks.getCertificate(ALIAS) ?: error("the push key has no public half")
        return cert.publicKey as ECPublicKey
    }

    private fun encode(public: ECPublicKey): String = PushCrypto.b64e(uncompressed(public))

    private fun uncompressed(public: ECPublicKey): ByteArray {
        val w = public.w
        return byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY)
    }

    private fun fixed32(n: java.math.BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
}
