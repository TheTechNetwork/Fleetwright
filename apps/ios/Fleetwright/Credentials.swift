import SwiftUI

/// Connecting the credentials a session needs, from a phone.
///
/// The reason this exists at all: a guest brings their own GitHub, Cloudflare
/// and Claude accounts and has no shell on any box. For them "SSH in and run
/// `claude login`" is not a smaller inconvenience — it is the whole feature
/// missing.
///
/// THE PROVIDER LIST IS NOT IN THIS FILE. It arrives from the host, with the
/// real URLs and the real scopes, and a provider added to the host's table
/// shows up here on the next refresh without an App Store release. That is the
/// entire reason the verbs are connect/link/unlink rather than one verb per
/// vendor — and it is why this view has no `switch provider` in it.
struct CredentialsView: View {
    let settings: Settings
    /// Which box to ASK, when the question is about one. Nil is the normal
    /// case now: this screen is FLEET-WIDE, because a token is the person's.
    ///
    /// It used to live under a host row, which contradicted the sentence at
    /// the bottom of it — "a token goes to every machine in the fleet". Only
    /// the Claude sign-in is genuinely per machine, and that stays on the host
    /// it signs in.
    ///
    /// `connect` is a question — what could I connect, and what have I — and
    /// one box answers it for the fleet, since the catalogue is identical
    /// everywhere. A CLAUDE sign-in is genuinely per machine: it is a login
    /// the box performs in a pane, so both halves must reach the same one.
    ///
    /// A TOKEN is not. It belongs to the person, so `link` fans out to every
    /// host and this value is not sent — which is why the screen no longer
    /// says "credentials on <box>". Connecting a GitHub token again on every
    /// machine, and again on each one enrolled later, is bookkeeping the fleet
    /// exists to remove.
    let host: String?
    /// The per-machine half. A host row shows Claude and nothing else; the
    /// fleet-wide screen shows everything else.
    var onlyClaude: Bool = false

    @State private var connections = Fleet.Connections()
    @State private var pending: Fleet.Connections.Available?
    @State private var secret = ""
    @State private var result = ""
    @State private var busy = false
    @State private var loaded = false
    /// The last answer per provider, kept so the detail can be reopened
    /// without asking the provider again.
    @State private var checks: [String: Fleet.Check] = [:]
    @State private var expanded: Set<String> = []

