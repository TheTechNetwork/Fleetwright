import AuthenticationServices
import UIKit

/// A provider authorization that happens inside the app and comes back by
/// itself.
///
/// "Why is update or login two clicks when we can do one in an embedded
/// browser." It was two because the app opened Safari and then had nothing to
/// do but wait: a separate "Done" button existed purely so somebody could tell
/// the app the thing that had already happened. The app was asking the person
/// to be the callback.
///
/// `ASWebAuthenticationSession` is the callback. It opens the page in-app,
/// watches for a redirect to our own scheme, and returns the URL — so the tap
/// that starts the flow is the same tap that finishes it.
///
/// IT IS ALSO THE MORE HONEST BROWSER, which matters more here than the tap
/// does. It shows the real address bar and the padlock, runs outside this
/// app's process, and shares the system cookie jar — so somebody already
/// signed in to GitHub is not asked again, and somebody who is not can see
/// exactly whose page they are typing a password into. A WKWebView would look
/// tidier and would be a login form drawn by the app asking for it, which is
/// the shape of every credential-phishing screen ever built.
///
/// Only for flows that HAVE a callback. A pasted token has no redirect to wait
/// for, so this would open a browser that never returns; that route keeps its
/// numbered steps, which are honest about what it is.
enum WebAuth {

    enum Failure: LocalizedError {
        case cancelled
        case badURL
        case message(String)

        var errorDescription: String? {
            switch self {
            // The person meant it. Reporting a cancellation as an error is how
            // an app makes somebody feel they broke something by changing
            // their mind.
            case .cancelled: return nil
            case .badURL: return "That authorization link could not be opened."
            case .message(let text): return text
            }
        }
    }

    /// Open `url` and wait for it to redirect back to `fleetwright://`.
    ///
    /// - Returns: the callback URL, whose query says whether it worked. The
    ///   app trusts it for nothing except knowing to refresh — a custom scheme
    ///   is unverified and any app may claim it, so the truth is whatever the
    ///   host reports next.
    @MainActor
    static func authorize(_ url: String, scheme: String = "fleetwright") async throws -> URL {
        guard let start = URL(string: url) else { throw Failure.badURL }
        let anchor = PresentationAnchor()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: start, callbackURLScheme: scheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    continuation.resume(throwing: Failure.cancelled)
                } else {
                    continuation.resume(throwing: Failure.message(error?.localizedDescription ?? "The sign-in window closed."))
                }
            }
            session.presentationContextProvider = anchor
            // NOT an ephemeral session. Sharing the system cookie jar is the
            // point: somebody already signed in to GitHub on this phone should
            // not be made to sign in again inside our app, which is both worse
            // for them and one more password prompt of ours to mistake for
            // theirs.
            session.prefersEphemeralWebBrowserSession = false
            // Held by the closure below so the anchor outlives this scope —
            // ASWebAuthenticationSession keeps only a weak reference to its
            // context provider, and a deallocated one is a session that opens
            // and immediately closes.
            anchor.keepAlive = session
            if !session.start() {
                continuation.resume(throwing: Failure.message("This device would not open a sign-in window."))
            }
        }
    }

    /// Where to put the window. `ASWebAuthenticationSession` needs a window to
    /// present from and SwiftUI has no hook that hands one over, so this finds
    /// the active scene's key window the way UIKit expects.
    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        var keepAlive: ASWebAuthenticationSession?

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            return scene?.keyWindow ?? ASPresentationAnchor()
        }
    }
}
