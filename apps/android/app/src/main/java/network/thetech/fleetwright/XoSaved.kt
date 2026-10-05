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
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume

/**
 * What this phone remembers about reaching a Xen Orchestra pool, so the next
 * change starts where the last one worked instead of from nothing. The same
 * design as XOSaved.swift.
 *
 * TWO THINGS, KEPT APART BECAUSE ONLY ONE IS A SECRET.
 *
 * The machine that last got through, by address, in plain preferences. It is
 * a host name Machines already shows, and it is what is asked first: the
 * screen opens on that machine and asks every machine only when it cannot
 * get through (docs/hypervisors.md, "The path it used last").
 *
 * The admin sign-in and the person's acceptance of the certificate, only when
 * they tick "Keep on this phone", encrypted under a Keystore key of its own
 * that works only right after a strong fingerprint or face check: not the
 * fleet credential's key, which stays usable on a locked phone so a
 * notification can be answered. Per-use authentication, and invalidated when
 * a fingerprint or face is added, so a new one cannot open the old item. The
 * acceptance is kept as the fingerprint that was accepted (or plain HTTP for
 * an address with no certificate), so it stands for that certificate and no
 * other.
 *
 * ENCRYPTING NEEDS THE FINGERPRINT TOO. A key that needs a check for every
 * use needs it to encrypt as well as to decrypt, so the item is sealed when
 * the person presses the button that sends the sign-in, and only the
 * ciphertext waits in memory until the machine has signed in with it. iOS
 * writes without asking and asks only to read; the words on screen are the
 * same.
 *
 * THE FLEET NEVER SEES ANY OF IT. What leaves the phone is what always left
 * it: the sign-in sealed to one job's key on one machine (HypervisorSheet).
 */
internal object XoSaved {
    private const val KEY_ALIAS = "fleetwright.xo-saved"

    /** What a person chose to keep for one address. */
    data class Entry(val email: String?, val password: String?, val acceptedPin: String?, val acceptedPlain: Boolean) {
        val hasLogin: Boolean get() = !email.isNullOrBlank() && !password.isNullOrEmpty()
        val hasAcceptance: Boolean get() = acceptedPin != null || acceptedPlain

        /**
         * Whether this acceptance is for what that machine found: the same
         * fingerprint, or plain HTTP both times. Anything else is a
         * different server as far as the person's word goes.
         */
        fun accepts(probe: Fleet.Probe): Boolean {
            val cert = probe.cert
            if (cert != null) return acceptedPin == cert
            return XoSetup.plain(probe) && acceptedPlain
        }

        fun toJson(): String = JSONObject()
            .put("v", 1)
            .put("email", email ?: JSONObject.NULL)
            .put("password", password ?: JSONObject.NULL)
            .put("pin", acceptedPin ?: JSONObject.NULL)
            .put("plain", acceptedPlain)
            .toString()

        companion object {
            fun fromJson(text: String): Entry? = runCatching {
                val o = JSONObject(text)
                fun opt(name: String) = if (o.isNull(name)) null else o.optString(name).takeIf { it.isNotEmpty() }
                Entry(opt("email"), opt("password"), opt("pin"), o.optBoolean("plain", false))
            }.getOrNull()
        }
    }

    // --- The machine that got through ----------------------------------------

    fun machine(settings: Settings, address: String): String? = runCatching {
        JSONObject(settings.xoVia.ifBlank { "{}" }).optString(address).takeIf { it.isNotBlank() }
    }.getOrNull()

    fun rememberMachine(settings: Settings, address: String, hostId: String) {
        val all = runCatching { JSONObject(settings.xoVia.ifBlank { "{}" }) }.getOrDefault(JSONObject())
        settings.xoVia = all.put(address, hostId).toString()
    }

    // --- The sign-in, behind a fingerprint or face ---------------------------

    /**
     * A strong fingerprint or face is enrolled, so the item can be made.
     * False means the screen does not offer to keep anything (C-2).
     */
    fun available(context: Context): Boolean = runCatching {
        context.getSystemService(BiometricManager::class.java)
            ?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }.getOrDefault(false)

    fun has(settings: Settings, address: String): Boolean = settings.xoSaved(address) != null

    /**
     * The entry, encrypted after a fingerprint or face check, as iv:ct; or
     * null when the person cancelled, the check failed, or the key could not
     * be made. Only the ciphertext is returned, so it can wait in memory.
     */
    suspend fun seal(context: Context, entry: Entry, address: String): String? {
        val cipher = runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        }.getOrElse {
            if (it is KeyPermanentlyInvalidatedException) dropKey()
            return null
        }
        val done = authenticate(context, cipher, "Keep the Xen Orchestra sign-in", address) ?: return null
        return runCatching {
            val body = done.doFinal(entry.toJson().toByteArray())
            Base64.encodeToString(done.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(body, Base64.NO_WRAP)
        }.getOrNull()
    }

    /** Write what [seal] made, once the machine has signed in with it. */
    fun keep(settings: Settings, address: String, sealed: String) = settings.putXoSaved(address, sealed)

    /**
     * Open what was kept, after a fingerprint or face check. Null when the
     * person cancels or nothing is kept. A key retired by a new fingerprint
     * takes the item with it: it can never open again.
     */
    suspend fun unlock(context: Context, settings: Settings, address: String): Entry? {
        val stored = settings.xoSaved(address) ?: return null
        val parts = stored.split(":", limit = 2)
        if (parts.size != 2) {
            forget(settings, address)
            return null
        }
        val cipher = runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            }
        }.getOrElse {
            if (it is KeyPermanentlyInvalidatedException) {
                dropKey()
                forget(settings, address)
            }
            return null
        }
        val done = authenticate(context, cipher, "Sign in to Xen Orchestra", address) ?: return null
        return runCatching { Entry.fromJson(String(done.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)))) }.getOrNull()
    }

    fun forget(settings: Settings, address: String) = settings.putXoSaved(address, "")

    /** The system's own prompt, with the cipher it unlocks; null for cancelled or failed. */
    private suspend fun authenticate(context: Context, cipher: Cipher, title: String, address: String): Cipher? =
        suspendCancellableCoroutine { cont ->
            val signal = CancellationSignal()
            cont.invokeOnCancellation { signal.cancel() }
            val prompt = BiometricPrompt.Builder(context)
                .setTitle(title)
                .setSubtitle(address)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButton("Cancel", context.mainExecutor) { _, _ -> if (cont.isActive) cont.resume(null) }
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

                        // A face that did not match is retried by the prompt
                        // itself; only an error ends it.
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (cont.isActive) cont.resume(null)
                        }
                    },
                )
            }.onFailure { if (cont.isActive) cont.resume(null) }
        }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // EVERY USE, AFTER A STRONG CHECK, and gone with a new
                // fingerprint or face: what makes this item behind them.
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun dropKey() {
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS) }
    }
}
