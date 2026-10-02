import CryptoKit
import Foundation
import Security

/// An OAuth sign-in this phone runs itself, up to the code, for the minting
/// Worker to finish: the phone's own GitHub sign-in (PhoneGitHub) and a GitHub
/// or Cloudflare sign-in kept in the person's vault (PhoneVault).
/// DeviceSignIn.kt is the same thing on Android.
///
/// The phone makes the PKCE verifier and a state beginning `d.`, opens the
/// provider's own page in `WebAuth`, and takes the coordinator's callback
/// back at `fleetwright://<host>`. It checks the state is the one it made,
/// because a custom scheme is anybody's to send. The code is no use without
/// the verifier, which goes to the minter sealed and nowhere else.
enum DeviceSignIn {
    struct Back {
        let code: String
        let verifier: String
        let redirectUri: String
    }

    /// - Parameters:
    ///   - host: which `fleetwright://` host the answer comes back on, `github` or `cloudflare`
    ///   - extra: query items the provider wants beside the PKCE ones, such as Cloudflare's scopes
    @MainActor
    static func run(authorize: String, clientId: String, redirectUri: String, statePrefix: String,
                    host: String, extra: [URLQueryItem] = []) async throws -> Back {
        let verifier = randomToken(32)
        let state = statePrefix + randomToken(24)
        let challenge = Seal.b64(Data(SHA256.hash(data: Data(verifier.utf8))))
        guard var url = URLComponents(string: authorize) else { throw WebAuth.Failure.badURL }
        url.queryItems = extra + [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let page = url.url else { throw WebAuth.Failure.badURL }
        let back = try await WebAuth.authorize(page.absoluteString)
        let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? { items.first { $0.name == name }?.value }
        // A custom scheme is unverified, so the state is what says this is the
        // answer to THIS sign-in rather than something another app sent.
        guard back.host == host, item("state") == state else {
            throw FleetError.message("The sign-in came back with an answer to a different one, so it was not used.")
        }
        guard let code = item("code"), !code.isEmpty else { throw FleetError.message("The sign-in came back without a code.") }
        return Back(code: code, verifier: verifier, redirectUri: redirectUri)
    }

    private static func randomToken(_ bytes: Int) -> String {
        var raw = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &raw)
        return Seal.b64(Data(raw))
    }
}