    var body: some View {
        List {
            Section {
                ForEach(connections.catalogue.filter { $0.isSignIn == onlyClaude }) { provider in
                    row(provider)
                }
            } header: {
                Text(onlyClaude ? "Claude on \(host ?? "this machine")" : "Your credentials")
            } footer: {
                // "Signing in to Claude is per machine: that one is a login the
                // box performs" was true and is not any more. A machine has no
                // Claude account — see docs/one-account-per-person.md — and a
                // sentence describing one is how somebody spends an evening
                // looking for a button that should not exist.
                Text(onlyClaude
                     ? "This machine has no Claude account of its own. Sessions run on the account of whoever "
                       + "started them, so connecting here links YOURS — and somebody who has not connected "
                       + "one cannot start a session on this box."
                     : "Each one is created on the provider's own page, on your account, and can be "
                       + "revoked there at any time. A token goes to every machine in the fleet, because "
                       + "it is yours rather than any one box's — sessions you start get it, and nobody "
                       + "else's do. Claude is per person too: a session runs on the account of whoever "
                       + "started it.")
            }

            if let pending {
                Section {
                    // NUMBERED, because this is a flow that leaves the app and
                    // comes back, and "tap the link, then paste" was being
                    // shown as two controls with no order between them. The
                    // person is holding a phone, in a browser, on somebody
                    // else's website, and has to know what they are coming
                    // back to do.
                    if let url = pending.url {
                        if pending.isAppFlow {
                            // ONE TAP, because this flow has a callback. The
                            // page redirects to our own scheme when it is
                            // done, so the app can wait for it instead of
                            // asking somebody to come back and confirm the
                            // thing that already happened.
                            Button {
                                Task { await authorize(pending, url: url) }
                            } label: {
                                Label("Connect \(pending.label)", systemImage: "arrow.up.forward.app")
                            }
                            .disabled(busy)
                        } else if let link = URL(string: url) {
                            // NUMBERED, because this flow does NOT come back:
                            // there is a token to copy, and no redirect to wait
                            // for. Opening it in an embedded browser would open
                            // a window that never closes itself, which is worse
                            // than a link that is honest about leaving.
                            Link(destination: link) {
                                Label(
                                    pending.isSignIn ? "1. Open the sign-in page" : "1. Open \(pending.label) and create the token",
                                    systemImage: "arrow.up.forward.app",
                                )
                            }
                        }
                    }
                    Text(pending.hint).font(.caption).foregroundStyle(.secondary)

                    // NO PASTE FIELD FOR AN APP FLOW, because there is nothing
                    // to copy. GitHub sends the result to the coordinator,
                    // which hands it to the box over the socket it already
                    // holds. A token field here would be asking somebody for
                    // something that does not exist.
                    if pending.isAppFlow {
                        // No step 2. The button above is the whole flow now;
                        // "Done" existed only so somebody could tell the app
                        // what it could have watched for itself.
                        Button("Cancel", role: .cancel) { clear() }
                    } else {
                        Text(pending.isSignIn ? "2. Come back and paste the code" : "2. Come back and paste the token")
                            .font(.caption)
                        HStack {
                            // The one field in this app that holds a live
                            // credential. Never a TextField: iOS would offer to
                            // autocorrect it, capitalise it and remember it in
                            // the keyboard cache.
                            SecureField(pending.isSignIn ? "Code" : "Token", text: $secret)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            // ONE TAP INSTEAD OF A LONG PRESS. PasteButton is
                            // user-initiated and consented by construction — it
                            // reads the clipboard only when tapped, so nothing
                            // here sees what was copied unless somebody asks.
                            PasteButton(payloadType: String.self) { items in
                                guard let first = items.first else { return }
                                Task { @MainActor in secret = first.trimmingCharacters(in: .whitespacesAndNewlines) }
                            }
                            .labelStyle(.iconOnly)
                            .buttonBorderShape(.capsule)
                        }

                        Button("3. Connect \(pending.label)") { Task { await link(pending) } }
                            .disabled(secret.isEmpty || busy)
                        Button("Cancel", role: .cancel) { clear() }
                    }
                } header: {
                    Text(pending.label)
                } footer: {
                    // `host` is optional now that this screen is fleet-wide, and
                    // interpolating an optional renders `Optional("deb132")` to
                    // a person. The compiler says so; it was a warning rather
                    // than an error, which is exactly how that reaches a user.
                    Text(pending.isSignIn
                         ? "This page was generated by \(host ?? "that machine") for this attempt, and the code goes back to the same box."
                         : "It is checked with \(pending.label) before it is stored, so a typo fails here and not four hours into a session.")
                }
            }

            if !result.isEmpty {
                Section { Text(result).font(.callout) }
            }
        }
        .navigationTitle("Credentials")
        .task {
            guard !loaded else { return }
            loaded = true
            await load()
        }
        // The browser came back. Reload rather than believe it: the URL says a
        // flow finished, and what is actually stored is the host's to report.
        .onReceive(NotificationCenter.default.publisher(for: .credentialsChanged)) { _ in
            pending = nil
            secret = ""
            Task { await load() }
        }
    }

