import AppIntents
import AuthenticationServices
import SwiftUI
import UIKit

/// The whole app: what is running, and the three things you would want to do
/// about it from a phone.
///
/// Every action is an intent to the coordinator. The app never talks to a host
/// directly, so it never has to know which box holds which session — that is
/// exactly what the coordinator is for.
struct FleetView: View {
    let settings: Settings

    @State private var sessions: [Fleet.Session] = []
    @State private var status = ""
    @State private var busy = false
    @State private var showingSettings = false
    @State private var showingStart = false

    var body: some View {
        NavigationStack {
            List {
                if !status.isEmpty {
                    Section { Text(status).font(.system(.footnote, design: .monospaced)) }
                }
                Section {
                    if sessions.isEmpty && !busy {
                        Text("No sessions. Pull to refresh, or start one.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(sessions) { session in
                        SessionRow(session: session, busy: busy, stop: { await act { try await fleet.stop(session.name) } },
                                   resume: { await act { try await fleet.resume(session.name, choice: "summary") } })
                    }
                }
            }
            .refreshable { await refresh() }
            .navigationTitle("agent-fleet")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Settings") { showingSettings = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Opens the sheet rather than starting immediately. The
                    // one-tap start is still there — leaving the sheet blank
                    // and pressing Start is the same thing — but a session
                    // nobody described is one nobody recognises in a week.
                    Button("New") { showingStart = true }
                        .disabled(busy || !settings.configured)
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView(settings: settings) { Task { await refresh() } }
            }
            .sheet(isPresented: $showingStart) {
                StartSheet(settings: settings) { text in
                    status = text
                    Task { await refresh(keepStatus: true) }
                }
            }
            .task { await refresh() }
            .onAppear { if !settings.configured { showingSettings = true } }
        }
    }

    private var fleet: Fleet { Fleet(settings: settings) }

    /// - Parameter keepStatus: keep whatever is already on screen if the list
    ///   call succeeds. Set after an action, whose reply text is the only
    ///   confirmation the coordinator ever gives — a plain refresh would wipe
    ///   "Started cc-brave-otter." a few hundred milliseconds after it appeared.
    private func refresh(keepStatus: Bool = false) async {
        guard settings.configured else { return }
        busy = true
        defer { busy = false }
        do {
            let reply = try await fleet.list()
            sessions = reply.sessions ?? []
            // A failure is shown, never swallowed: "nothing here" and "I could
            // not reach the coordinator" look identical otherwise, and they are
            // completely different problems.
            if reply.ok == false {
                status = reply.text ?? ""
            } else if !keepStatus {
                status = ""
            }
        } catch {
            status = error.localizedDescription
        }
    }

    private func act(_ work: () async throws -> Fleet.Reply) async {
        busy = true
        do {
            status = try await work().text ?? ""
        } catch {
            status = error.localizedDescription
        }
        busy = false
        await refresh(keepStatus: true)
    }
}

private struct SessionRow: View {
    let session: Fleet.Session
    let busy: Bool
    let stop: () async -> Void
    let resume: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.label).font(.headline)
                Spacer()
                StatusBadge(status: session.status)
            }
            // Both are shown when they differ: the title is what a person
            // recognises, the name is what everything else keys on.
            if session.label != session.name {
                Text(session.name).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            if let host = session.hostId {
                Text("on \(host)").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                if session.isRunning {
                    Button("Stop") { Task { await stop() } }.disabled(busy)
                    if let url = session.rcUrl, let link = URL(string: url) {
                        // The button that turns a notification into actually
                        // driving the session.
                        Link("Open", destination: link)
                    }
                } else if session.isResumable {
                    Button("Resume") { Task { await resume() } }.disabled(busy)
                }
            }
            .font(.callout)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }
}

