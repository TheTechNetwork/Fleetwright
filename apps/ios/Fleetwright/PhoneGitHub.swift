import CryptoKit
import Foundation
import Security

/// This phone's own GitHub sign-in, and the two things it is for: starting a
/// runner with no permanent box in the fleet, and keeping your Claude login for
/// your runners. PhoneGitHub.kt is the same thing on Android.
///
/// WHY THE PHONE SIGNS IN AT ALL. A runner is started by a GitHub workflow
/// dispatch, and whoever makes the dispatch is who GitHub says started it,
/// which decides whose repository tokens and whose Claude login the runner is
/// given. That used to be a permanent box, with your GitHub connection. Now it
/// can be this phone, with its own.
///
/// HOW, WITHOUT ANYTHING IN THE MIDDLE SEEING THE TOKEN:
///  1. The phone makes a PKCE verifier and a state, and opens GitHub's own page
///     in `WebAuth` with the App's public client id.
///  2. GitHub sends the browser to the coordinator's callback, which hands the
///     code back to this app. The code is no use without the verifier.
///  3. The phone seals the code and the verifier to the minting Worker's key
///     (the pin you saved), and a key of its own for the answer. The minter,
///     which holds the App's client secret, makes the exchange with GitHub and
///     seals the token back. The coordinator relays two ciphertexts.
/// Renewal, every eight hours, is the same with the refresh token.
///
/// The token lives in `Settings.githubSignIn`, in the keychain beside this
/// device's fleet credential.
struct PhoneGitHub {
    let settings: Settings

    /// What is stored, decoded. Nil when this phone has not signed in.
    struct SignIn: Codable {
        let accessToken: String
        let expiresAt: Double?
        let refreshToken: String?
        let refreshExpiresAt: Double?
        let login: String?
    }

    var signIn: SignIn? {
        guard !settings.githubSignIn.isEmpty else { return nil }
        return try? JSONDecoder().decode(SignIn.self, from: Data(settings.githubSignIn.utf8))
    }

    var signedIn: Bool { signIn != nil }

    func signOut() { settings.githubSignIn = "" }

    /// Is `pin` the key the fleet's minter really has? The fleet says what its
    /// key is, and that is only worth comparing with: a pin is what whoever
    /// runs the fleet told you, by some route that is not the fleet. A
    /// coordinator offering a different key is exactly how somebody would read
    /// what this phone seals.
    func checkPin(_ fleet: Fleet, pin: String) async throws -> String {
        let p = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Seal.isKey(p) else { throw Seal.Failure.notAKey }
        let said = try await fleet.claudeLoginKey()
        guard said.ok == true, let key = said.key, !key.isEmpty else {
            throw FleetError.message(said.text ?? "The fleet did not say which key its minter has.")
        }
        guard key == p else {
            throw FleetError.message("The fleet's minter has a different key from the one you were given, so nothing was saved. Ask whoever runs your fleet.")
        }
        settings.minterPin = p
        return "Saved. This phone seals only to that key."
    }

    /// Sign in to GitHub on this phone. Opens GitHub's page; returns once it comes back.
    @MainActor
    func signInWith(_ fleet: Fleet) async throws -> String {
        let pin = settings.minterPin
        guard !pin.isEmpty else { throw FleetError.message("Save your minter key first. Whoever runs your fleet has it.") }
        let start = try await fleet.githubDeviceStart()
        guard start.ok == true, let clientId = start.clientId, let redirectUri = start.redirectUri else {
            throw FleetError.message(start.text ?? "The fleet cannot start a GitHub sign-in.")
        }
        let verifier = Self.randomToken(32)
        let state = (start.statePrefix ?? "d.") + Self.randomToken(24)
        let challenge = Seal.b64(Data(SHA256.hash(data: Data(verifier.utf8))))
        var url = URLComponents(string: "https://github.com/login/oauth/authorize")!
        url.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        let back = try await WebAuth.authorize(url.url!.absoluteString)
        let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? { items.first { $0.name == name }?.value }
        // A custom scheme is unverified, so the state is what says this is the
        // answer to THIS sign-in rather than something another app sent.
        guard back.host == "github", item("state") == state else {
            throw FleetError.message("GitHub came back with an answer to a different sign-in, so it was not used.")
        }
        guard let code = item("code"), !code.isEmpty else { throw FleetError.message("GitHub came back without a code.") }
        return try await finish(fleet, pin: pin, request: [
            "grant": "code", "code": code, "verifier": verifier, "redirectUri": redirectUri,
        ])
    }

    /// A token that is good now, renewed through the minter when it is close to expiring.
    func accessToken(_ fleet: Fleet) async throws -> String {
        guard let held = signIn else { throw FleetError.message("Sign in to GitHub on this phone first.") }
        guard let expires = held.expiresAt else { return held.accessToken }
        if expires - Date().timeIntervalSince1970 * 1000 > 5 * 60_000 { return held.accessToken }
        guard let refresh = held.refreshToken else { throw FleetError.message("Your GitHub sign-in has expired. Sign in again.") }
        let pin = settings.minterPin
        guard !pin.isEmpty else { throw FleetError.message("Save your minter key first.") }
        _ = try await finish(fleet, pin: pin, request: ["grant": "refresh", "refreshToken": refresh])
        guard let renewed = signIn?.accessToken else { throw FleetError.message("Your GitHub sign-in could not be renewed. Sign in again.") }
        return renewed
    }