    @ViewBuilder
    private func row(_ provider: Fleet.Connections.Available) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(provider.label)
            if let linked = connections.linked(provider.provider) {
                Text(describeLinked(linked)).font(.caption).foregroundStyle(.secondary)
                // MISSING PERMISSIONS, said here rather than discovered in a
                // session. The asked-for list grows; a token minted before it
                // grew still verifies, still says "connected", and then fails
                // at whatever step needs the scope it never had.
                // THE ONE THAT NEEDS ACTING ON, above the scope detail because
                // it is more urgent than any of it: the token works right now
                // and stops within the day.
                if linked.needsReconnect == true {
                    Text("Reconnect this — it still works but can no longer renew itself, so it stops within "
                         + "eight hours. One tap below; nothing to copy or paste.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                if let missing = linked.missing, !missing.isEmpty {
                    Text("missing \(missing.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                // WHERE IT ACTUALLY IS. A credential reaches the machines that
                // were reachable when it was stored — so a host enrolled
                // afterwards has none, and "connected" on its own implies a
                // uniformity the fleet does not have. Connecting again covers
                // the stragglers, which is why this says so rather than
                // leaving somebody to discover it inside a session.
                if let absent = linked.absentFrom, !absent.isEmpty {
                    Text("not on \(absent.joined(separator: ", ")) — connect again to include \(absent.count == 1 ? "it" : "them")")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            } else {
                Text("not connected").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button(actionLabel(provider, connections.linked(provider.provider))) {
                    Task { await begin(provider) }
                }
                if connections.linked(provider.provider) != nil {
                    // TEST, because "connected" is a fact about storage and not
                    // about the token. It can be revoked, expire, or have its
                    // permissions narrowed at the provider long after it was
                    // stored, and nothing here would know until a session
                    // failed four hours in.
                    Button("Test") { Task { await check(provider) } }
                    Button("Forget", role: .destructive) { Task { await forget(provider) } }
                }
            }
            .font(.caption)
            .buttonStyle(.borderless)
            .disabled(busy)

            // WHAT IT CAN DO, once somebody has asked. Collapsed by default:
            // a list of scopes is the answer to a question, not something to
            // read every time this screen opens.
            if let result = checks[provider.provider] {
                DisclosureGroup(describeCheck(result), isExpanded: bindingForDetail(provider.provider)) {
                    if let granted = result.granted, !granted.isEmpty {
                        Text("Has: \(granted.joined(separator: ", "))").font(.caption2)
                    } else if result.granted == nil {
                        // TWO DIFFERENT REASONS FOR THE SAME NIL, and telling
                        // them apart is the difference between "this is fine"
                        // and "we could not check". Cloudflare has nothing a
                        // token may read about its own permissions, so it
                        // never reports — that is a property of the provider.
                        // GitHub reports for classic tokens and not for app or
                        // fine-grained ones, so it is a property of the TOKEN,
                        // and saying "GitHub does not report" would be flatly
                        // untrue of the next token this screen shows.
                        //
                        // The CATALOGUE's `wants` is what separates them: a
                        // provider whose permissions are checkable at all
                        // publishes one, and it is in scope right here.
                        Text((provider.wants ?? []).isEmpty
                            ? "\(provider.label) does not report what a token was granted."
                            : "This token has no scopes to report — an app or fine-grained token carries permissions instead, set where it was created.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let missing = result.missing, !missing.isEmpty {
                        Text("Asked for and not granted: \(missing.joined(separator: ", "))")
                            .font(.caption2).foregroundStyle(.orange)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }

    /// Step one.
    ///
    /// A token provider already published its page in the catalogue, so there
    /// is nothing to ask the box for — the link is opened straight away. Claude
    /// has no such page: the authorization URL is minted per attempt by the CLI
    /// in a pane on that host, so the box has to be asked, and what comes back
    /// is that URL as a field rather than something scraped out of prose.
    @MainActor
    private func begin(_ provider: Fleet.Connections.Available, scope: Fleet.Scope = .me) async {
        secret = ""
        result = ""
        guard provider.isSignIn else {
            pending = provider
            return
        }
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).connect(host: host, provider: provider.provider, scope: scope)
            if let fresh = reply.connections {
                connections = fresh
                pending = fresh.catalogue.first { $0.provider == provider.provider }
            }
            if reply.ok == false { result = reply.text ?? "" }
        } catch {
            result = error.localizedDescription
        }
    }

    /// Step two. The secret is cleared the moment it leaves, whether or not it
    /// worked — a failed paste is still a live credential sitting in memory
    /// behind a screen somebody is about to hand back to a colleague.
    @MainActor
    private func link(_ provider: Fleet.Connections.Available) async {
        busy = true
        defer { busy = false }
        let sending = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        secret = ""
        do {
            // A token goes fleet-wide; a Claude code goes to the box whose
            // pane is waiting for it.
            let reply = provider.isSignIn
                ? try await Fleet(settings: settings).link(host: host, provider: provider.provider, secret: sending)
                : try await Fleet(settings: settings).linkEverywhere(provider: provider.provider, secret: sending)
            result = reply.text ?? ""
            if let fresh = reply.connections { connections = fresh }
            if reply.ok != false { pending = nil }
        } catch {
            result = error.localizedDescription
        }
    }

    /// The whole of the app flow: open the page, wait for it to come back.
    ///
    /// WHAT COMES BACK IS TRUSTED FOR NOTHING. A custom scheme is unverified —
    /// any app on the phone may claim it — so `ok=1` in the callback is a nudge
    /// to refresh and not a fact. The truth is whatever the host reports when
    /// asked, which is what `load()` goes and does either way.
    @MainActor
    private func authorize(_ provider: Fleet.Connections.Available, url: String) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await WebAuth.authorize(url)
            pending = nil
            await load()
            // Deliberately not "connected": this says what the app did, and
            // the row below says what the host found. If they disagree, the
            // row is right.
            result = "Checked with \(provider.label)."
        } catch {
            // A cancellation has no description on purpose — somebody who
            // changed their mind has not made a mistake to be told about.
            if let text = error.localizedDescription.nilIfEmpty { result = text }
        }
    }

    @MainActor
    private func forget(_ provider: Fleet.Connections.Available) async {
        busy = true
        defer { busy = false }
        do {
            let reply = provider.isSignIn
                ? try await Fleet(settings: settings).unlink(host: host, provider: provider.provider)
                : try await Fleet(settings: settings).unlinkEverywhere(provider: provider.provider)
            result = reply.text ?? ""
            if let fresh = reply.connections { connections = fresh }
        } catch {
            result = error.localizedDescription
        }
    }

    /// Ask the provider what the stored token can do.
    @MainActor
    private func check(_ provider: Fleet.Connections.Available) async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).verify(host: host, provider: provider.provider)
            if let check = reply.check {
                checks[provider.provider] = check
                expanded.insert(provider.provider)
            } else {
                result = reply.text ?? ""
            }
        } catch {
            result = error.localizedDescription
        }
    }

