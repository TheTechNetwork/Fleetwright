package network.thetech.fleetwright

import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.PrivateKey
import java.security.PublicKey
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
 * The other half of `src/fleet/push-crypto.js`.
 *
 * A notification is sealed on the coordinator to a key this phone holds, so
 * Google forwards bytes it cannot read. This opens one. The construction is
 * the one in `docs/push-encryption.md`: ECDH on P-256, one HKDF-SHA-256 expand
 * of 44 bytes split into an AES-256 key and a 12-byte nonce, AES-GCM with no
 * additional data. `test/fixtures/parity/push-envelope.json` is one envelope
 * the JavaScript sealed; `PushCryptoTest` opens it, and so does
 * `PushCryptoTests.swift`.
 *
 * java.security and javax.crypto only, so the JVM test runs it. The key the
 * app actually holds is the Android Keystore's (PushKey), and it never leaves.
 */
internal object PushCrypto {
    private val INFO_PREFIX = "fleetwright-push-v1".toByteArray(Charsets.UTF_8)

    data class Opened(val title: String, val body: String, val data: Map<String, String>)

    private val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    /** Open one envelope. Throws on a bad envelope, a bad point, or a tag that does not match. */
    fun open(privateKey: PrivateKey, recipientPublic: ByteArray, envelope: String): Opened {
        val bytes = b64d(envelope)
        require(bytes.size >= 1 + 16 + 65 + 16) { "envelope is too short" }
        require(bytes[0] == 1.toByte()) { "unsupported push envelope version ${bytes[0]}" }
        val salt = bytes.copyOfRange(1, 17)
        val ephemeralRaw = bytes.copyOfRange(17, 82)
        val sealed = bytes.copyOfRange(82, bytes.size)
        require(ephemeralRaw[0] == 4.toByte() && sealed.size > 16) { "envelope is too short" }

        val shared = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(point(ephemeralRaw), true)
            generateSecret()
        }
        val info = INFO_PREFIX + recipientPublic + ephemeralRaw
        // ONE EXPAND, then split. Two derivations would not be the scheme.
        val okm = hkdf(shared, salt, info, 44)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(okm.copyOf(32), "AES"),
            GCMParameterSpec(128, okm.copyOfRange(32, 44)),
        )
        val clear = cipher.doFinal(sealed)
        val obj = JSONObject(String(clear, Charsets.UTF_8))
        val data = HashMap<String, String>()
        obj.optJSONObject("data")?.let { raw ->
            val keys = raw.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (!raw.isNull(key)) data[key] = raw.get(key).toString()
            }
        }
        return Opened(obj.getString("title"), obj.getString("body"), data)
    }

    /** A key pair from its JWK numbers. For the fixture: the app never imports a private key. */
    fun keyPairFromJwk(d: String, x: String, y: String): KeyPair {
        val factory = KeyFactory.getInstance("EC")
        val public = factory.generatePublic(
            ECPublicKeySpec(ECPoint(BigInteger(1, b64d(x)), BigInteger(1, b64d(y))), params),
        )
        val private = factory.generatePrivate(ECPrivateKeySpec(BigInteger(1, b64d(d)), params))
        return KeyPair(public, private)
    }

    /** Uncompressed point, base64url, the form `checkPublicKey` accepts. */
    fun encode(public: PublicKey): String {
        val w = (public as ECPublicKey).w
        return b64e(byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY))
    }

    private fun point(raw: ByteArray): PublicKey {
        require(raw.size == 65 && raw[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        val p = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(p, params))
    }

    /** RFC 5869. T(0) is empty; T(i) = HMAC(PRK, T(i-1) || info || i). */
    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmac(salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            t = hmac(prk, t + info + byteArrayOf(counter.toByte()))
            val n = minOf(t.size, length - offset)
            t.copyInto(out, offset, 0, n)
            offset += n
            counter++
        }
        return out
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    fun b64e(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun b64d(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
}

/**
 * What `onMessageReceived` routes on.
 *
 * A sealed message arrives as `e` and, when it is answerable, a `category` in
 * the clear — iOS reads the category before anything can be decrypted, and
 * Android is sent the same map. The title, the body and `kind` are inside.
 * Opening first is what keeps a setup update from being logged as a session
 * the app did not understand.
 *
 * A seal that does not open becomes the fallback sentence and nothing else.
 * There is no `kind` to misread, and no button to answer a question we did
 * not read. The sentence is the coordinator's (`envelopeFor` in
 * `src/fleet/push.js`), because it is what a person sees in that moment.
 */
internal object PushReveal {
    const val FALLBACK_TITLE = "Fleetwright"
    const val FALLBACK_BODY = "Something needs you. Open to see."

    fun fields(outer: Map<String, String>, open: (String) -> PushCrypto.Opened?): Map<String, String> {
        val envelope = outer["e"] ?: return outer
        val opened = try {
            open(envelope)
        } catch (_: Exception) {
            null
        } ?: return mapOf("title" to FALLBACK_TITLE, "body" to FALLBACK_BODY)
        val merged = LinkedHashMap<String, String>()
        merged.putAll(opened.data)
        outer["category"]?.let { if (!merged.containsKey("category")) merged["category"] = it }
        merged["title"] = opened.title
        merged["body"] = opened.body
        return merged
    }
}
