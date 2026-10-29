package network.thetech.fleetwright

import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStoreException
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
 * app actually holds is the Android Keystore's (PushKey), and it never leaves:
 * the agreement is asked of the provider that holds it, named, rather than of
 * whichever provider the platform would pick for a key it cannot read.
 *
 * IT SEALS AS WELL, for one reason: the self-test registration runs before
 * it sends a key ([opensItsOwnSeal]). Nothing else on the phone seals a
 * notification, and nothing should.
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

    /**
     * Open one envelope. Throws on a bad envelope, a bad point, or a tag that
     * does not match.
     *
     * @param provider the JCA provider that holds [privateKey]: "AndroidKeyStore"
     *   for the app's key, null for a key in memory (the tests, the self-test's
     *   own check that the scheme round-trips).
     */
    fun open(privateKey: PrivateKey, recipientPublic: ByteArray, envelope: String, provider: String? = null): Opened {
        val bytes = b64d(envelope)
        require(bytes.size >= 1 + 16 + 65 + 16) { "envelope is too short" }
        require(bytes[0] == 1.toByte()) { "unsupported push envelope version ${bytes[0]}" }
        val salt = bytes.copyOfRange(1, 17)
        val ephemeralRaw = bytes.copyOfRange(17, 82)
        val sealed = bytes.copyOfRange(82, bytes.size)
        require(ephemeralRaw[0] == 4.toByte() && sealed.size > 16) { "envelope is too short" }

        val shared = agree(privateKey, point(ephemeralRaw), provider)
        // ONE EXPAND, then split. Two derivations would not be the scheme.
        val okm = hkdf(shared, salt, INFO_PREFIX + recipientPublic + ephemeralRaw, 44)
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

    /**
     * Seal a title and a body to a public key, as `sealTo` does: a fresh
     * ephemeral key and a fresh salt every time, in software.
     */
    fun seal(recipientPublic: ByteArray, title: String, body: String): String {
        val recipient = point(recipientPublic)
        val ephemeral = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        val ephemeralRaw = uncompressed(ephemeral.public as ECPublicKey)
        val shared = agree(ephemeral.private, recipient, null)
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val okm = hkdf(shared, salt, INFO_PREFIX + recipientPublic + ephemeralRaw, 44)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(okm.copyOf(32), "AES"),
            GCMParameterSpec(128, okm.copyOfRange(32, 44)),
        )
        val clear = JSONObject().put("title", title).put("body", body).put("data", JSONObject()).toString()
        return b64e(byteArrayOf(1) + salt + ephemeralRaw + cipher.doFinal(clear.toByteArray(Charsets.UTF_8)))
    }

    /**
     * The self-test: seal a probe to [recipientPublic] in software, open it
     * with [privateKey] through [provider].
     *
     * TRUE, FALSE, OR A THROW. False is "this key did not open it": no such
     * algorithm or provider, a key the provider will not agree with, a tag
     * that does not match, a probe that came back different. A throw is a
     * keystore that did not answer this time (KeyStoreException, or a
     * ProviderException from the daemon): no registration at all, and the
     * next launch tries again.
     *
     * FALSE IS NOT ALWAYS "THIS PHONE CANNOT", and what registration does
     * with it depends on how old the key is ([PushKeyRule.afterSelfTest]).
     */
    fun opensItsOwnSeal(privateKey: PrivateKey, recipientPublic: ByteArray, provider: String?): Boolean {
        val probe = "fleetwright-push-self-test"
        return try {
            val opened = open(privateKey, recipientPublic, seal(recipientPublic, probe, probe), provider)
            opened.title == probe && opened.body == probe
        } catch (e: KeyStoreException) {
            throw e
        } catch (_: GeneralSecurityException) {
            false
        } catch (_: UnsupportedOperationException) {
            false
        }
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
    fun encode(public: PublicKey): String = b64e(uncompressed(public as ECPublicKey))

    /** 0x04 || X || Y, each coordinate padded to 32 bytes. */
    fun uncompressed(public: ECPublicKey): ByteArray {
        val w = public.w
        return byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY)
    }

    private fun agree(privateKey: PrivateKey, peer: PublicKey, provider: String?): ByteArray {
        val agreement = if (provider == null) KeyAgreement.getInstance("ECDH") else KeyAgreement.getInstance("ECDH", provider)
        agreement.init(privateKey)
        agreement.doPhase(peer, true)
        return agreement.generateSecret()
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
 * Android is sent the same map. The title, the body, `kind` and a second copy
 * of the category are inside. Opening first is what keeps a setup update from
 * being logged as a session the app did not understand.
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
        merged.remove("category")
        category(opened.data["category"], outer["category"].orEmpty())
            .takeIf { it.isNotEmpty() }
            ?.let { merged["category"] = it }
        merged["title"] = opened.title
        merged["body"] = opened.body
        return merged
    }

    /**
     * Which buttons an opened notification gets: a category, or "" for none.
     *
     * THE SEALED ONE DECIDES. The clear one is what Google or a relay could
     * have changed; the buttons' words come from the category and the digits
     * they type from the envelope, so a changed one would label one answer as
     * the other. When the clear one is there and disagrees, there are no
     * buttons, and the notification is posted without them.
     *
     * [sealed] IS NULL ONLY FROM A COORDINATOR THAT PREDATES SEALING IT, and
     * then the clear one is all there is, as it always was. A coordinator that
     * seals it always writes it, "" when there is nothing to answer. The same
     * rule as `PushCrypto.category` in PushCrypto.swift.
     */
    fun category(sealed: String?, clear: String): String {
        if (sealed == null) return clear
        if (clear.isNotEmpty() && clear != sealed) return ""
        return sealed
    }
}