    private func bindingForDetail(_ provider: String) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(provider) },
            set: { open in
                if open { expanded.insert(provider) } else { expanded.remove(provider) }
            },
        )
    }

    @MainActor
    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).connections(host: host)
            if let fresh = reply.connections { connections = fresh }
        } catch {
            result = error.localizedDescription
        }
    }

    @MainActor
    private func clear() {
        pending = nil
        secret = ""
    }
}

/// "connected as @octocat", or "connected".
///
/// A function rather than an expression in the view: a chain of `+` with
/// optional maps inside it is what made the Swift type checker give up in
/// #125, and that failure only shows up on CI.
/// "works · 6 scopes", or what went wrong. One line, because the detail is
/// one tap away and this sits under a row that is already three lines tall.
private func describeCheck(_ check: Fleet.Check) -> String {
    guard check.ok == true else { return check.message ?? "could not be checked" }
    var parts: [String] = ["works"]
    if let account = check.account, !account.isEmpty { parts.append(account) }
    if let granted = check.granted { parts.append("\(granted.count) scope\(granted.count == 1 ? "" : "s")") }
    if let missing = check.missing, !missing.isEmpty { parts.append("\(missing.count) missing") }
    return parts.joined(separator: " · ")
}

private func describeLinked(_ linked: Fleet.Connections.Linked) -> String {
    guard let account = linked.account, !account.isEmpty else { return "connected" }
    return "connected as \(account)"
}

/// What the button offers, which is not always "replace".
///
/// Three states, because they are three different jobs:
///
///  - **Connect** — nothing stored yet.
///  - **Update permissions** — a token that is merely SHORT does not need
///    replacing. Both providers let you edit an existing one, and editing
///    keeps the value already pasted here working. Offering "Replace" here
///    would send somebody to mint a second token and abandon the first, which
///    is worse than what they had.
///  - **Replace** — a new token, which means REVOKING THE OLD ONE FIRST.
///    Neither GitHub nor Cloudflare lets this revoke on their behalf with the
///    permissions being asked for, and a token that can manage tokens is
///    stronger than the token itself — so asking for that would be the wrong
///    trade. The provider's hint names the deletion as step zero instead of
///    implying it is handled.
private func actionLabel(_ provider: Fleet.Connections.Available, _ linked: Fleet.Connections.Linked?) -> String {
    guard let linked else { return provider.isSignIn ? "Sign in" : "Connect" }
    if provider.isSignIn { return "Sign in again" }
    if let missing = linked.missing, !missing.isEmpty { return "Update permissions" }
    return "Replace"
}

private extension String {
    /// `localizedDescription` of an error whose description is nil comes back
    /// as the empty string rather than as nothing, so a cancelled sign-in
    /// would otherwise blank the result line instead of leaving it alone.
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
