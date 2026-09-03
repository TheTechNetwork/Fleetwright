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
    /**
     * The web OAuth client this app names as its server.
     *
     * READ FROM BuildConfig, not from a string resource. This used to be
     *
     *     resources.getIdentifier("default_web_client_id", "string", context.packageName)
     *
     * which is the line every tutorial has, and which was broken on BOTH build
     * types for two unrelated reasons. Worth writing both down, because fixing
     * either one alone leaves the app still saying "this build has no Google
     * sign-in configured" — a Firebase problem that never existed.
     *
     *  RELEASE — isShrinkResources. The only reference to that string was this
     *  runtime lookup, which the resource shrinker cannot see, so it stripped
     *  the resource. Measured in the Play beta APK: `google_api_key`,
     *  `gcm_defaultSenderId`, `project_id` and `google_app_id` are all in
     *  resources.arsc because the Firebase SDK references them statically, and
     *  `default_web_client_id` is not there at all. THIS IS THE ONE THAT
     *  REACHED PEOPLE.
     *
     *  DEBUG — applicationIdSuffix. Resources are compiled under the
     *  `namespace`; the debug applicationId is namespace + ".debug"; so the
     *  lookup asked a package with no resources and got 0.
     *
     * A BuildConfig field is a compile-time constant inlined into the code, so
     * it is immune to both: there is no resource to strip and no package to
     * resolve. Verified in a release APK built from the fix — the client id
     * appears in classes.dex, and the resource is still (correctly) absent.
     *
     * See app/build.gradle.kts, which reads it out of google-services.json.
     */
    fun serverClientId(): String? {
        // NOT AN UNNECESSARY SAFE CALL, whatever the compiler says about it.
        //
        // AGP declares BuildConfig fields non-null, so Kotlin believes this
        // cannot be null. build.gradle.kts emits the literal `null` when there
        // is no google-services.json — deliberately, so a fork building without
        // Firebase gets a clear refusal at the button rather than a sign-in
        // attempt with an empty client id.
        //
        // So the warning is Kotlin's type information being wrong, not this
        // code. Deleting the `?.` to silence it would turn a working refusal
        // into a NullPointerException on exactly the builds the null exists
        // for — and those are the builds nobody here runs, which is how it
        // would have shipped.
        //
        // The explicit nullable type is the honest fix: it tells Kotlin what
        // the field can actually hold.
        val configured: String? = BuildConfig.GOOGLE_WEB_CLIENT_ID
        return configured?.takeIf { it.isNotBlank() }
    }

    /**
     * Ask Google who this is, and return the raw ID token.
     *
     * @param filterByAuthorizedAccounts false: on a fresh install nobody has
     *   authorised this app yet, and filtering to authorised accounts shows an
     *   empty sheet — the classic "the button does nothing" report.
     */
    suspend fun googleIdToken(context: Context): String {
        val clientId = serverClientId()
            ?: throw Failure(
                // NAMES THE BUILD. This message has now been reported twice
                // about two different builds with two different causes, and
                // neither report could say which build it was — because
                // nothing in the app could. A refusal that identifies itself
                // turns the next report into an answer.
                "Build ${BuildConfig.VERSION_CODE} has no Google sign-in configured — it was built " +
                    "without a google-services.json carrying a web OAuth client (client_type 3). " +
                    "Sign in with Apple instead.",
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
