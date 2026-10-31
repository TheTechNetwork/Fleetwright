package network.thetech.fleetwright

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
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
    private const val TAG = "Fleetwright"

    /**
     * The key registration sends, or null when this phone has never sent one
     * and has none it can use now. Never throws.
     *
     * A PHONE THAT HAS SENT A KEY NEVER SENDS NONE AGAIN. The coordinator
     * keeps a key only when the registration sends one (core.js,
     * registerDevice), so a registration without it puts this phone back on
     * plaintext. When the keystore does not answer, or a key from an earlier
     * launch fails its self-test, the registration still goes, with the last
     * key a registration sent ([Settings.pushKeySent]): the FCM address is
     * refreshed, the coordinator keeps sealing, and anything this phone
     * cannot open is the fallback sentence, which still wakes the person.
     *
     * NULL ONLY ON A PHONE THAT HAS NEVER SENT ONE, and then for any of:
     * Android 11; a keystore that will not make an agreement key; a key made
     * in this call that fails the self-test, sealing a probe to it in
     * software and opening it in the keystore (that key is deleted, so the
     * next launch makes a fresh one rather than failing the same way for
     * good); or a keystore error. Nothing was ever sealed to such a phone,
     * so registering it without a key at once loses nothing. Unlike iOS, a
     * reinstall cannot make one of these by accident: allowBackup is off, so
     * the Keystore entry and the record of the key sent go together.
     *
     * A KEY SENT THAT THIS PHONE NO LONGER HOLDS STILL GOES. When the alias
     * is missing and no new key can be made, [fromKeystore] answers null,
     * and with a key sent on record the registration sends that key: sealed
     * and unreadable here, which is better than plaintext. It counts as a
     * failure, so the replacement below keeps being tried, and a fresh key
     * that registers is what heals it.
     *
     * AN ERROR THAT DOES NOT GO AWAY IS NOT A HICCUP, and the fallback would
     * leave every notification on the fallback sentence for good. So the
     * failures are counted in [settings], with the time of the first, two in
     * the same minute counted once, and after [PushKeyRule.ATTEMPTS] of them
     * in a row spread over at least a day the key is replaced ([startOver]).
     * A replacement that fails sends the last key sent too and keeps the
     * count, so the next registration tries again; only a key this phone
     * holds clears it. The rule is [PushKeyRule.choose], the same as
     * `PushKeyRule.choose` in PushCrypto.swift.
     *
     * AND IT IS SAID. A key this phone could not use is kept as
     * [PushKeyRule.Evidence] in [settings], beside what [saw] learns from the
     * notifications themselves, and You says so while it lasts.
     *
     * ONE AT A TIME. The first sign-in registers from MainActivity and from
     * Messaging.onRegistered at once, and on a phone with no key yet each
     * would make one: the second generation replaces the key the first had
     * just sent.
     */
    @Synchronized
    fun forRegistration(settings: Settings): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val sent = settings.pushKeySent
        val now = System.currentTimeMillis()
        val countedJustNow = lastFailureAt?.let { now >= it && now - it < SAME_MOMENT_MS } == true
        val choice = PushKeyRule.choose(
            failures = settings.pushKeyFailures,
            sent = sent,
            now = now,
            countedJustNow = countedJustNow,
            read = { fromKeystore() },
            replace = { startOver() },
        )
        choice.failure?.let { e ->
            when {
                choice.replaced && choice.pushKey != sent -> Log.w(TAG, "push key: registrations have not been able to use it for a day or more, so it was replaced (${e.message})")
                choice.pushKey == null -> Log.w(TAG, "push key: could not use it, and none was ever sent, so this registration sends none (${e.message})")
                choice.replaced -> Log.w(TAG, "push key: it could not be replaced either, so this registration sends the last one sent and the next tries again (${e.message})")
                else -> Log.w(TAG, "push key: could not use it this time, so this registration sends the last one sent (${e.message})")
            }
        }
        when {
            choice.failure == null -> lastFailureAt = null
            !countedJustNow -> lastFailureAt = now
        }
        settings.pushKeyFailures = choice.failures
        settings.pushKeyEvidence = PushKeyRule.afterRegistration(settings.pushKeyEvidence, choice, sent, now)
        // SAVED HERE, BEFORE THE POST, not after its answer: registerDevice
        // posts what this returns. A post the coordinator took whose answer
        // was lost would otherwise leave this phone believing it never sent
        // a key, and free to register without one.
        choice.pushKey?.let { settings.pushKeySent = it }
        return choice.pushKey
    }

    /**
     * When a registration in this process last counted a failure, or null
     * after one that did not fail. MainActivity and Messaging can both
     * register in one launch, and two failures a second apart are one bad
     * moment, not two. A minute, rather than the life of the process: a
     * process can outlive many launches, and one failure per process would
     * hold the count back for as long as it lived. A failure that was not
     * counted leaves it, so failures a few seconds apart cannot chain into a
     * minute that never ends.
     */
    private var lastFailureAt: Long? = null
    private const val SAME_MOMENT_MS = 60_000L

    /**
     * One sealed notification [Messaging] tried to open, sent at [sentAt]
     * (`RemoteMessage.sentTime`). What You says rests on it as well as on the
     * registrations ([PushKeyRule.afterSeal]).
     *
     * DATED BY WHEN IT WAS SENT, NOT WHEN IT ARRIVED. FCM keeps a message up
     * to an hour and Doze can hold it, so one sealed to the key a replacement
     * has just taken the place of can arrive after the registration that sent
     * the new key. Dated by its arrival it would be the newest evidence, and
     * say this phone cannot open what it can; dated by its sending it is older
     * than the registration and changes nothing, and messages held and let go
     * together are read in the order they were sent. The sent time is FCM's
     * clock and the registration's is this phone's, so a phone whose clock is
     * minutes wrong orders the two by that much, and the next notification
     * settles it. A message with no sent time is dated by its arrival, as
     * before.
     */
    @Synchronized
    fun saw(settings: Settings, opened: Boolean, sentAt: Long) {
        val at = if (sentAt > 0) sentAt else System.currentTimeMillis()
        settings.pushKeyEvidence = PushKeyRule.afterSeal(settings.pushKeyEvidence, opened, at)
    }

    private fun fromKeystore(): String? {
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
                // cannot make this kind of key says it with. Null means no
                // key is here: harmless on a phone that never sent one, and
                // a failure PushKeyRule.choose counts on one that did, whose
                // key sent is then known to be gone.
                return null
            }
        }
        // A KEY MADE JUST NOW HAS NEVER BEEN SENT, so nothing it fails at
        // can cost a key the coordinator holds: it goes, and this answers
        // null, which choose treats as above. A key from an earlier launch that cannot be read
        // this time is the hiccup the throw is for.
        return try {
            checked(ks, fresh)
        } catch (e: Exception) {
            if (!fresh) throw e
            runCatching { ks.deleteEntry(ALIAS) }
            null
        }
    }

    /**
     * The key's public half, encoded, once it has opened its own seal; null
     * when a key made in this call cannot. A key from an earlier launch that
     * fails is thrown rather than deleted (PushKeyRule.afterSelfTest says
     * why).
     */
    private fun checked(ks: KeyStore, fresh: Boolean): String? {
        val privateKey = ks.getKey(ALIAS, null) as? PrivateKey ?: throw KeyStoreException("the push key has no private half")
        val public = ks.getCertificate(ALIAS)?.publicKey as? ECPublicKey ?: throw KeyStoreException("the push key has no public half")
        val raw = PushCrypto.uncompressed(public)
        return when (PushKeyRule.afterSelfTest(PushCrypto.opensItsOwnSeal(privateKey, raw, KEYSTORE), madeThisCall = fresh)) {
            PushKeyRule.SelfTest.SEND -> PushCrypto.b64e(raw)
            PushKeyRule.SelfTest.DROP -> {
                runCatching { ks.deleteEntry(ALIAS) }
                null
            }
            PushKeyRule.SelfTest.TRY_AGAIN -> throw KeyStoreException("the push key did not open its own seal")
        }
    }

    /**
     * A new key in place of one the keystore has refused for a day, or null
     * when this phone cannot keep one.
     *
     * NULL HERE IS THE PLATFORM SAYING NO, not a hiccup: the old key has
     * failed for a day, and now the keystore will not delete it, make a new
     * one, or open a seal with the new one. The registration then sends the
     * last key sent, or none on a phone that has never sent one, and keeps
     * the count, so the next registration tries the keystore again from the
     * start. The key sent is then usually one this phone no longer holds.
     */
    private fun startOver(): String? = try {
        keyStore().deleteEntry(ALIAS)
        fromKeystore()
    } catch (_: Exception) {
        null
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
