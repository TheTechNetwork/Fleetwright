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
        /// Where the work is happening. Optional because an older sidecar does
        /// not send it — every field added this round degrades to absent
        /// rather than to an error.
        let cwd: String?
        /// When it started, as a timestamp in milliseconds. A DURATION would
        /// be stale the moment it was serialised; the arithmetic belongs here,
        /// where the clock is live.
        let startedAt: Double?
        /// Whose Claude account it runs on: an email, or "shared".
        let account: String?
        /// What it is asking, when it is asking. Present only while a prompt
        /// is on screen — and the id is what makes answering it later safe.
        let prompt: Prompt?

        struct Prompt: Codable, Hashable {
            let id: String?
            let question: String?
            let options: [Option]?
            struct Option: Codable, Hashable, Identifiable {
                let index: Int
                let label: String
                var id: Int { index }
            }
        }

        var id: String { "\(hostId ?? "?")/\(name)" }
        /// What to show. The name is the identity; the title is for people.
        var label: String { (title?.isEmpty == false ? title! : name) }
        var isRunning: Bool { status == "running" }
        var isResumable: Bool { uuid?.isEmpty == false }

        /// The last path component, which is what a person recognises. The
        /// full path is long, and the part that identifies a checkout is at
        /// the end of it.
        var workspace: String? {
            guard let cwd, !cwd.isEmpty else { return nil }
            return URL(fileURLWithPath: cwd).lastPathComponent
        }

        /// "3h" — coarse on purpose. The exact age of a session is never the
        /// question; "since this morning" or "still going after two days" is.
        var age: String? {
            guard let startedAt, startedAt > 0 else { return nil }
            let seconds = Date().timeIntervalSince1970 - startedAt / 1000
            guard seconds > 60 else { return "just now" }
            if seconds < 3600 { return "\(Int(seconds / 60))m" }
            if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
            return "\(Int(seconds / 86_400))d"
        }
    }

    struct Reply: Codable {
        let ok: Bool?
        let text: String?
        let sessions: [Session]?
        /// What could be connected and what is, when the reply is about
        /// credentials. Never a token — the host does not send one and there
        /// is no field here that could hold one.
        var connections: Connections?
    }

    /// The connector picker, rendered from what the HOST publishes.
    ///
    /// Deliberately not a hardcoded list of providers in the app. A provider
    /// added to the host's table appears here on the next refresh, with its
    /// real URL and its real scopes, without an App Store release — which is
    /// the entire reason the verbs are connect/link/unlink and not
    /// github/cloudflare.
    struct Connections: Codable, Hashable {
        var catalogue: [Available] = []
        var connected: [Linked] = []

        struct Available: Codable, Hashable, Identifiable {
            let provider: String
            let label: String
            /// The provider's OWN token page, with the scopes pre-ticked —
            /// or, for Claude, the authorization URL this box just minted.
            ///
            /// Optional because Claude has no static page to send anybody to:
            /// its URL exists only once a flow has been started, and `null`
            /// there is the honest answer rather than a missing field.
            let url: String?
            let hint: String
            let env: [String]
            var id: String { provider }
            /// Claude is a sign-in; the rest are tokens to paste. Which one
            /// decides the shape of the row, so it is asked once here rather
            /// than at four places in the view.
            var isSignIn: Bool { provider == "claude" }
        }

        struct Linked: Codable, Hashable, Identifiable {
            let provider: String
            let label: String?
            /// Who the token belongs to at the provider — `@octocat`. Not a
            /// token, and there is no field for one.
            let account: String?
            let updatedAt: Double?
            var id: String { provider }
        }

        func linked(_ provider: String) -> Linked? { connected.first { $0.provider == provider } }
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
        mode: String? = nil,
        host: String? = nil
    ) async throws -> Reply {
        var params: [String: String] = [:]
        if let name { params["name"] = name }
        if let title, !title.isEmpty { params["title"] = title }
        if let brief, !brief.isEmpty { params["brief"] = brief }
        if let mode, !mode.isEmpty { params["mode"] = mode }
        // `host` is a placement PREFERENCE and rides beside the intent, never
        // inside it — `start` declares no host parameter, and a host receiving
        // one would refuse the whole intent. The coordinator refuses a bad
        // choice by name ("small-box is full: 5/5"), and that text must reach
        // the screen: a picker that looked healthy plus a silent failure is
        // exactly the shape of the night this feature was built after.
        return try await intent("start", params: params, host: host)
    }
    func stop(_ name: String) async throws -> Reply { try await intent("stop", params: ["name": name]) }

    /// One host in detail, or the fleet when no name is given.
    func status(_ name: String? = nil) async throws -> Reply {
        try await intent("status", params: name.map { ["name": $0] } ?? [:])
    }

    /// Answer a waiting prompt by selecting an option the HOST published.
    ///
    /// An ordinal, never text: `send-keys` into a pane reaches a root shell,
    /// so what crosses this boundary is a digit. `promptId` is what the host
    /// checks against the live pane — a notification tapped four minutes late
    /// must not answer a different question.
    func answer(_ name: String, option: Int, promptId: String? = nil) async throws -> Reply {
        var params = ["name": name, "option": String(option)]
        if let promptId, !promptId.isEmpty { params["promptId"] = promptId }
        return try await intent("answer", params: params, numeric: ["option"])
    }

    /// A service journal, or what a session printed.
    ///
    /// `name` and `service` are alternatives — naming a session is the more
    /// specific request and the host prefers it.
    func logs(host: String? = nil, session: String? = nil, service: String? = nil, lines: Int? = nil) async throws -> Reply {
        var params: [String: String] = [:]
        if let session, !session.isEmpty { params["name"] = session }
        if let service, !service.isEmpty { params["service"] = service }
        if let lines { params["lines"] = String(lines) }
        return try await intent("logs", params: params, host: host, numeric: ["lines"])
    }

    /// Pull code on one box. `restart` is opt-in: an update that does not
    /// restart leaves the box on old code and says so.
    func update(host: String, restart: Bool = false) async throws -> Reply {
        try await intent("update", params: restart ? ["restart": "yes"] : [:], host: host)
    }

    /// What the operating system has waiting, and optionally install it.
    func upgrade(host: String, apply: Bool = false) async throws -> Reply {
        try await intent("upgrade", params: apply ? ["apply": "yes"] : [:], host: host)
    }

    /// Reboot a box. TWO STEPS, and deliberately so.
    ///
    /// Bare is step one: the host names every session that will die and issues
    /// a six-digit pin. Pin plus hostname is step two. A boolean confirmation
    /// would be one tap from a phone in a pocket.
    func reboot(host: String, pin: String? = nil, confirm: String? = nil) async throws -> Reply {
        var params: [String: String] = [:]
        if let pin, !pin.isEmpty { params["pin"] = pin }
        if let confirm, !confirm.isEmpty { params["confirm"] = confirm }
        return try await intent("reboot", params: params, host: host)
    }
    /// What can be connected on this box, and what already is.
    ///
    /// One round trip: the catalogue and the current state arrive together, so
    /// a picker never renders a provider list from one answer and its status
    /// from another.
    func connections(host: String) async throws -> Reply {
        try await intent("connect", params: [:], host: host)
    }

    /// Begin connecting a credential. Returns a URL to open — never a secret.
    ///
    /// `scope` is left off for a person's own credential, which needs no
    /// permission: the HOST derives whose account it is from the verified
    /// identity on the request, and there is no parameter that could name
    /// somebody else. `.host` logs the BOX in and is admin-only.
    func connect(host: String, provider: String, scope: Scope = .me) async throws -> Reply {
        var params = ["provider": provider]
        if scope == .host { params["scope"] = "host" }
        return try await intent("connect", params: params, host: host)
    }

    /// Hand back the token or the authorization code.
    ///
    /// Goes to the SAME host `connect` was asked of, which the caller carries.
    /// Claude's flow is a login waiting in a pane on that box; a code typed
    /// into a different one would be a live credential landing where nothing
    /// asked for it.
    func link(host: String, provider: String, secret: String, scope: Scope = .me) async throws -> Reply {
        var params = ["provider": provider, "secret": secret]
        if scope == .host { params["scope"] = "host" }
        return try await intent("link", params: params, host: host)
    }

    /// Forget a stored credential. Does NOT revoke it at the provider.
    func unlink(host: String, provider: String, scope: Scope = .me) async throws -> Reply {
        var params = ["provider": provider]
        if scope == .host { params["scope"] = "host" }
        return try await intent("unlink", params: params, host: host)
    }

    enum Scope: String { case me, host }

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
    /// Stop a session and put it in the bin. Recoverable — see `restore`.
    func forget(_ name: String) async throws -> Reply { try await intent("forget", params: ["name": name]) }

    /// Take a forgotten session back out of the bin.
    ///
    /// The volumes were never deleted, so this is a record move: the
    /// conversation and the workspace come back exactly as they were. Pinned
    /// to the box still holding them, which the coordinator resolves.
    func restore(_ name: String) async throws -> Reply { try await intent("restore", params: ["name": name]) }

    /// Delete for good. What `forget` used to do, kept as its own word.
    func purge(_ name: String) async throws -> Reply { try await intent("purge", params: ["name": name]) }

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

    /// What every machine is reporting right now — state, account, version.
    ///
    /// /api/hosts, not /api/hosts/enrolled: enrolled is the membership list
    /// (fingerprints, who added it), this is what they are SAYING. The
    /// settings screen wants both and they answer different questions.
    func fleetHosts() async throws -> [FleetHost] {
        let data = try await get("/api/hosts")
        struct Reply: Codable { let hosts: [FleetHost]? }
        return try JSONDecoder().decode(Reply.self, from: data).hosts ?? []
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

    /// What a box says about itself. Every field optional: an older sidecar
    /// sends none of them, and the app must show a host with less information
    /// rather than no host at all.
    /// A session that was forgotten and is still recoverable.
    struct Binned: Codable, Hashable, Identifiable {
        let name: String
        let title: String?
        /// When it goes. Sent as a timestamp so the phone does the arithmetic
        /// — "two days left" computed here stays right while the screen is
        /// open, and a server-rendered string would freeze the moment it was
        /// sent.
        let expiresAt: Double?
        var id: String { name }

        /// "2 days left", "5h left", or "goes within the hour".
        var remaining: String? {
            guard let expiresAt else { return nil }
            let left = expiresAt / 1000 - Date().timeIntervalSince1970
            if left <= 0 { return "gone" }
            if left < 3600 { return "goes within the hour" }
            if left < 86_400 { return "\(Int(left / 3600))h left" }
            let days = Int(left / 86_400)
            return "\(days) day\(days == 1 ? "" : "s") left"
        }
    }

    struct HostHealth: Codable, Hashable {
        struct Account: Codable, Hashable {
            let email: String?
            let plan: String?
            let org: String?
        }
        struct Version: Codable, Hashable {
            let head: String?
            let branch: String?
        }
        struct Updates: Codable, Hashable {
            let appBehind: Int?
            let system: String?
            let rebootRequired: Bool?
        }
        let account: Account?
        let version: Version?
        let updates: Updates?
        let loggedIn: Bool?
        let running: Int?
        let maxSessions: Int?
        /// Forgotten, still recoverable. Absent on a host that has not been
        /// updated, which decodes as nil and renders as no section at all —
        /// the correct answer for a box where forget still deletes.
        let bin: [Binned]?
    }

    /// A host as the fleet snapshot describes it — state, reason, and whatever
    /// the box last reported about itself.
    struct FleetHost: Codable, Identifiable, Hashable {
        let hostId: String
        let state: String?
        let reason: String?
        let health: HostHealth?
        var id: String { hostId }
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

    /// - Parameter numeric: keys the protocol types as `int`. They travel as
    ///   Swift Strings for convenience and must be sent as JSON NUMBERS —
    ///   `validateIntent` requires a safe integer and refuses `"2"`, which
    ///   would be a rejection after the version handshake had already agreed.
    private func intent(
        _ verb: String,
        params: [String: String] = [:],
        host: String? = nil,
        numeric: Set<String> = []
    ) async throws -> Reply {
        var typed: [String: Any] = [:]
        for (key, value) in params {
            typed[key] = numeric.contains(key) ? (Int(value) ?? 0) : value
        }
        var body: [String: Any] = [
            "verb": verb,
            "params": typed,
            "actor": "app:ios",
            // An idempotency key the SERVER honours: a retry of `start` returns
            // the original outcome rather than starting a second session.
            "id": "app-\(UUID().uuidString)",
        ]
        if let host, !host.isEmpty { body["host"] = host }
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
        // Already normalised by Settings — scheme present, no whitespace, no
        // trailing slash — so this is a parse, not a repair.
        guard let url = URL(string: settings.coordinatorURL + path) else {
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
    /// Normalised ON WRITE, so every reader gets something usable and no
    /// caller has to remember. Assigning inside `didSet` does not re-enter it.
    var coordinatorURL: String {
        didSet {
            let tidy = CoordinatorURL.normalise(coordinatorURL)
            if tidy != coordinatorURL { coordinatorURL = tidy }
            UserDefaults.standard.set(coordinatorURL, forKey: "coordinatorURL")
        }
    }

    /// Where this app was pointed before somebody tapped into the demo, so
    /// leaving it puts them back rather than making them re-type a URL.
    var urlBeforeDemo: String {
        didSet { UserDefaults.standard.set(urlBeforeDemo, forKey: "urlBeforeDemo") }
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
        // Normalised on the way IN as well as on the way out: a value stored by
        // an older build predates the tidying, and the first thing that happens
        // to it should not be a request to a URL that cannot parse.
        // `didSet` does not run during init, so this is explicit.
        coordinatorURL = CoordinatorURL.normalise(UserDefaults.standard.string(forKey: "coordinatorURL") ?? "")
        urlBeforeDemo = UserDefaults.standard.string(forKey: "urlBeforeDemo") ?? ""
        credential = Keychain.get(Self.credentialKey) ?? ""
        signedInAs = UserDefaults.standard.string(forKey: "signedInAs") ?? ""
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
