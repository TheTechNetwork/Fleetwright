import Foundation

/// Talking to the coordinator.
///
/// Deliberately URLSession and Codable, with no package dependencies. The whole
/// API is a handful of endpoints returning flat JSON — §7 designed it that way
/// so a Shortcut could call it — and a dependency here would be carried for the
/// life of the app to save very little.
struct Fleet {
    let settings: Settings

    struct Session: Codable, Identifiable, Hashable {
        let name: String
        let title: String?
        let status: String
        let hostId: String?
        let rcUrl: String?
        let uuid: String?

        var id: String { "\(hostId ?? "?")/\(name)" }
        /// What to show. The name is the identity; the title is for people.
        var label: String { (title?.isEmpty == false ? title! : name) }
        var isRunning: Bool { status == "running" }
        var isResumable: Bool { uuid?.isEmpty == false }
    }

    struct Reply: Codable {
        let ok: Bool?
        let text: String?
        let sessions: [Session]?
    }

    func list() async throws -> Reply { try await intent("list") }
    func start(name: String?) async throws -> Reply {
        try await intent("start", params: name.map { ["name": $0] } ?? [:])
    }
    func stop(_ name: String) async throws -> Reply { try await intent("stop", params: ["name": name]) }
    func resume(_ name: String, choice: String? = nil) async throws -> Reply {
        var params = ["name": name]
        if let choice { params["choice"] = choice }
        return try await intent("resume", params: params)
    }

    /// Hand APNs' device token to the coordinator so it can wake this phone.
    ///
    /// The token arrives as Data from the system and must be hex — sending the
    /// Data's description is the classic mistake, and produces a registration
    /// that silently never delivers.
    func registerDevice(token: Data) async throws {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        _ = try await post("/api/devices", body: ["platform": "ios", "token": hex])
    }

    private func intent(_ verb: String, params: [String: String] = [:]) async throws -> Reply {
        let body: [String: Any] = [
            "verb": verb,
            "params": params,
            "actor": "app:ios",
            // An idempotency key the SERVER honours: a retry of `start` returns
            // the original outcome rather than starting a second session.
            "id": "app-\(UUID().uuidString)",
        ]
        let data = try await post("/api/intent", body: body)
        return try JSONDecoder().decode(Reply.self, from: data)
    }

    private func post(_ path: String, body: [String: Any]) async throws -> Data {
        guard let url = URL(string: settings.coordinatorURL.trimmingCharacters(in: ["/"]) + path) else {
            throw FleetError.message("That coordinator URL is not a URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if !settings.apiToken.isEmpty {
            request.setValue("Bearer \(settings.apiToken)", forHTTPHeaderField: "authorization")
        }
        // Long, because a `start` waits out the Remote Control check on the
        // host. A short timeout reports a working fleet as unreachable.
        request.timeoutInterval = 120
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw FleetError.message("The coordinator rejected the token")
        }
        return data
    }
}

enum FleetError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

/// Where the coordinator is and how to authenticate to it.
///
/// §5 is explicit that a credential must never be baked into an app binary — it
/// is public the moment somebody pulls the IPA — so this is entered once and
/// kept on the device. UserDefaults for now; the Keychain is the right home and
/// is a small, self-contained change.
@Observable
final class Settings {
    var coordinatorURL: String {
        didSet { UserDefaults.standard.set(coordinatorURL, forKey: "coordinatorURL") }
    }
    var apiToken: String {
        didSet { UserDefaults.standard.set(apiToken, forKey: "apiToken") }
    }

    init() {
        coordinatorURL = UserDefaults.standard.string(forKey: "coordinatorURL") ?? ""
        apiToken = UserDefaults.standard.string(forKey: "apiToken") ?? ""
    }

    var configured: Bool { !coordinatorURL.isEmpty }
}
