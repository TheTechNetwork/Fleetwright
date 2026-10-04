package network.thetech.fleetwright

import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Sealing a message to the fleet's minting Worker, and opening one it sealed
 * back: src/fleet/seal.js, on the phone.
 *
 * WHY THE PHONE NEEDS IT. Two things leave this phone that the coordinator in
 * the middle must not be able to read: a GitHub sign-in on its way to be
 * finished, and a Claude login on its way to be kept. Both are sealed to the
 * minter's key, which the person pinned, and the answer to the first comes
 * back sealed to a key this phone made for that one request.
 *
 * THE SAME CONSTRUCTION, BYTE FOR BYTE: ECDH on P-256, HKDF-SHA-256 with the
 * two public keys as salt and "fleetwright-mint/v1" as info, AES-256-GCM with
 * the purpose of the message as additional data. test/fixtures/parity/seal.json
 * is one message sealed by the JavaScript with every random value written
 * down; SealTest.kt seals the same plaintext with the same values and must
 * get the same ciphertext, and seal-parity.test.js opens the fixture with
 * seal.js. Nothing here is a design of its own.
 *
 * java.security and javax.crypto only, as the credential store already uses,
 * and java.util.Base64 rather than android.util so the JVM tests run it.
 */
internal object Seal {
    private const val INFO = "fleetwright-mint/v1"

    /** What a Claude login is sealed under on its way to the minter. */
    const val DEPOSIT_AAD = "fleetwright-claude-deposit/v1"

    /** A GitHub sign-in or renewal on its way to the minter. */
    const val GITHUB_REQUEST_AAD = "fleetwright-github-request/v1"

    /** The GitHub token the minter got for this phone, on its way back. */
    const val GITHUB_REPLY_AAD = "fleetwright-github-reply/v1"

    /** A request to the person's vault (PhoneVault), on its way to the minter. */
    const val VAULT_REQUEST_AAD = "fleetwright-vault-request/v1"

    /** The vault's answer, on its way back to the key this phone made for it. */
    const val VAULT_REPLY_AAD = "fleetwright-vault-reply/v1"

    /** A Claude token one of your machines made with `claude setup-token`, on its way back to this phone's key. */
    const val SETUP_TOKEN_AAD = "fleetwright-setup-token/v1"

    /** An uncompressed P-256 public key, base64url without padding: 87 characters. */
    val KEY_RE = Regex("^[A-Za-z0-9_-]{87}$")

    /** A key this phone made for one request; the private half never leaves memory. */
    class OneUseKey(val privateKey: PrivateKey, val publicKey: String)

    private val random = SecureRandom()

    private val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    fun newKey(): OneUseKey {
        val pair = newPair()
        return OneUseKey(pair.private, encode(pair.public))
    }

    /** Seal [payload] so that only the holder of [to]'s private half can read it. */
    fun seal(to: String, aad: String, payload: JSONObject): JSONObject =
        seal(to, aad, payload.toString().toByteArray(Charsets.UTF_8))

    /**
     * The bytes version, with the two random values as parameters so the
     * fixture can fix them. Every caller in the app leaves them to default.
     */
    fun seal(
        to: String,
        aad: String,
        plaintext: ByteArray,
        ephemeral: KeyPair = newPair(),
        iv: ByteArray = ByteArray(12).also { random.nextBytes(it) },
    ): JSONObject {
        val recipient = decodePublic(to)
        val epk = encode(ephemeral.public)
        val key = aeadKey(ephemeral.private, recipient, b64d(epk) + b64d(to))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        val ct = cipher.doFinal(plaintext)
        return JSONObject().put("epk", epk).put("iv", b64e(iv)).put("ct", b64e(ct))
    }

    /** Open what the minter sealed to [key]. Throws on anything that does not open. */
    fun open(key: OneUseKey, aad: String, sealed: JSONObject): JSONObject {
        val epk = sealed.optString("epk")
        val iv = b64d(sealed.optString("iv"))
        val ct = b64d(sealed.optString("ct"))
        require(iv.size == 12 && ct.isNotEmpty()) { "not a sealed message" }
        val aes = aeadKey(key.privateKey, decodePublic(epk), b64d(epk) + b64d(key.publicKey))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aes, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return JSONObject(String(cipher.doFinal(ct), Charsets.UTF_8))
    }

    /** A key pair from its JWK numbers. For the fixture: the app never imports a private key. */
    fun keyPairFromJwk(d: String, x: String, y: String): KeyPair {
        val factory = KeyFactory.getInstance("EC")
        val public = factory.generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, b64d(x)), BigInteger(1, b64d(y))), params))
        val private = factory.generatePrivate(ECPrivateKeySpec(BigInteger(1, b64d(d)), params))
        return KeyPair(public, private)
    }

    private fun newPair(): KeyPair =
        KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"), random)
            generateKeyPair()
        }

    /** ECDH, then HKDF-SHA-256 to one 32-byte AES key. */
    private fun aeadKey(private: PrivateKey, public: PublicKey, salt: ByteArray): ByteArray {
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(private)
            doPhase(public, true)
            generateSecret()
        }
        val prk = hmac(salt, shared)
        // One block of HKDF-Expand is the whole key: T(1) = HMAC(PRK, info || 0x01).
        return hmac(prk, INFO.toByteArray(Charsets.UTF_8) + byteArrayOf(1)).copyOf(32)
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    private fun decodePublic(raw: String): PublicKey {
        require(KEY_RE.matches(raw)) { "not a P-256 public key" }
        val bytes = b64d(raw)
        require(bytes.size == 65 && bytes[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        val point = ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
    }

    private fun encode(public: PublicKey): String {
        val w = (public as ECPublicKey).w
        return b64e(byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY))
    }

    /** A coordinate as exactly 32 bytes: BigInteger drops leading zeros and may add a sign byte. */
    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun b64e(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun b64d(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
}