/**
 * What registration does when the push key fails, decided without the
 * keystore so the JVM test can hold it to the rule. PushKey does the keystore
 * half. `PushKeyRule` in PushCrypto.swift is the same rule on iOS, with the
 * same numbers; iOS has no [afterSelfTest], because its self-test runs in
 * memory and has no daemon to miss, so any failure of it counts there.
 */
internal object PushKeyRule {
    const val ATTEMPTS = 3
    const val SPAN_MS = 24L * 60 * 60 * 1000

    enum class SelfTest { SEND, DROP, TRY_AGAIN }

    /**
     * What a self-test result costs.
     *
     * A KEY MADE IN THIS CALL that fails is dropped, and the phone registers
     * without one: it has never been sent, so nothing at the coordinator is
     * sealed to it.
     *
     * A KEY FROM AN EARLIER LAUNCH THAT FAILS IS KEPT, and the registration
     * sends the last key sent ([choose]). It is the key the coordinator
     * seals to, and
     * "false" cannot tell a key the keystore will never agree with from a
     * keystore that did not answer: AOSP's keystore2 reports a daemon that
     * failed at KeyAgreement.init as an InvalidKeyException wrapping
     * android.security.KeyStoreException, which is a GeneralSecurityException
     * like any refusal. Dropping it on that would register this phone
     * without a key over one bad moment and orphan every notification sealed
     * to it. One that really is broken fails every launch, and [startOver]
     * replaces it.
     */
    fun afterSelfTest(opened: Boolean, madeThisCall: Boolean): SelfTest = when {
        opened -> SelfTest.SEND
        madeThisCall -> SelfTest.DROP
        else -> SelfTest.TRY_AGAIN
    }

    /** Registrations in a row the key failed, and when the first was (epoch milliseconds). */
    data class Failures(val count: Int, val firstAt: Long)

    /**
     * The count after one more failure at [now]. A clock that has gone
     * backwards starts it again rather than waiting for it to catch up.
     */
    fun failed(before: Failures?, now: Long): Failures =
        if (before == null || before.count <= 0 || now < before.firstAt) Failures(1, now)
        else Failures(before.count + 1, before.firstAt)

    /**
     * Whether the key goes and a new one is made.
     *
     * THREE REGISTRATIONS IN A ROW, THE FIRST A DAY OR MORE BEFORE THE LAST.
     * Either alone is too little: three in a minute is one bad moment (and
     * a launch here can register twice, from MainActivity and from
     * Messaging), and one failure a day ago may have been the only launch
     * since. A key that has failed on both counts is not coming back, and
     * every day it stays is a day every notification is the fallback
     * sentence.
     */
    fun startOver(failures: Failures, now: Long): Boolean =
        failures.count >= ATTEMPTS && now - failures.firstAt >= SPAN_MS

    /** What one registration decided. */
    class Choice(
        /** The key it sends: null only on a phone that has never sent one. */
        val pushKey: String?,
        /** The count to store, null once a registration got as far as a key. */
        val failures: Failures?,
        /** Why the stored key could not be used, when it could not. */
        val failure: Exception?,
        /** Whether the stored key was replaced this time. */
        val replaced: Boolean,
    )

    /**
     * The key a registration sends.
     *
     * [read] is the stored key's public half, null when this phone cannot
     * make one, and throws when the key cannot be used this time; [replace]
     * makes a new one, or null when it cannot; [sent] is the last key a
     * registration sent. A KEY ERROR NEVER MEANS NO KEY once one has been
     * sent: [sent] goes instead, before the threshold, and after it when the
     * replacement fails too. [countedThisLaunch] keeps a second failure in
     * the same launch from counting again.
     */
    fun choose(
        failures: Failures?,
        sent: String?,
        now: Long,
        countedThisLaunch: Boolean,
        read: () -> String?,
        replace: () -> String?,
    ): Choice {
        val key = try {
            read()
        } catch (e: Exception) {
            val after = if (countedThisLaunch && failures != null) failures else failed(failures, now)
            if (!startOver(after, now)) return Choice(sent, after, e, replaced = false)
            return Choice(replace() ?: sent, null, e, replaced = true)
        }
        return Choice(key ?: sent, null, null, replaced = false)
    }
}
