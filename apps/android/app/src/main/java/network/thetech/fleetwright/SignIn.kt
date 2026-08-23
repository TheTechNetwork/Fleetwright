package network.thetech.fleetwright

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/**
 * Signing in, and what the app gets for it.
 *
 * The app used to ask for a token. That token was the fleet's admin
 * credential: the same string on every phone, able to stop every session on
 * every machine, revocable only by rotating it everywhere. Typing it into a
 * phone was also the only way to get it onto one, so it travelled through
 * whatever channel was to hand.
 *
 * Now the phone proves who its owner is to Google, hands the coordinator the
 * resulting ID token, and receives a credential of its own — issued to this
 * device, named after the person holding it, revocable on its own. The ID token
 * is spent immediately and never stored.
 *
 * CREDENTIAL MANAGER, NOT THE OLD GOOGLE SIGN-IN. The `GoogleSignInClient` API
 * this would have used two years ago is deprecated and its replacement is the
 * platform one, which also means the account picker is the system's rather than
 * a screen this app draws — there is no password here to phish.
 */
object SignIn {

    class Failure(message: String) : Exception(message)
    class Cancelled : Exception("cancelled")

    /**
     * The OAuth client id the ID token will be issued for.
     *
     * Looked up by name rather than referenced as R.string.default_web_client_id,
     * and that is deliberate. The google-services plugin only generates that
     * resource when the Firebase project HAS a web OAuth client; referencing it
     * directly would mean this file does not compile in a checkout without
     * Firebase configured — and the repository is public, so that checkout is
     * most of them. This way it is a runtime message instead of a broken build.
     */
    fun serverClientId(context: Context): String? {
        val id = context.resources.getIdentifier("default_web_client_id", "string", context.packageName)
        return if (id == 0) null else context.getString(id).takeIf { it.isNotBlank() }
    }

    /**
     * Ask Google who this is, and return the raw ID token.
     *
     * @param filterByAuthorizedAccounts false: on a fresh install nobody has
     *   authorised this app yet, and filtering to authorised accounts shows an
     *   empty sheet — the classic "the button does nothing" report.
     */
    suspend fun googleIdToken(context: Context): String {
        val clientId = serverClientId(context)
            ?: throw Failure(
                "This build has no Google sign-in configured. It needs a web OAuth client in the " +
                    "Firebase project and a google-services.json that carries it.",
            )

        val request = GetCredentialRequest.Builder()
            .addCredentialOption(
                GetGoogleIdOption.Builder()
                    .setServerClientId(clientId)
                    .setFilterByAuthorizedAccounts(false)
                    .setAutoSelectEnabled(false)
                    .build(),
            )
            .build()

        val response = try {
            CredentialManager.create(context).getCredential(context, request)
        } catch (e: GetCredentialCancellationException) {
            throw Cancelled()
        } catch (e: GetCredentialException) {
            throw Failure(e.message ?: "Google sign-in failed")
        }

        val credential = response.credential
        if (credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            throw Failure("Google returned a credential of an unexpected type")
        }
        return GoogleIdTokenCredential.createFrom(credential.data).idToken
    }
}
