import AuthenticationServices
import Foundation

/// Signing in, and what the app gets for it.
///
/// The app used to ask for a token. That token was the fleet's admin
/// credential: the same string on every phone, able to stop every session on
/// every machine, revocable only by rotating it everywhere. Typing it into a
/// phone was also the only way to get it onto one, so it travelled through
/// whatever channel was to hand.
///
/// Now the phone proves who its owner is to Apple, hands the coordinator the
/// resulting ID token, and receives a credential of its own — issued to this
/// device, named after the person holding it, revocable on its own. The ID
/// token is spent immediately and never stored.
///
/// WHY APPLE AND NOT A PASSWORD. There is no account here to have a password
/// for. The coordinator has no users table and does not want one — it checks a
/// verified email against a list. Apple already holds the identity, the phone
/// already holds the key that unlocks it, and Face ID is a better gate than
/// anything this app could build.
///
/// The button itself is SwiftUI's `SignInWithAppleButton`, which owns the
/// controller, the presentation anchor and the delegate. Writing that by hand
/// is about eighty lines whose only distinguishing feature is the several ways
/// they can silently never call back.
enum SignIn {

    enum Failure: LocalizedError {
        case cancelled
        case noToken
        case message(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: return nil // the user meant it; saying so is noise
            case .noToken: return "Apple returned no identity token."
            case .message(let text): return text
            }
        }
    }

    /// What to ask Apple for.
    ///
    /// Email is the whole of what the coordinator checks. Without this scope
    /// the token carries none and the sign-in cannot succeed, so it is
    /// requested even though the app never displays a name.
    static func configure(_ request: ASAuthorizationAppleIDRequest) {
        request.requestedScopes = [.email, .fullName]
    }

    /// The raw ID token out of whatever the button handed back.
    static func identityToken(from result: Result<ASAuthorization, Error>) throws -> String {
        switch result {
        case .failure(let error):
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                throw Failure.cancelled
            }
            throw Failure.message(error.localizedDescription)
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let data = credential.identityToken,
                  let token = String(data: data, encoding: .utf8)
            else { throw Failure.noToken }
            return token
        }
    }
}