private struct SettingsView: View {
    let settings: Settings
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pushResult = ""
    @State private var signInResult = ""
    @State private var signingIn = false
    @State private var pin = ""
    @State private var hosts: [Fleet.Host] = []
    @State private var showingAdvanced = false
    @State private var pastedCredential = ""
    @State private var confirmingRevoke: String?

    @MainActor
    private func loadHosts() async {
        guard !settings.credential.isEmpty else { return }
        hosts = (try? await Fleet(settings: settings).enrolledHosts()) ?? []
    }

    /// 123 456 — read down a phone, typed into a terminal.
    private var formattedPin: String {
        pin.count == 6 ? "\(pin.prefix(3)) \(pin.suffix(3))" : pin
    }

    /// Deliberately NOT `@MainActor` on the function itself.
    ///
    /// It is handed to `SignInWithAppleButton` as a plain closure, and a
    /// global-actor-isolated function converted to a non-isolated one loses its
    /// isolation — a warning today and an error under Swift 6. `Task { @MainActor in }`
    /// says the same thing where it is actually needed, which is every line
    /// below: the state, the settings object and `UIDevice` are all main-actor.
    private func signIn(_ result: Result<ASAuthorization, Error>) {
        Task { @MainActor in
            signingIn = true
            signInResult = "signing in…"
            defer { signingIn = false }
            do {
                let idToken = try SignIn.identityToken(from: result)
                let issued = try await Fleet(settings: settings).signIn(
                    idToken: idToken,
                    // Names the credential in the fleet's device list, and it is
                    // the difference between "revoke the right phone" and
                    // "revoke one of three called iPhone".
                    deviceName: UIDevice.current.name
                )
                settings.credential = issued.token
                settings.signedInAs = issued.email
                signInResult = ""
                await loadHosts()
                onDone()
            } catch SignIn.Failure.cancelled {
                signInResult = ""
            } catch {
                signInResult = error.localizedDescription
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                // header:/footer: closures rather than Section("title") { } —
                // there is no initialiser taking a String title AND a footer,
                // which the first real compile caught.
                Section {
                    TextField("https://fleet.thetech.network", text: Bindable(settings).coordinatorURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                } header: {
                    Text("Coordinator")
                } footer: {
                    Text("The one origin this app will talk to.")
                }

                Section {
                    if settings.credential.isEmpty {
                        SignInWithAppleButton(.signIn, onRequest: SignIn.configure, onCompletion: signIn)
                            .signInWithAppleButtonStyle(.black)
                            .frame(height: 44)
                            .disabled(settings.coordinatorURL.isEmpty || signingIn)
                    } else {
                        LabeledContent("Signed in") {
                            Text(settings.signedInAs.isEmpty ? "this device" : settings.signedInAs)
                        }
                        Button("Sign out", role: .destructive) { settings.signOut() }
                    }
                    if !signInResult.isEmpty {
                        Text(signInResult).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("You")
                } footer: {
                    // Two things worth saying before somebody hits the button
                    // and gets a refusal they cannot interpret: the fleet is a
                    // list of allowed addresses, and Hide My Email can never be
                    // on it.
                    Text("This device gets a credential of its own, kept in the keychain and revocable on its own. "
                         + "Choose \"Share My Email\" — a fleet allows people by address, and a hidden one matches nothing.")
                }

                // Adding a machine. Deliberately here rather than buried: it is
                // the second thing anybody does after signing in, and the pin
                // is the whole of how a host joins now.
                if !settings.credential.isEmpty {
                    Section {
                        Button("Mint a pin for a new host") {
                            Task {
                                pin = ""
                                do {
                                    pin = try await Fleet(settings: settings).mintHostPin()
                                } catch {
                                    signInResult = error.localizedDescription
                                }
                            }
                        }
                        if !pin.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(formattedPin).font(.system(.title, design: .monospaced))
                                    .textSelection(.enabled)
                                Text("On that box:  agent-fleet-sidecar enrol \(pin)")
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        ForEach(hosts) { host in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(host.hostId).font(.headline)
                                    if host.isRevoked {
                                        Text("revoked").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                // The fingerprint is here so it can be compared
                                // with what the box itself prints. Two machines
                                // claiming one name is exactly the situation
                                // where you need to know which key is which.
                                Text(host.fingerprint)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            .swipeActions {
                                if !host.isRevoked {
                                    // Asked first. A swipe and a tap is not a
                                    // deliberate enough gesture for something
                                    // that disconnects a machine mid-session
                                    // and can only be undone by typing a new
                                    // pin on the box — which is the errand this
                                    // app exists to avoid.
                                    Button("Revoke", role: .destructive) { confirmingRevoke = host.hostId }
                                }
                            }
                        }
                    } header: {
                        Text("Hosts")
                    } footer: {
                        Text("A pin is good for ten minutes, once. Revoking a host disconnects it as well.")
                    }
                }

                // The way in that does not involve an identity provider.
                //
                // Two real needs, neither of which sign-in covers. App Review
                // has to be able to run the app, and no reviewer's address is
                // on anybody's allowlist — the public demo credential exists
                // for exactly that and reaches a coordinator with no hosts on
                // it. And when sign-in itself is what is broken, the admin
                // credential is how an operator gets back in.
                //
                // Collapsed, and it says what it is: a field labelled "token"
                // in front of everybody is how the shared-secret habit comes
                // back.
                Section {
                    DisclosureGroup("Use a credential instead", isExpanded: $showingAdvanced) {
                        SecureField("fwk_… or a demo credential", text: $pastedCredential)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button("Use it") {
                            settings.credential = pastedCredential.trimmingCharacters(in: .whitespacesAndNewlines)
                            settings.signedInAs = ""
                            pastedCredential = ""
                            showingAdvanced = false
                            onDone()
                        }
                        .disabled(pastedCredential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } footer: {
                    Text("For App Review's demo fleet, and for getting back in when sign-in is what is broken.")
                }

                // Push is the one feature that fails silently. A registration
                // that never arrived and a coordinator with no sender
                // configured look identical from a phone, which is to say they
                // look like nothing at all. This asks for one now and reports
                // what happened, so the answer arrives before the notification
                // that matters does.
                // Kinds, and the toggle that decides what a spoken start does
                // to your screen.
                Section {
                    NavigationLink("Session kinds") { SessionKindsView() }
                    Toggle("Open the app after starting", isOn: Binding(
                        get: { settings.autoOpenAfterStart },
                        set: { settings.autoOpenAfterStart = $0 }
                    ))
                    // Two taps to a phrase with no app name in it at all.
                    //
                    // Apple requires the app name in the phrases WE ship, which
                    // means the built-in ones make somebody say a brand to reach
                    // their own work. A shortcut they make themselves has no
                    // such rule: they can call it "Debbie", or "another remote
                    // session", or whatever they already call this in their
                    // head — and that is the name that will still be there in a
                    // month, because it was theirs before we arrived.
                    NavigationLink("Say it your way") { ShortcutSetupView(settings: settings) }
                    ShortcutsLink()
                } header: {
                    Text("Siri and Shortcuts")
                } footer: {
                    // A multi-line literal, not a chain of `+`. Five string
                    // literals joined with + is enough to make Swift's type
                    // checker give up — "unable to type-check this expression
                    // in reasonable time" — because each + is an overloaded
                    // operator it has to resolve against every candidate. This
                    // is one literal and one expression.
                    Text("""
                    Say "start a dev session on my fleet". "my fleet", "my agents" and \
                    "remote sessions" all work, so there is no product name to remember.

                    For a phrase of your own — "Debbie", or anything else you call this — \
                    tap "Say it your way" above.

                    Opening the app is off by default: an intent from an automation often \
                    runs when nobody is looking at the phone.
                    """)
                }

                Section {
                    Button("Send a test notification") {
                        Task {
                            pushResult = "sending…"
                            do {
                                pushResult = try await Fleet(settings: settings).testPush(token: nil).text ?? "Sent."
                            } catch {
                                pushResult = error.localizedDescription
                            }
                        }
                    }
                    .disabled(!settings.configured)
                    if !pushResult.isEmpty {
                        Text(pushResult).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Notifications")
                }
            }
            .navigationTitle("Settings")
            .task { await loadHosts() }
            .alert(
                "Revoke \(confirmingRevoke ?? "")?",
                isPresented: Binding(get: { confirmingRevoke != nil }, set: { if !$0 { confirmingRevoke = nil } })
            ) {
                Button("Cancel", role: .cancel) { confirmingRevoke = nil }
                Button("Revoke", role: .destructive) {
                    guard let hostId = confirmingRevoke else { return }
                    confirmingRevoke = nil
                    Task {
                        _ = try? await Fleet(settings: settings).revokeHost(hostId)
                        await loadHosts()
                    }
                }
            } message: {
                Text("It is disconnected immediately, and its sessions keep running without it. "
                     + "Getting it back means a new pin, typed on that box.")
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onDone(); dismiss() }
                }
            }
        }
    }
}

/// A session's state, as a symbol AND a word.
///
/// Never colour alone. The symbol is a shape and the word is a word; the tint
/// only reinforces what both already say. That is what "differentiate without
/// colour" asks for, and it is also the difference between a glanceable list
/// and a pretty one — colour vision deficiency affects around one man in
/// twelve, and everybody loses colour in bright sun.
private struct StatusBadge: View {
    let status: String

    private var symbol: String {
        switch status {
        case "running": return "play.circle.fill"
        case "awaiting-input": return "exclamationmark.bubble.fill"
        case "stopped": return "pause.circle"
        case "ended": return "checkmark.circle"
        default: return "questionmark.circle"
        }
    }

    private var tint: Color {
        switch status {
        case "running": return .accentColor
        case "awaiting-input": return .orange
        default: return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            // Decorative: the word beside it is the label, and VoiceOver
            // announcing "play circle fill, running" is worse than "running".
            Image(systemName: symbol)
                .accessibilityHidden(true)
            Text(status)
        }
        .font(.caption)
        .foregroundStyle(tint)
    }
}


/// Editing the words Siri will recognise.
///
/// Deliberately plain. This is a list somebody visits twice — once to add
/// "dev", once more a month later — and anything cleverer than a list and a
/// text field is design nobody asked for on a screen nobody looks at.
struct SessionKindsView: View {
    @State private var kinds: [SessionKind] = SessionKinds.all()
    @State private var newWord = ""

    var body: some View {
        Form {
            Section {
                ForEach($kinds) { $kind in
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("Word", text: $kind.word)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        TextField("Title prefix (optional)", text: $kind.titlePrefix)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete { idx in
                    idx.map { kinds[$0].id }.forEach(SessionKinds.remove)
                    kinds.remove(atOffsets: idx)
                }
                HStack {
                    TextField("Add a word", text: $newWord)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Add") {
                        let word = newWord.trimmingCharacters(in: .whitespaces)
                        guard !word.isEmpty else { return }
                        kinds.append(SessionKind(word: word))
                        newWord = ""
                        SessionKinds.save(kinds)
                    }
                    .disabled(newWord.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("Words")
            } footer: {
                // Said, because otherwise the first thing anybody does is add a
                // word and then wonder why Siri has not heard of it.
                Text("""
                Say "start a dev session on my fleet". A new word can take a moment before \
                Siri recognises it. A prefix groups sessions in the list: "dev: refactor auth".
                """)
            }
        }
        .navigationTitle("Session kinds")
        // Saved on the way out rather than on every keystroke: this writes the
        // whole list, and doing that per character would rewrite it a hundred
        // times while somebody types one word.
        .onDisappear { SessionKinds.save(kinds) }
    }
}