    /// Seal a request to the minter, relay it, open the answer, keep it.
    private func finish(_ fleet: Fleet, pin: String, request: [String: Any]) async throws -> String {
        let reply = Seal.newKey()
        var body = request
        body["v"] = 1
        body["reply"] = reply.publicKey
        body["at"] = Int(Date().timeIntervalSince1970 * 1000)
        let sealed = try Seal.seal(to: pin, aad: Seal.githubRequestAAD, payload: body)
        let answer = try await fleet.githubDeviceToken(sealed: sealed)
        guard answer["ok"] as? Bool == true, let box = answer["sealed"] as? [String: Any] else {
            throw FleetError.message(answer["text"] as? String ?? "The fleet refused the GitHub sign-in.")
        }
        let token = try Seal.open(reply, aad: Seal.githubReplyAAD, sealed: box)
        guard let access = token["accessToken"] as? String else { throw Seal.Failure.notSealed }
        let login = token["login"] as? String ?? ""
        let kept = SignIn(
            accessToken: access,
            expiresAt: token["expiresAt"] as? Double,
            refreshToken: token["refreshToken"] as? String,
            refreshExpiresAt: token["refreshExpiresAt"] as? Double,
            login: login
        )
        settings.githubSignIn = String(decoding: try JSONEncoder().encode(kept), as: UTF8.self)
        return login.isEmpty ? "Signed in to GitHub." : "Signed in to GitHub as \(login)."
    }

    /// Start a runner from this phone: the coordinator mints the ticket and
    /// says where, and this phone asks GitHub with its own sign-in. No box.
    func startRunner(_ fleet: Fleet, platform: String, minutes: Int?, start: [String: String]?) async throws -> Fleet.Reply {
        let plan = try await fleet.prepareRunnerDispatch(platform: platform, minutes: minutes, start: start)
        guard plan["ok"] as? Bool == true,
              let repo = plan["repo"] as? String,
              let workflow = plan["workflow"] as? String,
              let inputs = plan["inputs"] as? [String: Any]
        else {
            return Fleet.Reply(ok: false, text: plan["text"] as? String ?? "The fleet would not start a machine.", sessions: nil)
        }
        let token = try await accessToken(fleet)
        let about = try await github("GET", "https://api.github.com/repos/\(repo)", token: token, body: nil)
        guard (200...299).contains(about.status) else {
            return Fleet.Reply(ok: false, text: Self.refusal(about.status, "the repository \(repo)"), sessions: nil)
        }
        let info = (try? JSONSerialization.jsonObject(with: about.data)) as? [String: Any]
        let ref = (info?["default_branch"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "main"
        let sent = try await github(
            "POST", "https://api.github.com/repos/\(repo)/actions/workflows/\(workflow)/dispatches",
            token: token, body: ["ref": ref, "inputs": inputs]
        )
        switch sent.status {
        case 204:
            return Fleet.Reply(
                ok: true,
                text: "Asked GitHub for a \(platform) machine from \(repo), as you. It takes a few minutes to boot and then "
                    + "appears in the fleet as a host of yours.",
                sessions: nil
            )
        case 422:
            return Fleet.Reply(
                ok: false,
                text: "GitHub refused the dispatch (422). \(repo) has \(workflow), but it does not take the inputs this fleet "
                    + "sends. Update it from install/runner-central/ in the Fleetwright repository.",
                sessions: nil
            )
        default:
            return Fleet.Reply(ok: false, text: Self.refusal(sent.status, "\(workflow) in \(repo)"), sessions: nil)
        }
    }

    /// Keep your Claude login with the minter for your runners, or forget it
    /// (`claudeToken` nil). Sealed to the pin with this phone's GitHub token
    /// inside, which is how the minter learns whose it is without asking the
    /// coordinator.
    func depositClaudeLogin(_ fleet: Fleet, claudeToken: String?) async throws -> String {
        let pin = settings.minterPin
        guard !pin.isEmpty else { throw FleetError.message("Save your minter key first. Whoever runs your fleet has it.") }
        let said = try await fleet.claudeLoginKey()
        guard said.key == pin else { throw FleetError.message("The fleet's minter has a different key from your pin, so nothing was sent.") }
        let github = try await accessToken(fleet)
        var payload: [String: Any] = ["v": 1, "github": github, "claude": NSNull(), "at": Int(Date().timeIntervalSince1970 * 1000)]
        if let claude = claudeToken?.trimmingCharacters(in: .whitespacesAndNewlines), !claude.isEmpty { payload["claude"] = claude }
        let answer = try await fleet.depositClaudeLogin(sealed: try Seal.seal(to: pin, aad: Seal.depositAAD, payload: payload))
        guard answer.ok == true else { throw FleetError.message(answer.text ?? "The minter refused it.") }
        return answer.text ?? ""
    }

    private func github(_ method: String, _ url: String, token: String, body: [String: Any]?) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "x-github-api-version")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private static func refusal(_ status: Int, _ what: String) -> String {
        switch status {
        case 401: return "GitHub rejected this phone's sign-in (401). Sign in to GitHub again."
        case 403: return "GitHub refused \(what) (403). Your account needs write access there."
        case 404: return "GitHub cannot see \(what) from your account (404)."
        default: return "GitHub refused \(what) (\(status))."
        }
    }

    private static func randomToken(_ bytes: Int) -> String {
        var raw = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &raw)
        return Seal.b64(Data(raw))
    }
}
