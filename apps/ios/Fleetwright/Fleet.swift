import Foundation
import Security

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
    /// Start a session.
    ///
    /// Everything past `name` is optional and stays optional. A spoken start
    /// cannot open a text field, so there has to be a good outcome when none of
    /// it is supplied — see docs/naming.md.
    ///
    /// `title` and `brief` are prose, and they travel as intent PARAMETERS, not
    /// glued into a name. On the far side the sidecar keeps them out of the
    /// command line for the same reason: a title reading "refactor auth
    /// --dangerous" must never arrive as a flag.
    /// No `host` parameter yet, deliberately. The coordinator's `dispatch()`
    /// has no placement preference to hand it to, so a host argument here would
    /// be accepted, sent, ignored, and look like it worked — which is the
    /// failure mode this project keeps paying for. Choosing a host is real work
    /// in the scheduler and lands with that, not as a field that does nothing.
    func start(
        name: String?,
        title: String? = nil,
        brief: String? = nil,
        mode: String? = nil
    ) async throws -> Reply {
        var params: [String: String] = [:]
        if let name { params["name"] = name }
        if let title, !title.isEmpty { params["title"] = title }
        if let brief, !brief.isEmpty { params["brief"] = brief }
        if let mode, !mode.isEmpty { params["mode"] = mode }
        return try await intent("start", params: params)
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
    /// The last lines of a session's pane — what it is actually doing.
    ///
    /// The verb that makes the app more than a list of names. Everything else
    /// tells you a session exists; this tells you whether it is stuck.
    func peek(_ name: String) async throws -> Reply { try await intent("peek", params: ["name": name]) }

    /// Forget a session and delete its volumes. Not undoable, which is why the
    /// UI asks first.
    func forget(_ name: String) async throws -> Reply { try await intent("forget", params: ["name": name]) }

    /// Ask the coordinator to send this device a notification now.
    ///
    /// Push fails silently by nature: a registration that never arrived and a
    /// provider that is not configured look identical from a phone, which is
    /// to say they look like nothing at all. This is the only way to find out
    /// before the notification that matters.
    func testPush(token: Data?) async throws -> Reply {
        var body: [String: Any] = [:]
        if let token { body["token"] = token.map { String(format: "%02x", $0) }.joined() }
        let data = try await post("/api/devices/test", body: body)
        let decoded = try JSONDecoder().decode(Reply.self, from: data)
        return decoded
    }

    /// Spend an ID token for a credential of this device's own.
    ///
    /// The reply is the ONLY time the credential exists in full — the
    /// coordinator keeps a hash. Losing it means signing in again, which is the
    /// correct cost: a coordinator that could tell you an existing credential
    /// is a coordinator that could be made to.
    func signIn(idToken: String, deviceName: String) async throws -> (token: String, email: String) {
        let data = try await post(
            "/api/session",
            body: ["idToken": idToken, "deviceName": deviceName],
            authenticated: false
        )
        struct Issued: Codable {
            struct Client: Codable { let name: String? }
            let ok: Bool?
            let text: String?
            let token: String?
            let client: Client?
        }
        let reply = try JSONDecoder().decode(Issued.self, from: data)
        guard reply.ok == true, let token = reply.token else {
            throw FleetError.message(reply.text ?? "The coordinator refused the sign-in.")
        }
        // The name it chose looks like "iPhone (someone@example.com)" — the
        // address inside it is what the app shows, so a phone signed into the
        // wrong account is visible rather than merely wrong.
        let email = reply.client?.name.flatMap(Self.emailIn) ?? ""
        return (token, email)
    }

    /// `Someone's iPhone (a@b.com)` -> `a@b.com`
    private static func emailIn(_ label: String) -> String? {
        guard let open = label.lastIndex(of: "("), let close = label.lastIndex(of: ")"), open < close else { return nil }
        let inner = String(label[label.index(after: open)..<close])
        return inner.contains("@") ? inner : nil
    }

    /// The machines in this fleet, and their key fingerprints.
    func enrolledHosts() async throws -> [Host] {
        let data = try await get("/api/hosts/enrolled")
        struct Reply: Codable { let hosts: [Host]? }
        return try JSONDecoder().decode(Reply.self, from: data).hosts ?? []
    }

    /// Mint a six-digit pin for a machine to join with.
    ///
    /// This is how a host gets in now: no shared token to copy, one pin, ten
    /// minutes, single use.
    func mintHostPin() async throws -> String {
        let data = try await post("/api/enroll", body: ["kind": "host"])
        struct Reply: Codable { let ok: Bool?; let code: String?; let text: String? }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard let code = reply.code else { throw FleetError.message(reply.text ?? "Could not mint a pin.") }
        return code
    }

    /// Remove a machine from the fleet. It is disconnected as well as revoked —
    /// a revoked host with a live socket is still in the fleet.
    func revokeHost(_ hostId: String) async throws -> Reply {
        let data = try await send("DELETE", "/api/hosts/\(hostId)", body: nil)
        return try JSONDecoder().decode(Reply.self, from: data)
    }

    struct Host: Codable, Identifiable, Hashable {
        let hostId: String
        let fingerprint: String
        let enrolledBy: String?
        let enrolledAt: Double?
        let lastSeenAt: Double?
        let revokedAt: Double?

        var id: String { hostId }
        var isRevoked: Bool { (revokedAt ?? 0) > 0 }
    }

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

    private func post(_ path: String, body: [String: Any], authenticated: Bool = true) async throws -> Data {
        try await send("POST", path, body: body, authenticated: authenticated)
    }

    private func get(_ path: String) async throws -> Data {
        try await send("GET", path, body: nil)
    }

    private func send(
        _ method: String,
        _ path: String,
        body: [String: Any]?,
        authenticated: Bool = true
    ) async throws -> Data {
        guard let url = URL(string: settings.coordinatorURL.trimmingCharacters(in: ["/"]) + path) else {
            throw FleetError.message("That coordinator URL is not a URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if authenticated, !settings.credential.isEmpty {
            request.setValue("Bearer \(settings.credential)", forHTTPHeaderField: "authorization")
        }
        // Long, because a `start` waits out the Remote Control check on the
        // host. A short timeout reports a working fleet as unreachable.
        request.timeoutInterval = 120
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            // A credential is revoked by somebody deliberately removing this
            // device. Clearing it here is what turns "every request fails" into
            // "sign in again", which is the actual remedy.
            if authenticated, !settings.credential.isEmpty {
                await MainActor.run { settings.signOut() }
                throw FleetError.message("This device is no longer allowed in. Sign in again.")
            }
            throw FleetError.message("The coordinator refused that.")
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

/// Where the coordinator is, and this device's own credential.
///
/// §5 is explicit that a credential must never be baked into an app binary — it
/// is public the moment somebody pulls the IPA. It is also not typed in any
/// more: signing in mints one for THIS device, which is what makes losing a
/// phone one revocation instead of a fleet-wide rotation.
@Observable
final class Settings {
    /// Not sensitive: an origin, and the app refuses to talk to any other.
    var coordinatorURL: String {
        didSet { UserDefaults.standard.set(coordinatorURL, forKey: "coordinatorURL") }
    }

    /// The keychain, not UserDefaults.
    ///
    /// This credential can start and stop sessions on every machine in the
    /// fleet. UserDefaults is a plist in the app container: not readable by
    /// other apps on a healthy device, but it is plain text on disk, it goes
    /// into an unencrypted backup, and it is there for anything that gets file
    /// access to the container. None of that is an acceptable place for a
    /// credential with this reach, and CodeQL was right to say so.
    var credential: String {
        didSet { Keychain.set(credential, for: Self.credentialKey) }
    }

    /// Who this device is signed in as. Not a secret — it is displayed — and
    /// deliberately not the thing that authorises anything.
    var signedInAs: String {
        didSet { UserDefaults.standard.set(signedInAs, forKey: "signedInAs") }
    }

    /// Whether starting a session from an intent should bring the app forward.
    ///
    /// OFF by default, and that default is the whole design decision. An intent
    /// fired from a Shortcut, an automation or the Action button very often
    /// runs when nobody is looking at the phone, and launching an app then is
    /// an interruption nobody asked for. Only the person who set it knows
    /// whether they meant "start this and get out of my way" or "start this and
    /// take me there".
    var autoOpenAfterStart: Bool {
        didSet { UserDefaults.standard.set(autoOpenAfterStart, forKey: "autoOpenAfterStart") }
    }

    /// The phrase somebody chose for themselves.
    ///
    /// Stored even though iOS will not let us register it: the app shows it
    /// back, so returning to that screen shows their choice rather than an
    /// empty field that looks like it was forgotten. Not a claim that Siri
    /// knows it — only that they told us.
    var customPhrase: String {
        didSet { UserDefaults.standard.set(customPhrase, forKey: "customPhrase") }
    }

    private static let credentialKey = "credential"

    init() {
        coordinatorURL = UserDefaults.standard.string(forKey: "coordinatorURL") ?? ""
        credential = Keychain.get(Self.credentialKey) ?? ""
        signedInAs = UserDefaults.standard.string(forKey: "signedInAs") ?? ""
        autoOpenAfterStart = UserDefaults.standard.bool(forKey: "autoOpenAfterStart")
        customPhrase = UserDefaults.standard.string(forKey: "customPhrase") ?? ""

        // Nothing is carried over from the build that asked for an admin token.
        // That token is the fleet's break-glass credential and every phone had
        // the same one; silently promoting it to this device's credential would
        // preserve exactly what this replaces. It is deleted instead, and the
        // app asks to sign in.
        Keychain.set("", for: "apiToken")
        UserDefaults.standard.removeObject(forKey: "apiToken")
    }

    @MainActor
    func signOut() {
        credential = ""
        signedInAs = ""
    }

    /// Reachable AND allowed in. Both matter: a URL with no credential gets a
    /// 401 on every call, which reads as a broken fleet rather than a phone
    /// that has not signed in.
    var configured: Bool { !coordinatorURL.isEmpty && !credential.isEmpty }
    var hasCoordinator: Bool { !coordinatorURL.isEmpty }
}

/// The smallest keychain wrapper that is correct.
///
/// No dependency, in keeping with the rest of this app: a generic-password
/// item is three Security calls, and a library to make them shorter would be
/// carried for the life of the app.
enum Keychain {
    private static let service = "network.thetech.fleetwright"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// @param value an empty string deletes the item rather than storing "".
    static func set(_ value: String, for account: String) {
        SecItemDelete(query(account) as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }

        var item = query(account)
        item[kSecValueData as String] = data
        // ThisDeviceOnly keeps it out of backups and off any other device;
        // AfterFirstUnlock so a notification arriving on a locked phone can
        // still be acted on. `WhenUnlocked` would be stricter and would break
        // exactly that.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        var item = query(account)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne

        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }
        return string
    }
}
