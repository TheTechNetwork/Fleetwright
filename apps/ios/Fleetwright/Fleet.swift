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
    /// Where a command goes when the fleet cannot be reached. Optional so a
    /// Fleet built for a one-off read carries no queue at all.
    var outbox: Outbox?

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
        /// When this session's pane last changed, as epoch milliseconds.
        ///
        /// A timestamp rather than a duration: the phone doing the arithmetic
        /// is the only place it stays right while a screen is open — the same
        /// reason `startedAt` travels this way.
        ///
        /// Nil for a session that is not running, and for one showing a
        /// prompt: that pane is still because somebody has to answer it, which
        /// is the opposite of idle.
        let idleSince: Double?
        /// Is the pane showing the session's own prompt — finished, or between
        /// things, and waiting for input?
        ///
        /// THE DIFFERENCE A TIMER CANNOT SEE. A finished session and a wedged
        /// one both stop changing, and this app rendered both as "quiet for
        /// 3h" — true of each, useful about neither, when which one it is is
        /// the whole question somebody opens the app to ask.
        let atRest: Bool?
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

        /// How long it has been quiet, once that is long enough to mean
        /// something.
        ///
        /// "Running" was doing two jobs: a session mid-build and one that has
        /// not moved since Tuesday looked identical, in the same font, and the
        /// difference is the entire question somebody opens this app to ask.
        ///
        /// NOTHING UNDER FIVE MINUTES. A pane pauses constantly — waiting on a
        /// network call, thinking, between tool calls — and a counter that
        /// resets every few seconds is noise that trains people to ignore the
        /// field. This is meant to answer "has it been stuck for an hour",
        /// which is the anxiety in docs/psychology.md, not "is it typing".
        var quietFor: String? {
            guard isRunning, prompt == nil, let idleSince, idleSince > 0 else { return nil }
            let seconds = Date().timeIntervalSince1970 - idleSince / 1000
            guard seconds >= 300 else { return nil }
            let howLong = seconds < 3600 ? "\(Int(seconds / 60))m"
                : seconds < 86_400 ? "\(Int(seconds / 3600))h"
                : "\(Int(seconds / 86_400))d"
            // TWO SENTENCES, BECAUSE THEY ARE TWO SITUATIONS. A session at its
            // own prompt finished, or is between things, and needs nothing —
            // saying "quiet" about it invites a person to worry at the most
            // common state in the fleet. A pane stopped mid-work with no
            // prompt on it is the one worth a second look.
            return atRest == true ? "ready · idle \(howLong)" : "quiet for \(howLong)"
        }

        /// Worth counting as "a session somebody might want to look at". A
        /// finished one is not.
        var looksStalled: Bool { quietFor != nil && atRest != true }

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

    /// What a stored credential can do, straight from the provider.
    struct Check: Codable, Hashable {
        let ok: Bool?
        let account: String?
        /// Scope names it HAS. Nil where the provider will not say — which is
        /// a different fact from an empty list, and rendering it as "none"
        /// would be a lie about Cloudflare in particular.
        let granted: [String]?
        /// Scope names this project asks for.
        let wants: [String]?
        /// Asked for and not granted. Nil means "cannot tell".
        let missing: [String]?
        let message: String?
    }

    struct Reply: Codable {
        let ok: Bool?
        let text: String?
        let sessions: [Session]?
        var check: Check?
        /// What could be connected and what is, when the reply is about
        /// credentials. Never a token — the host does not send one and there
        /// is no field here that could hold one.
        var connections: Connections?
        /// A directory listing, as DATA. The rendered text is for a person;
        /// parsing it back out of the prose is how an app breaks the first time
        /// the wording changes — the same argument that put the authorization
        /// URL in a field rather than in a message.
        var entries: [Entry]?
        /// What a session could be started ON, as DATA and with the host each
        /// one lives on. Same reasoning as `entries`: a picker built by parsing
        /// the rendered text would be a picker built from column padding.
        var profiles: [Profile]?
        /// Which releases this box installs. A field rather than a sentence for
        /// the same reason as everything above it: a picker that had to find
        /// the word "rolling" in the prose would break on a rewording.
        var channel: String?
        /// The box's environment is forcing the channel, so the control is
        /// shown as an answer and not as a choice. Said up front rather than
        /// discovered by a refusal.
        var channelPinned: Bool?
    }

    /// A task profile: a file on ONE host whose content becomes a new session's
    /// first message.
    ///
    /// THE CONTENT IS NOT HERE AND NEVER WILL BE. The protocol carries a name;
    /// the words live on the box and get there by somebody with a shell on it.
    /// A phone that could supply them would be writing the instructions of an
    /// agent running as root in a container — see docs/task-at-start.md.
    struct Profile: Codable, Hashable, Identifiable {
        let name: String
        /// The first line of the file, for a list. Not the task — the task is
        /// the whole file, which stays on the host.
        var summary: String = ""
        var chars: Int = 0
        /// Which machine has it. Load-bearing rather than decorative: `start`
        /// on a host that does not have this profile is refused, so a picker
        /// that lost the attribution would send people at the wrong box.
        var hostId: String?
        /// Two hosts may both have a profile called "reviewer" and they are not
        /// the same file, so the name alone is not an identity.
        var id: String { "\(hostId ?? "")/\(name)" }
    }

    /// One thing in a session's workspace.
    struct Entry: Codable, Hashable, Identifiable {
        var name: String
        /// "dir", "file" or "link". A string rather than an enum because the
        /// host decides what kinds exist and an app that crashed on an unknown
        /// one would be an app that cannot be extended without a release.
        var kind: String
        var size: Int
        var id: String { name }
        var isDirectory: Bool { kind == "dir" }
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
        /// Every machine that answered, so "missing" has something to mean.
        var hosts: [String]?

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
            /// What this asks for, when the provider will say what a token was
            /// granted. Absent for Cloudflare, which will not.
            let wants: [String]?
            /// `"app"` when the coordinator has rewritten this to a provider
            /// app authorization. Absent means the paste route, which is the
            /// normal case and not a lesser one.
            let flow: String?
            var id: String { provider }

            /// Nothing to copy, so nothing to paste. The whole point of the App.
            var isAppFlow: Bool { flow == "app" }
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
            /// This token can no longer renew itself.
            ///
            /// It still WORKS, which is what makes it worth saying early: an
            /// eight-hour token that cannot renew stops within the day, and the
            /// failure without this is "it worked yesterday" with nothing on
            /// any screen explaining it. Set when the box swept renewal
            /// material it could not use, and cleared the moment a fresh token
            /// is stored.
            let needsReconnect: Bool?
            /// Which machines actually have it, and which do not.
            ///
            /// A credential reaches the hosts that were reachable when it was
            /// stored, so a machine enrolled later has none — and a screen that
            /// says "connected" without saying where implies a uniformity the
            /// fleet does not have.
            ///
            /// `absentFrom`, not `missing`: this type already has a `missing`
            /// for PERMISSIONS, and one word for both absences is how a screen
            /// ends up telling somebody the wrong thing about their token.
            let hosts: [String]?
            let absentFrom: [String]?
            /// Permissions this token does NOT have that are now asked for.
            ///
            /// Not to be confused with `missing` on the coverage side, which is
            /// about MACHINES. Two different absences, and conflating them
            /// would put "missing workflow" and "missing deb14" in one line.
            ///
            /// Three states, and they are genuinely three: a list means "short
            /// by these", empty means "checked, nothing missing", and **nil
            /// means we cannot tell** — an older record, or a provider that
            /// will not say. Rendering nil as "fine" is how somebody finds out
            /// four hours into a session instead.
            let missing: [String]?
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
        host: String? = nil,
        profile: String? = nil
    ) async throws -> Reply {
        var params: [String: String] = [:]
        if let name { params["name"] = name }
        if let title, !title.isEmpty { params["title"] = title }
        if let brief, !brief.isEmpty { params["brief"] = brief }
        if let mode, !mode.isEmpty { params["mode"] = mode }
        // WHAT THE SESSION WILL BE DOING, by name. Without it the session comes
        // up idle at an empty prompt — which is what every session did before
        // protocol v3, and what nothing said out loud.
        //
        // A NAME, never the words: the file is on the host. An unknown one is
        // refused by that host, listing what it does have, so a stale picker
        // fails with something a person can act on rather than starting a
        // session that sits there.
        if let profile, !profile.isEmpty { params["profile"] = profile }
        // `host` is a placement PREFERENCE and rides beside the intent, never
        // inside it — `start` declares no host parameter, and a host receiving
        // one would refuse the whole intent. The coordinator refuses a bad
        // choice by name ("small-box is full: 5/5"), and that text must reach
        // the screen: a picker that looked healthy plus a silent failure is
        // exactly the shape of the night this feature was built after.
        return try await intent("start", params: params, host: host)
    }
    func stop(_ name: String) async throws -> Reply { try await intent("stop", params: ["name": name]) }

    /// Ask for a temporary machine — macOS, Windows, Linux or an Android emulator.
    ///
    /// It does NOT return a host. GitHub has to find hardware, boot it and
    /// install what a session needs, so the runner appears in the fleet minutes
    /// later as a temporary host owned by whoever asked. Anything it runs is
    /// lost when it goes.
    ///
    /// `host` is which permanent box dispatches it, and matters only in a fleet
    /// with several: the dispatch is made with that person's GitHub connection
    /// on that machine, so the coordinator refuses rather than guessing when
    /// more than one could. See docs/runner-central.md.
    func provision(platform: String, minutes: Int? = nil, host: String? = nil) async throws -> Reply {
        var params: [String: String] = ["platform": platform]
        if let minutes { params["minutes"] = String(minutes) }
        return try await intent("provision", params: params, host: host, numeric: ["minutes"])
    }

    /// What every host in the fleet can start a session on.
    ///
    /// Fans out, because a profile is a file on one box: asking a single
    /// machine answers with whatever that machine happens to have and hides the
    /// one somebody is looking for. Each entry carries its `hostId` for the
    /// same reason.
    ///
    /// An empty list is an ANSWER — this fleet has no profiles, so every
    /// session starts idle. A host too old to know the verb refuses it by name
    /// (`unknown_verb`), and that is a different thing, which is why the sheet
    /// treats a throw as "no picker" rather than as "no profiles".
    func profiles() async throws -> [Profile] {
        try await intent("profiles", params: [:]).profiles ?? []
    }

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

    /// Which releases a box installs — and, with `to`, change it.
    ///
    /// Bare is a question. This is the whole point of the verb: an update
    /// channel used to be a line in `/etc/agent-hub.env`, which meant a shell
    /// on the box, which is the one thing somebody with only a phone does not
    /// have.
    func channel(host: String, to: String? = nil) async throws -> Reply {
        var params: [String: String] = [:]
        if let to, !to.isEmpty { params["to"] = to }
        return try await intent("channel", params: params, host: host)
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
    func connections(host: String? = nil) async throws -> Reply {
        // No host means fleet-wide: the coordinator fans it out and merges the
        // answers, which is the only way to see WHERE a credential is.
        try await intent("connect", params: [:], host: host)
    }

    /// Begin connecting a credential. Returns a URL to open — never a secret.
    ///
    /// `scope` is left off for a person's own credential, which needs no
    /// permission: the HOST derives whose account it is from the verified
    /// identity on the request, and there is no parameter that could name
    /// somebody else. `.host` logs the BOX in and is admin-only.
    func connect(host: String? = nil, provider: String, scope: Scope = .me) async throws -> Reply {
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
    func link(host: String? = nil, provider: String, secret: String, scope: Scope = .me) async throws -> Reply {
        var params = ["provider": provider, "secret": secret]
        if scope == .host { params["scope"] = "host" }
        return try await intent("link", params: params, host: host)
    }

    /// Store a token on EVERY box, because it is the person's and not any one
    /// machine's. No host is named, so the coordinator fans it out.
    func linkEverywhere(provider: String, secret: String) async throws -> Reply {
        try await intent("link", params: ["provider": provider, "secret": secret])
    }

    /// Forget a token everywhere it was stored.
    func unlinkEverywhere(provider: String) async throws -> Reply {
        try await intent("unlink", params: ["provider": provider])
    }

    /// Ask the provider what a STORED credential can actually do.
    ///
    /// Different from checking at link time, which checks a value somebody
    /// just pasted. A token can be revoked, expire, or have its permissions
    /// narrowed at the provider long afterwards, and nothing here would know
    /// until a session failed.
    func verify(host: String? = nil, provider: String) async throws -> Reply {
        try await intent("verify", params: ["provider": provider], host: host)
    }

    /// Forget a stored credential. Does NOT revoke it at the provider.
    func unlink(host: String? = nil, provider: String, scope: Scope = .me) async throws -> Reply {
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

    // MARK: - The workspace
    //
    // Five calls rather than one taking an operation, matching the five verbs.
    // Every one names a session, because a workspace belongs to one — there is
    // no fleet-wide filesystem here and nothing addresses one.
    //
    // The host is carried explicitly on all of them. A session lives on ONE
    // box, and a browse that fanned out would be reading a directory that
    // exists on two machines with different contents in it.

    /// List one directory. Paths are relative to the workspace root; empty is
    /// the root itself.
    func files(_ name: String, path: String = "", host: String? = nil) async throws -> Reply {
        var params = ["name": name]
        if !path.isEmpty { params["path"] = path }
        return try await intent("files", params: params, host: host)
    }

    /// Read a text file. The host refuses binary and anything over 256KB, and
    /// says which — so the app shows its reason rather than an empty screen.
    func readFile(_ name: String, path: String, host: String? = nil) async throws -> Reply {
        try await intent("readfile", params: ["name": name, "path": path], host: host)
    }

    /// Write a file, creating it and any missing directories.
    func writeFile(_ name: String, path: String, content: String, host: String? = nil) async throws -> Reply {
        try await intent("writefile", params: ["name": name, "path": path, "content": content], host: host)
    }

    /// Copy within the workspace. Both ends are confined by the host.
    func copyFile(_ name: String, path: String, to: String, host: String? = nil) async throws -> Reply {
        try await intent("copyfile", params: ["name": name, "path": path, "to": to], host: host)
    }

    /// Delete. NOT recoverable — `forget` is the recoverable one and takes the
    /// whole workspace, which is why the UI asks before calling this.
    func deleteFile(_ name: String, path: String, host: String? = nil) async throws -> Reply {
        try await intent("deletefile", params: ["name": name, "path": path], host: host)
    }

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
    /// - Parameter ephemeral: admits a host that is EXPECTED to vanish — a CI
    ///   runner. Decided here, when the pin is minted, rather than claimed by
    ///   the host: a machine that could declare itself temporary is a machine
    ///   that could decline to be cleaned up. See docs/ephemeral-hosts.md.
    /// - Parameter hostId: BINDS the pin to one machine's name, which is what
    ///   readmitting or re-keying an existing host requires. An unbound pin is
    ///   handed out to ADD a box and must not be spendable on taking over one
    ///   that already exists — so the coordinator refuses both cases unless the
    ///   pin names the host.
    /// - Parameter readmit: additionally permits bringing back a host that was
    ///   revoked, so that undoing a removal is a decision somebody makes rather
    ///   than a side effect of holding a pin.
    func mintHostPin(ephemeral: Bool = false, hostId: String? = nil, readmit: Bool = false) async throws -> String {
        /// A dictionary rather than a struct because the two optional keys are
        /// omitted entirely when absent — sending `hostId: null` would bind the
        /// pin to nothing and read, on the wire, as somebody having meant to.
        var body: [String: Any] = ["kind": "host", "ephemeral": ephemeral]
        if let hostId, !hostId.isEmpty {
            body["hostId"] = hostId
            body["readmit"] = readmit
        }
        let data = try await post("/api/enroll", body: body)
        struct Reply: Codable { let ok: Bool?; let code: String?; let text: String? }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard let code = reply.code else { throw FleetError.message(reply.text ?? "Could not mint a pin.") }
        return code
    }

    /// Remove a machine from the fleet. It is disconnected as well as revoked —
    /// a revoked host with a live socket is still in the fleet.
    /// Somebody the admin has let into this fleet.
    ///
    /// An invitation is NOT a credential. It is permission to attempt a
    /// sign-in, and the sign-in still has to produce a verified email from a
    /// provider the coordinator trusts — so there is nothing here to redeem,
    /// replay, or steal into an account.
    struct Invite: Codable, Identifiable, Hashable {
        let email: String
        let invitedBy: String?
        let at: Double?
        let note: String?
        var id: String { email }
    }

    func invites() async throws -> [Invite] {
        let data = try await get("/api/invites")
        struct Reply: Codable { let invites: [Invite]? }
        return try JSONDecoder().decode(Reply.self, from: data).invites ?? []
    }

    func invite(_ email: String, note: String? = nil) async throws -> Reply {
        var body: [String: Any] = ["email": email]
        if let note, !note.isEmpty { body["note"] = note }
        return try JSONDecoder().decode(Reply.self, from: try await send("POST", "/api/invites", body: body))
    }

    func uninvite(_ email: String) async throws -> Reply {
        let path = "/api/invites/\(email.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? email)"
        return try JSONDecoder().decode(Reply.self, from: try await send("DELETE", path, body: nil))
    }

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
            /// What the operating system has waiting, already in prose from the
            /// host — "4 packages (2 security)". Sent since maintenance
            /// shipped and shown nowhere until now, which is why upgrade
            /// looked like it could only report and never act.
            let system: String?
            let rebootRequired: Bool?
            /// A packaged box's answer to the same question the commit count
            /// answers for a checkout.
            ///
            /// THEY ARE NOT INTERCHANGEABLE and only one is ever set. A release
            /// has no git history to count, so `appBehind` is nil on those
            /// boxes — which is CANNOT TELL, and is why a packaged host showed
            /// nothing here for as long as the packaging existed.
            let release: Release?

            /// Is there anything to apply? Two separate answers, because they
            /// are two different actions on two different things.
            var appPending: Bool { (appBehind ?? 0) > 0 || release?.available != nil }
            var systemPending: Bool { !(system ?? "").isEmpty }
        }
        /// What a release-installed box found waiting for it.
        struct Release: Codable, Hashable {
            /// The version waiting, or nil for none. Nil is also what a box
            /// that could not reach GitHub reports — `message` is the only
            /// thing that knows the difference, which is why it travels.
            let available: String?
            /// Whether this box knows where to look at all. False is the state
            /// of every box installed before the installer wrote the manifest
            /// URL, and it is worth showing: it cannot be told apart from
            /// "checked, nothing waiting" by the version alone.
            let configured: Bool?
            /// The host's own sentence. Shown verbatim — it is the only place
            /// that knows which of the several answers this is.
            let message: String?
        }

        /// What a session started on this box would actually be given.
        ///
        /// NOT THE SAME QUESTION AS `loggedIn`, which is the distinction that
        /// cost an evening: `loggedIn` reports on the box's own home
        /// directory, while a sandboxed session runs on a copy of a credential
        /// file taken when its volume was made. A box can report itself signed
        /// in and hand every new session a token that expired hours ago.
        ///
        /// `state` is one of fresh / expired / unknown, and UNKNOWN IS NOT A
        /// PROBLEM — it means the host could not tell, which is what an older
        /// host and an unsandboxed one both look like.
        struct Credential: Codable, Hashable {
            let state: String?
            let expiresAt: Double?
            let refreshable: Bool?
            let account: String?
            let plan: String?
            /// The host's own sentence about it. Shown verbatim: this one is
            /// written for a person rather than for a terminal, and it is the
            /// only place that knows which of the three states it is in.
            let summary: String?

            /// Worth interrupting somebody over. Deliberately narrow: an
            /// expired token that can renew itself is the ordinary state of a
            /// box nobody has touched for an hour.
            var isDead: Bool { state == "expired" && refreshable == false }
        }
        let account: Account?
        let credential: Credential?
        let version: Version?
        let updates: Updates?
        let loggedIn: Bool?
        /// How many people have connected a Claude account on this machine.
        ///
        /// The field that replaced `loggedIn` as the one worth judging a host
        /// on: a machine has no Claude account of its own, so `loggedIn: false`
        /// is the ordinary state of every box. Zero here is the real fault;
        /// nil is an older host and is not one.
        let claudeAccounts: Int?
        let running: Int?
        let maxSessions: Int?
        /// Forgotten, still recoverable. Absent on a host that has not been
        /// updated, which decodes as nil and renders as no section at all —
        /// the correct answer for a box where forget still deletes.
        let bin: [Binned]?
        /// Which releases this box installs — "stable" or "rolling".
        ///
        /// NIL IS CANNOT TELL, not "stable". A host older than the channel
        /// verb sends nothing, and labelling it as stable would be the app
        /// asserting something it was never told; the row simply shows no
        /// channel, which is the honest answer and matches how `credential`
        /// and `updates` treat an older box.
        let channel: String?
        /// The box's environment is forcing it, so the picker is shown as an
        /// answer rather than as a choice. Said before somebody taps, rather
        /// than discovered by a refusal afterwards.
        let channelPinned: Bool?
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
    /// Send a held command again, under the id it was queued with.
    func resend(_ entry: Outbox.Held) async throws -> Reply {
        try await intent(
            entry.verb,
            params: entry.params,
            host: entry.host,
            numeric: Set(entry.numeric),
            idempotencyKey: entry.id
        )
    }

    /// What the person asked for, in their words, for the pending list.
    static func describe(verb: String, params: [String: String]) -> String {
        let name = params["name"] ?? ""
        switch verb {
        case "start": return name.isEmpty ? "Starting a session" : "Starting \(name)"
        case "stop": return "Stopping \(name)"
        case "resume": return "Resuming \(name)"
        case "forget": return "Forgetting \(name)"
        case "restore": return "Restoring \(name)"
        case "purge": return "Purging \(name)"
        case "answer": return "Answering \(name)"
        case "provision": return "Asking for a \(params["platform"] ?? "temporary") machine"
        case "writefile": return "Writing \(params["path"] ?? "a file") in \(name)"
        case "copyfile": return "Copying \(params["path"] ?? "a file") in \(name)"
        case "deletefile": return "Deleting \(params["path"] ?? "a file") in \(name)"
        default: return verb
        }
    }

    private func intent(
        _ verb: String,
        params: [String: String] = [:],
        host: String? = nil,
        numeric: Set<String> = [],
        idempotencyKey: String? = nil
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
            //
            // Supplied by the caller when this command has been HELD, so a
            // retry carries the id it was queued under. Minted here only for a
            // command being sent for the first time.
            "id": idempotencyKey ?? "app-\(UUID().uuidString)",
        ]
        if let host, !host.isEmpty { body["host"] = host }
        do {
            let data = try await post("/api/intent", body: body)
            return try JSONDecoder().decode(Reply.self, from: data)
        } catch {
            // HELD, NOT LOST — but only when the fleet could not be REACHED.
            // A refusal is an answer, and replaying an answer is how somebody's
            // revoked credential retries all night. See isDeliveryFailure.
            guard idempotencyKey == nil,
                  isDeliveryFailure(error),
                  let outbox,
                  let entry = outbox.hold(verb: verb, params: params, numeric: numeric, host: host,
                                          summary: Self.describe(verb: verb, params: params))
            else { throw error }
            return Reply(
                ok: true,
                text: "Held on this phone. \(entry.summary) will be sent when the fleet answers again.",
                sessions: nil
            )
        }
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
        // NOT OVER CLEARTEXT. Every request from here carries a Bearer
        // credential, and the replies carry session names, prompts and the
        // email of whoever is signed in. On plain http all of that is readable
        // by anything between the phone and the box, and the credential is
        // replayable — a passive listener does not have to break anything, only
        // be present.
        //
        // Loopback and .local are exempt because they cannot leave the device
        // or the link, and a coordinator on the same machine is how this gets
        // developed. That is exactly the exemption Apple carved out as
        // NSAllowsLocalNetworking, so the app's ATS entry and this check agree.
        //
        // ATS was already refusing everything else — this changes the failure
        // from an opaque "could not connect" into a sentence naming the cause,
        // which is the difference between a person fixing their URL and a
        // person concluding the fleet is down.
        if url.scheme?.lowercased() != "https", !Self.isLocal(url.host) {
            throw FleetError.message(
                "Refusing to send your credential over plain http. Use https:// for \(url.host ?? "that address")."
            )
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

extension Bundle {
    /// The two numbers that identify a build, for the settings screen. The
    /// short version is what the App Store shows and is the same for every
    /// build of a release; CFBundleVersion is the one that differs.
    var shortVersion: String { infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
    var buildNumber: String { infoDictionary?["CFBundleVersion"] as? String ?? "?" }
}

extension Fleet {
    /// Somewhere cleartext cannot escape to: the device itself, or the local
    /// link. Matches ATS's NSAllowsLocalNetworking rather than inventing a
    /// second definition of "local" that would disagree with the platform.
    ///
    /// A TAILNET ADDRESS IS NOT ON THIS LIST, deliberately. It is encrypted by
    /// WireGuard, which is a good argument and the wrong layer: this app cannot
    /// tell a tailnet IP from any other address in that range, and Tailscale
    /// hands out real HTTPS certificates for ts.net names anyway. The workflow
    /// is served by `tailscale cert`, not by an exception here.
    static func isLocal(_ host: String?) -> Bool {
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        return host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host == "[::1]"
            || host.hasSuffix(".local")
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
