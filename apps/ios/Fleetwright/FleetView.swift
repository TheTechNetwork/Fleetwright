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
    /// Hosts, for the bin — which is fleet-wide and therefore needs them all.
    @State private var fleetHosts: [Fleet.FleetHost] = []
    private var binCount: Int { fleetHosts.reduce(0) { $0 + ($1.health?.bin?.count ?? 0) } }
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
                                   resume: { await act { try await fleet.resume(session.name, choice: "summary") } },
                                   forget: { await act { try await fleet.forget(session.name) } },
                                   answer: { option in
                                       await act {
                                           try await fleet.answer(session.name, option: option,
                                                                  promptId: session.prompt?.id)
                                       }
                                   })
                    }
                }
            }
            .refreshable { await refresh() }
            .navigationTitle("agent-fleet")
            .safeAreaInset(edge: .bottom) {
                // THE BIN, WITH THE SESSIONS. It sat under each host's row in
                // settings, because that is where the volumes live — an
                // implementation detail leaking into the layout. Reachable
                // when empty too: a safety net nobody can find until they need
                // it does not reassure anybody, and this one looked for a
                // while like it did not exist.
                NavigationLink {
                    RecycleBinView(settings: settings, hosts: fleetHosts) {
                        Task { await refresh(keepStatus: true) }
                    }
                } label: {
                    Label(binCount > 0 ? "Recycle bin (\(binCount))" : "Recycle bin", systemImage: "trash")
                        .font(.footnote)
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
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
                // The sheet gathers what to start and hands it up. It does not
                // wait for the answer — see startInBackground.
                StartSheet(settings: settings, onStart: startInBackground)
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
    /// Start a session without making anybody watch it happen.
    ///
    /// THE SHEET CLOSES IMMEDIATELY. Starting takes the host up to a minute —
    /// a container, a fresh volume, credentials, and the Remote Control check
    /// — and the two previous attempts at this were wrong in the same
    /// direction: first a greyed-out button that looked like a hang, then a
    /// spinner that explained the wait. Explaining a wait is still a wait.
    ///
    /// Nobody needs to be present for it, so the answer arrives as a
    /// notification and the person gets their phone back.
    ///
    /// The task is owned HERE rather than in the sheet, because a task tied to
    /// a dismissed view is one that may not finish — and this is a mutating
    /// request that has already left.
    private func startInBackground(_ request: StartRequest) {
        status = "Starting a session. You will get a notification when it is ready."
        Task {
            do {
                let reply = try await Fleet(settings: settings).start(
                    name: nil,
                    title: request.title,
                    brief: request.brief,
                    mode: request.mode,
                    host: request.host
                )
                let text = reply.text ?? "Started."
                await MainActor.run { status = text }
                LocalNotice.post(title: "Session ready", body: text)
            } catch {
                // A TIMEOUT IS NOT A FAILURE: `start` is mutating and carries
                // an idempotency key, so the session may well exist. Saying
                // "failed" would send somebody to start a second one — and the
                // second would be a second session, because a retry mints a
                // new key.
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                let text = timedOut
                    ? "Still starting, or started — the answer did not come back in time. Pull to refresh to see."
                    : error.localizedDescription
                await MainActor.run { status = text }
                LocalNotice.post(title: timedOut ? "Session may be starting" : "Could not start a session", body: text)
            }
            await refresh(keepStatus: true)
        }
    }

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
        // THE BIN'S CONTENTS, which `list` does not carry: a bin entry is not
        // a session, it is a session that stopped being one. `try?` and a
        // separate statement on purpose — a fleet call that fails must not
        // blank the session list that already arrived, and an empty bin and an
        // unreachable coordinator are allowed to look the same HERE because
        // the sessions above have already said which it was.
        fleetHosts = (try? await fleet.fleetHosts()) ?? fleetHosts
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
    let forget: () async -> Void
    let answer: (Int) async -> Void
    @State private var confirmingForget = false

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
            // Where, how long, and whose account — the three questions about a
            // session somebody started yesterday. One line, secondary, because
            // they are context rather than the point.
            HStack(spacing: 6) {
                if let host = session.hostId { Text("on \(host)") }
                if let workspace = session.workspace { Text("· \(workspace)") }
                if let age = session.age { Text("· \(age)") }
                if let account = session.account, account != "shared" {
                    // Only when it is NOT the shared account: on a fleet where
                    // nobody has linked one, this line would say the same
                    // thing on every row and mean nothing.
                    Text("· \(account)")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            // WHAT IT IS ASKING, and the answer as a row of buttons.
            //
            // This is the whole point of a notification that carries the
            // question: reading it on a phone and being unable to answer is
            // the shape of the problem, not a smaller version of it. The
            // options are the ones the HOST published — an ordinal is sent,
            // never text.
            if let prompt = session.prompt, let options = prompt.options, !options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    if let question = prompt.question, !question.isEmpty {
                        Text(question).font(.callout)
                    }
                    ForEach(options) { option in
                        Button {
                            Task { await answer(option.index) }
                        } label: {
                            HStack(spacing: 8) {
                                Text("\(option.index)")
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                Text(option.label)
                                Spacer()
                            }
                        }
                        .disabled(busy)
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.vertical, 4)
            } else if session.prompt != nil {
                // A permission dialog names a command, so without the fleet
                // switch its labels do not leave the box. Saying so beats
                // showing nothing.
                Text("Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                if !session.isRunning {
                    // Forget deletes the conversation and the workspace, which
                    // is why it is confirmed and stop is not: stop is
                    // reversible by resume, forget is reversible by nothing.
                    Button("Forget", role: .destructive) { confirmingForget = true }
                        .disabled(busy)
                }
            }
            .confirmationDialog(
                "Forget \(session.label)?",
                isPresented: $confirmingForget,
                titleVisibility: .visible
            ) {
                Button("Forget — delete its conversation and workspace", role: .destructive) {
                    Task { await forget() }
                }
            } message: {
                Text("This cannot be undone. Stop keeps everything and can be resumed; forget keeps nothing.")
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
    @State private var fleetHosts: [Fleet.FleetHost] = []
    @State private var confirmingRevoke: String?
    @State private var hostActionResult = ""
    @State private var busyHost: String?
    @State private var rebootTarget: String?
    /// Deleting for good is the one action here with no undo left, so it asks
    /// once — a confirmation nobody can tap through by accident on a phone in
    /// a pocket. `forget` deliberately does not ask, because it is reversible.
    @State private var purgeTarget: String?
    @State private var rebootPin = ""
    @State private var rebootConfirm = ""

    // CHECK AND APPLY, SEPARATELY, FOR BOTH — which is what was asked for and
    // what the verbs always supported. The app had it backwards in two
    // different directions: Update always restarted (apply with no check) and
    // Upgrade never applied (check with no apply).
    private enum Maintenance { case check, applyUpdate, applyUpgrade, rebootAsk, rebootDo }

    /// One place for all four, so the busy flag and the result text cannot
    /// drift apart between them.
    @MainActor
    private func maintain(_ host: String, _ what: Maintenance) async {
        busyHost = host
        defer { busyHost = nil }
        do {
            let fleet = Fleet(settings: settings)
            let reply: Fleet.Reply
            switch what {
            // The check is `upgrade` with apply off — the verb's own reporting
            // mode. It refreshes what the OS knows; the git side is already in
            // health, recomputed when the host next reports.
            case .check: reply = try await fleet.upgrade(host: host)
            case .applyUpdate: reply = try await fleet.update(host: host, restart: true)
            case .applyUpgrade: reply = try await fleet.upgrade(host: host, apply: true)
            case .rebootAsk: reply = try await fleet.reboot(host: host)
            case .rebootDo:
                reply = try await fleet.reboot(host: host, pin: rebootPin, confirm: rebootConfirm)
                rebootTarget = nil
                rebootPin = ""
                rebootConfirm = ""
            }
            hostActionResult = reply.text ?? ""
        } catch {
            hostActionResult = error.localizedDescription
        }
        await loadHosts()
    }

    /// Restore or purge, in one place so the busy flag and the result text
    /// cannot drift apart — the same reason `maintain` exists.
    @MainActor
    private func binAction(_ name: String, restore: Bool) async {
        busyHost = name
        defer { busyHost = nil }
        do {
            let fleet = Fleet(settings: settings)
            let reply = restore ? try await fleet.restore(name) : try await fleet.purge(name)
            hostActionResult = reply.text ?? ""
        } catch {
            hostActionResult = error.localizedDescription
        }
        purgeTarget = nil
        await loadHosts()
    }

    @MainActor
    private func loadHosts() async {
        guard !settings.credential.isEmpty else { return }
        // Both lists: enrolled is the membership (fingerprints, revocation),
        // fleet is what they are saying right now. Different questions.
        fleetHosts = (try? await Fleet(settings: settings).fleetHosts()) ?? []
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
                        // ONE TAP INTO A FLEET THAT ISN'T REAL.
                        //
                        // The demo credential has existed since App Review
                        // needed one, and reaching it meant finding a token in
                        // a deployment document and pasting it into a
                        // collapsed field labelled "credential" — which is a
                        // fair description of "no demo at all" for anybody who
                        // is not already reading the repo.
                        //
                        // It fills an EMPTY coordinator field rather than
                        // overwriting one: somebody who has already pointed
                        // this app at their own fleet and taps the wrong row
                        // must not lose it.
                        Button("Look around the demo fleet") {
                            // The real coordinator is REMEMBERED, not
                            // discarded. Somebody who has already pointed this
                            // app at their own fleet and taps out of curiosity
                            // must get it back when they leave — losing it
                            // would mean re-typing a URL to undo a tap.
                            if !settings.coordinatorURL.isEmpty
                                && !Demo.isActive(settings.coordinatorURL) {
                                settings.urlBeforeDemo = settings.coordinatorURL
                            }
                            settings.coordinatorURL = Demo.coordinatorURL
                            settings.signedInAs = Demo.label
                            settings.credential = Demo.credential
                            onDone()
                        }
                    } else if Demo.isActive(settings.coordinatorURL) {
                        // Said plainly, and never as "signed in". Every reply
                        // from this fleet carries `demo: true`, and a person
                        // wondering why their machines are missing deserves the
                        // answer on the screen rather than in a support thread.
                        LabeledContent("Demo") { Text("invented hosts and sessions") }
                        Button("Leave the demo") {
                            settings.signOut()
                            settings.coordinatorURL = settings.urlBeforeDemo
                            settings.urlBeforeDemo = ""
                        }
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
                         + "Choose \"Share My Email\" — a fleet allows people by address, and a hidden one matches nothing. "
                         + "No account? The demo is two invented machines and needs nothing.")
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
                        if let target = purgeTarget {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Delete \(target) for good?").font(.callout)
                                Text("The conversation and the workspace go with it. This is the only step here that cannot be undone — forgetting was reversible, this is not.")
                                    .font(.caption2).foregroundStyle(.secondary)
                                HStack(spacing: 12) {
                                    Button("Delete", role: .destructive) { Task { await binAction(target, restore: false) } }
                                    Button("Cancel") { purgeTarget = nil }
                                }
                                .font(.caption)
                                .buttonStyle(.borderless)
                            }
                        }
                        if let target = rebootTarget {
                        // Step two, in the app: the pin the host issued and
                        // the hostname typed out. Both come from the person,
                        // and the pin comes from the box — a coordinator that
                        // could mint it could reboot the fleet.
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Reboot \(target)").font(.callout)
                            Text("Every running session on it dies.").font(.caption2).foregroundStyle(.secondary)
                            TextField("Pin from the box", text: $rebootPin)
                                .keyboardType(.numberPad)
                            TextField("Type the hostname to confirm", text: $rebootConfirm)
                                .autocorrectionDisabled()
                            HStack {
                                Button("Ask for a pin") { Task { await maintain(target, .rebootAsk) } }
                                Spacer()
                                Button("Reboot", role: .destructive) { Task { await maintain(target, .rebootDo) } }
                                    .disabled(rebootPin.isEmpty || rebootConfirm != target)
                                Button("Cancel") { rebootTarget = nil }
                            }
                            .font(.caption)
                        }
                        .padding(.vertical, 4)
                    }
                    if !hostActionResult.isEmpty {
                    // MONOSPACED, SELECTABLE, AND ALLOWED TO BE TALL. This is a
                    // host's own output — several lines of it, with paths and
                    // commit ids in — and it was being rendered as a squeezed
                    // grey caption that ran together into one paragraph.
                    ScrollView {
                        Text(hostActionResult)
                            .font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                }
                Text("A pin is good for ten minutes, once. Revoking a host disconnects it as well.")
                    }
                }

                // "Use a credential instead" WAS HERE, and is gone.
                //
                // It existed for two things. The first was App Review, which
                // needed a way in that no allowlist could grant — now a button
                // in the section above, because asking a reviewer to find a
                // token in a deployment document and paste it into a field
                // labelled "credential" is a fair description of no demo at
                // all.
                //
                // The second was getting back in when sign-in itself is
                // broken. That is a real need and it is now served by curl with
                // the API token rather than by a field in everybody's settings.
                // A box that asks for a token, in front of every user, is how
                // the shared-secret habit comes back — and a recovery path only
                // the operator needs does not belong on the operator's users'
                // screens.

                // Push is the one feature that fails silently. A registration
                // that never arrived and a coordinator with no sender
                // configured look identical from a phone, which is to say they
                // look like nothing at all. This asks for one now and reports
                // what happened, so the answer arrives before the notification
                // that matters does.
                // WHAT EACH BOX SAYS ABOUT ITSELF. Asked for directly — "we
                // need the sign-in status and logs available on the app" —
                // and this is the first half: the answer to "is that box
                // logged in, on what plan, running what code" without SSH.
                Section {
                    if fleetHosts.isEmpty {
                        Text("No hosts reporting yet.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(fleetHosts) { host in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(host.hostId).font(.system(.body, design: .monospaced))
                                Spacer()
                                Text(host.state ?? "unknown")
                                    .font(.caption)
                                    // Colour reinforces the word; it never
                                    // carries the meaning alone.
                                    .foregroundStyle(host.state == "healthy" ? .green : .orange)
                            }
                            // The registry works to make "we don't know"
                            // unrepresentable as a benign value. Rendering the
                            // reason verbatim is what makes that work visible.
                            if let reason = host.reason, !reason.isEmpty {
                                Text(reason).font(.caption2).foregroundStyle(.secondary)
                            }
                            if let account = host.health?.account {
                                // Built in a function, not as a chain of `+`
                                // with optional maps inside it: that shape is
                                // what made the Swift type checker give up in
                                // #125, and it fails at BUILD time on CI
                                // rather than anywhere I can see it.
                                Text(describeAccount(account))
                                    .font(.caption2).foregroundStyle(.secondary)
                            } else if host.health?.loggedIn == false {
                                // Said plainly, because this is the single
                                // most common cause of a session that starts
                                // and then does nothing.
                                Text("NOT signed in — sessions will not start")
                                    .font(.caption2).foregroundStyle(.red)
                            }
                            if let version = host.health?.version?.head {
                                let behind = host.health?.updates?.appBehind ?? 0
                                Text(describeVersion(version, behind: behind))
                                    .font(.caption2)
                                    .foregroundStyle(behind > 0 ? .orange : .secondary)
                            }
                            // WHAT THE OS HAS WAITING. The host has been
                            // sending this since maintenance shipped and
                            // nothing displayed it, which is why upgrade
                            // looked like a verb that could only report.
                            if let system = host.health?.updates?.system, !system.isEmpty {
                                Text(system).font(.caption2).foregroundStyle(.orange)
                            }
                            if host.health?.updates?.rebootRequired == true {
                                Text("reboot required").font(.caption2).foregroundStyle(.orange)
                            }
                            // MAINTENANCE, which used to need SSH. Update is
                            // safe and idempotent so it is one tap; reboot is
                            // two steps and asks for the hostname, exactly as
                            // it does in chat — a remote reboot should be
                            // harder than a local one, not easier.
                            // Check always; apply only when there is something
                            // to apply. A button that is always offered teaches
                            // people to press it without reading, which is the
                            // opposite of what a maintenance screen is for.
                            HStack(spacing: 12) {
                                Button("Check") { Task { await maintain(host.hostId, .check) } }
                                if host.health?.updates?.appPending == true {
                                    Button("Apply update") { Task { await maintain(host.hostId, .applyUpdate) } }
                                }
                                if host.health?.updates?.systemPending == true {
                                    Button("Apply upgrade") { Task { await maintain(host.hostId, .applyUpgrade) } }
                                }
                                Button("Reboot", role: .destructive) { rebootTarget = host.hostId }
                            }
                            .font(.caption)
                            .buttonStyle(.borderless)
                            .disabled(busyHost != nil)
                            // CLAUDE SIGN-IN IS THE ONLY PER-MACHINE ONE, and
                            // this row is where it belongs: it is a login the
                            // BOX performs in a pane, not a token that travels.
                            //
                            // GitHub and Cloudflare moved out to their own
                            // section — they are the person's, they go to every
                            // machine, and keeping them under a host
                            // contradicted the sentence at the bottom of the
                            // screen that said so.
                            NavigationLink("Sign in to Claude") {
                                CredentialsView(settings: settings, host: host.hostId, onlyClaude: true)
                            }
                            .font(.caption)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Fleet")
                } footer: {
                    Text("What each machine reports about itself: whether it is signed in, which plan, "
                         + "and whether its code is behind.")
                }

                // YOUR credentials, not a machine's. Top level, because a
                // token is the person's and reaches every host — which is what
                // the screen said while living under one particular box.
                if !settings.credential.isEmpty {
                    Section {
                        NavigationLink("Your credentials") {
                            CredentialsView(settings: settings, host: nil)
                        }
                    } footer: {
                        Text("GitHub and Cloudflare, on every machine in the fleet. Signing in to Claude is "
                             + "per machine and lives with the machine.")
                    }
                }

                // Kinds, and the toggle that decides what a spoken start does
                // to your screen.
                Section {
                    NavigationLink("Session kinds") { SessionKindsView() }
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

                    Saying "and open it" brings the app forward; plain "start a session" does \
                    not. Two phrases rather than a setting, because an intent from an \
                    automation often runs when nobody is looking at the phone — and which of \
                    those you meant is clearer as you say it.
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
                        // The refusal reaches the screen. This was `_ = try?`,
                        // which discarded the error AND the reply — so a 403
                        // ("removing machines needs an admin credential")
                        // closed the sheet and showed nothing, and the symptom
                        // was reported as "the host comes right back". A
                        // refusal the user never sees costs a night; a
                        // sentence costs a sentence.
                        do {
                            hostActionResult = try await Fleet(settings: settings).revokeHost(hostId).text ?? ""
                        } catch {
                            hostActionResult = error.localizedDescription
                        }
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


/// "signed in as a@b.com · max · Example Org", built a piece at a time.
///
/// A plain function rather than an expression in the view: a chain of `+`
/// with optional maps inside it is what made the Swift type checker give up
/// in #125, and that failure only appears on CI.
private func describeAccount(_ account: Fleet.HostHealth.Account) -> String {
    var parts: [String] = ["signed in as \(account.email ?? "unknown")"]
    if let plan = account.plan, !plan.isEmpty { parts.append(plan) }
    if let org = account.org, !org.isEmpty { parts.append(org) }
    return parts.joined(separator: " · ")
}

/// "forgotten · 3 days left", built a piece at a time rather than inline: a
/// chain of `+` over optionals is what made the Swift type checker give up in
/// #125, and that failure only shows up on CI.
private func describeBinned(_ item: Fleet.Binned) -> String {
    var parts: [String] = ["forgotten"]
    if item.title != nil { parts.append(item.name) }
    if let remaining = item.remaining { parts.append(remaining) }
    return parts.joined(separator: " · ")
}

/// "running abc1234 · 3 commits behind", or "· up to date".
private func describeVersion(_ head: String, behind: Int) -> String {
    if behind <= 0 { return "running \(head) · up to date" }
    let plural = behind == 1 ? "commit" : "commits"
    return "running \(head) · \(behind) \(plural) behind"
}
