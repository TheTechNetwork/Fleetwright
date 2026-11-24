import SwiftUI

/// This phone's own GitHub sign-in, and the minter key it seals to. See
/// PhoneGitHub for how each works and why nothing between here and the minter
/// can read what this sends.
///
/// ONE PLACE, UNDER YOU › ACCOUNT. It was drawn inside "Add a machine" as
/// "Runners from this phone", which hid an account this phone holds behind a
/// heading about machines, and the vault (which knows a person by this same
/// sign-in) one level further down. Two features use it, runners and the
/// vault, and each says so where it is used.
///
/// In the order a person needs them: the minter's key first, because the
/// sign-in seals to it, and the phone finds it itself at the fleet's address
/// (PhoneGitHub.minterKey); the field to paste one is drawn only when nothing
/// answers there. Every control does something or is not drawn.
///
/// The same sentences as Android (RunnersFromPhone.kt), which
/// test/runners-from-phone-in-apps.test.js holds them to.
struct PhoneGitHubSignIn: View {
    let settings: Settings
    @State private var pinDraft = ""
    /// Did the minter answer for its own key? Nil while asking: CANNOT TELL
    /// yet, which draws neither the sign-in nor the field to paste a key.
    @State private var minterFound: Bool?
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    private var haveKey: Bool { !settings.minterPin.isEmpty || minterFound == true }

    private var signedInLine: String {
        guard let login = phone.signIn?.login, !login.isEmpty else { return "Signed in to GitHub." }
        return "Signed in to GitHub as \(login)."
    }

    var body: some View {
        if phone.signedIn {
            Text(signedInLine)
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            Button("Sign out of GitHub", role: .destructive) {
                phone.signOut()
                result = "Signed out of GitHub."
                failed = false
            }
            .disabled(busy)
        } else {
            // What the sign-in is for, said where it is offered and nowhere
            // else: You's header is just the name. How what this phone sends
            // is protected is PhoneGitHub's to document, not this line's.
            Text("Sign in to GitHub to start temporary machines from this phone and reach your saved credentials.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .onAppear { pinDraft = settings.minterPin }
                .task { minterFound = await Fleet(settings: settings).minterOwnKey() != nil }

            if minterFound == nil && settings.minterPin.isEmpty {
                Text("Checking…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }

            if minterFound == false {
                Text("Paste the key from whoever runs your fleet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                TextField("Key from whoever runs your fleet", text: $pinDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fleetType(.labelMono)
                Button(busy ? "Checking…" : "Check and save key") {
                    act { try await phone.checkPin(Fleet(settings: settings), pin: pinDraft) }
                }
                .disabled(busy || pinDraft.isBlank || pinDraft == settings.minterPin)
            }

            if haveKey {
                Button("Sign in to GitHub") {
                    act { try await phone.signInWith(Fleet(settings: settings)) }
                }
                .disabled(busy)
            }
        }

        if !result.isBlank {
            Text(result)
                .fleetType(.label)
                .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                .textSelection(.enabled)
        }
    }

    /// Run one action, showing its sentence either way. A cancelled sign-in
    /// says nothing: the person meant it (see WebAuth.Failure).
    private func act(_ block: @escaping @MainActor () async throws -> String) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                result = try await block()
                failed = false
            } catch WebAuth.Failure.cancelled {
                failed = false
            } catch {
                failed = true
                result = error.localizedDescription
            }
        }
    }
}

/// Your vault: each credential kept once, and the boxes that may hold it.
/// See PhoneVault for how, and docs/vault.md for why.
///
/// THE CREDENTIALS SCREEN LEADS WITH THIS. A credential linked on one box is
/// the older way and shows below as a fact; this is the way a person keeps
/// Claude, GitHub, Cloudflare and named secrets once for every machine they
/// approve. Every request is sealed to the minter's key and proves whose vault
/// it is with this phone's GitHub sign-in, so it is drawn once that exists.
///
/// APPROVING A BOX IS ON THAT BOX'S PAGE, beside its own Key, because the
/// comparison of the two fingerprints is the whole of why approving is safe,
/// and here they were shown apart. This lists which boxes hold your
/// credentials, and removes an approval for a box that has left the fleet,
/// which has no page to do it from.
///
/// The same sentences as Android (YourVault.kt), which
/// test/runners-from-phone-in-apps.test.js holds them to.
///
/// POINTED AT A MEMBER'S VAULT, when one is given (docs/members.md): the same
/// rows, with every request naming that member, for one of its custodians.
/// Its machines are approved from here, one page each with the key to
/// compare, because a member has no machine page of its own to do it from.
struct YourVault: View {
    let settings: Settings
    /// The member whose vault this is, or nil for this person's own.
    var member: Fleet.Member? = nil
    /// Told what the vault answered each time it is listed, so the screen
    /// around this can draw what else the answer carries without asking twice.
    var onListed: (PhoneVault.Contents) -> Void = { _ in }
    @State private var contents: PhoneVault.Contents?
    @State private var boxes: [Fleet.Host] = []
    @State private var secretName = ""
    @State private var secretValue = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    /// The item a Forget is waiting on, until the dialog is answered.
    @State private var forgetting: String?

    private var vault: PhoneVault { PhoneVault(settings: settings) }
    private var fleet: Fleet { Fleet(settings: settings) }
    /// The member every request here is for, by id, or nil for this person's own vault.
    private var whose: String? { member?.id }

    /// The fingerprints of boxes still in this fleet, worked out here from
    /// their keys, never the ones the fleet lists beside them.
    private var inFleet: [String: String] {
        var out: [String: String] = [:]
        for host in boxes {
            if let key = host.publicJwk { out[PhoneVault.fingerprint(key)] = host.hostId }
        }
        return out
    }

    /// Approved boxes that are in this fleet, by name, and what a box approved
    /// for part of the vault holds. A pool's own machine is let in for its one
    /// record (`only`), and this list said "Held by" it as if it held
    /// everything (eighth audit).
    private var holders: [String] {
        (contents?.grants ?? []).compactMap { grant in
            inFleet[grant.fingerprint].map { name in
                grant.only.isEmpty ? name : "\(name) (\(grant.only.map(PhoneVault.label).joined(separator: ", ")) only)"
            }
        }.sorted()
    }

    /// Approved, and not in this fleet any more: still removable, because an
    /// approval outlives the box being taken out of the fleet.
    private var strays: [PhoneVault.Grant] {
        (contents?.grants ?? []).filter { inFleet[$0.fingerprint] == nil }
    }

    /// The one word beside a saved credential. A SETUP-TOKEN IS NOT A
    /// SIGN-IN, and a plain "Claude" let a person think Remote Control would
    /// work; said only when the minter said which (C-5): nil is a minter from
    /// before it did, and reads as saved and nothing more.
    private func status(_ item: PhoneVault.Item) -> String {
        item.name == "claude" && item.kind == "token" ? "No Remote Control" : "Saved"
    }

    var body: some View {
        Text(member.map { "Saved once, for sessions started as \($0.name), on the machines approved below." }
             ?? "Saved once, for your sessions on the machines you approve.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
            .task { await reload() }
            .confirmationDialog("Forget \(PhoneVault.label(forgetting ?? ""))?",
                                isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                                titleVisibility: .visible) {
                Button("Forget", role: .destructive) {
                    if let name = forgetting {
                        act { try await vault.forget(fleet, name: name, for: whose) }
                    }
                }
            } message: {
                Text(member.map { PhoneVault.forgetting(forgetting ?? "", for: $0.name) } ?? PhoneVault.forgetting(forgetting ?? ""))
            }

        if let kept = contents {
            if kept.items.isEmpty {
                Text("Nothing saved yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            // ONE ROW PER SAVED CREDENTIAL: its name, one status word, and
            // its actions on the row. It was a sentence listing the names and
            // then a column of Test and Forget buttons under it, naming each
            // again. Borderless, as on Credentials, so each button takes its
            // own tap inside the row; the row itself is the 44pt target.
            //
            // TEST, BECAUSE SAVED IS NOT WORKS. A Claude token Claude had
            // revoked sat here as saved until a runner stopped at its first
            // message. Offered only where there is a service to ask (C-2).
            //
            // FORGET ASKS FIRST. It was one tap, beside the button people come
            // here to press, and it took the Claude login out from under every
            // runner without a word.
            ForEach(kept.items, id: \.name) { item in
                HStack(spacing: Design.Space.insideTight) {
                    Text(PhoneVault.label(item.name))
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                    Spacer()
                    Text(status(item))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                    if PhoneVault.isTestable(item.name) {
                        Button("Test") {
                            act { try await vault.test(fleet, name: item.name, for: whose) }
                        }
                        .accessibilityLabel("Test \(PhoneVault.label(item.name))")
                        .disabled(busy)
                    }
                    Button("Forget", role: .destructive) { forgetting = item.name }
                        .accessibilityLabel("Forget \(PhoneVault.label(item.name))")
                        .disabled(busy)
                }
                .frame(minHeight: 44)
                .buttonStyle(.borderless)
            }
        } else {
            Text("Loading your credentials…")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }

        // CLAUDE, kept the same way: this is the vault's Claude row, which
        // runners and approved boxes both use. The same rows as Set up Claude,
        // so a machine can make the token here too, rather than a paste field
        // that wanted a computer from somebody holding a phone. Its own Forget
        // went: it was a second button doing what Forget Claude above does.
        if let member {
            ClaudeSetup(settings: settings, member: member) { Task { await reload() } }
        } else {
            ClaudeSetup(settings: settings) { Task { await reload() } }
        }

        Button("Add GitHub") {
            act { try await vault.connect(fleet, provider: "github", for: whose) }
        }
        .disabled(busy)
        Button("Add Cloudflare") {
            act { try await vault.connect(fleet, provider: "cloudflare", for: whose) }
        }
        .disabled(busy)

        TextField("Secret name", text: $secretName)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        SecureField("Secret value", text: $secretValue)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        Button("Save secret") {
            act {
                let text = try await vault.keepSecret(fleet, name: secretName, value: secretValue, for: whose)
                secretName = ""
                secretValue = ""
                return text
            }
        }
        .disabled(busy || secretName.isBlank || secretValue.isEmpty)

        if contents != nil {
            // WHICH MACHINES, as one row with their names, and the how-to
            // once under it. Approving is on each machine's page, beside its
            // key, because the comparison is what makes it safe.
            LabeledContent("Machines") {
                Text(holders.isEmpty ? "none" : holders.joined(separator: ", "))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .multilineTextAlignment(.trailing)
            }
            ForEach(strays, id: \.key) { grant in
                Text("\(grant.label.isEmpty ? "A machine" : grant.label) · \(grant.fingerprint) · not in this fleet")
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.inkDim)
                Button("Remove", role: .destructive) {
                    act { try await vault.remove(fleet, grant: grant, for: whose) }
                }
                .disabled(busy)
            }
            if let member {
                // A MEMBER'S MACHINES ARE APPROVED FROM HERE. Each opens the
                // same approval a machine's own page shows, with the key this
                // phone worked out to compare, and only a machine the fleet
                // listed a key for is offered (C-2).
                Text("Approve a machine for \(member.name):")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                ForEach(boxes.filter { $0.publicJwk != nil }) { box in
                    NavigationLink(box.hostId) {
                        Form {
                            Section {
                                VaultApproval(settings: settings, host: box, member: member)
                            }
                        }
                        .scrollContentBackground(.hidden)
                        .background(Design.Palette.bg)
                        .listRowBackground(Design.Palette.card)
                        .navigationTitle(box.hostId)
                        .navigationBarTitleDisplayMode(.inline)
                    }
                }
            } else {
                Text("Approve a machine from its page.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        }

        if !result.isBlank {
            Text(result)
                .fleetType(.label)
                .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                .textSelection(.enabled)
        }
    }

    @MainActor
    private func reload() async {
        do {
            let listed = try await vault.list(fleet, for: whose)
            contents = listed
            onListed(listed)
        } catch {
            failed = true
            result = error.localizedDescription
        }
        if let got = try? await fleet.enrolledHosts() {
            boxes = got.filter { !$0.isRevoked && $0.ephemeral != true }
        }
    }

    /// Run one change, say what it did, then show the vault as it is now. A
    /// cancelled sign-in says nothing: the person meant it.
    private func act(_ block: @escaping @MainActor () async throws -> String) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                result = try await block()
                failed = false
            } catch WebAuth.Failure.cancelled {
                failed = false
            } catch {
                failed = true
                result = error.localizedDescription
            }
            await reload()
        }
    }
}

/// Whether ONE box may hold your vault's credentials, on that box's page.
///
/// Beside its Key on purpose: approving is safe because the fingerprint this
/// phone works out from the box's key matches what `fleetwright-sidecar
/// identity` prints on the box, and the page is where both are in view. The
/// fingerprint here is computed, never read off the fleet's listing.
///
/// Drawn only for a permanent box the fleet has a key for, and only once this
/// phone is signed in to GitHub, which is how the vault knows whose it is.
///
/// FOR A MEMBER'S VAULT when one is given, opened from that member's
/// credentials: the same comparison, and the approval is a grant in that
/// vault and nowhere else (docs/members.md, "Box approval is per vault").
struct VaultApproval: View {
    let settings: Settings
    let host: Fleet.Host
    /// The member whose vault this machine is approved for, or nil for this person's own.
    var member: Fleet.Member? = nil
    @State private var grant: PhoneVault.Grant?
    @State private var loaded = false
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var vault: PhoneVault { PhoneVault(settings: settings) }
    private var fingerprint: String? { host.publicJwk.map(PhoneVault.fingerprint) }

    var body: some View {
        if PhoneGitHub(settings: settings).signedIn {
            Group {
                if let fingerprint {
                    if !loaded {
                        Text("Loading your credentials…")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    } else if let grant {
                        // ONLY WHAT IT WAS GIVEN. A grant scoped by `only` is a
                        // pool's own machine let in for its one record, and the
                        // page said "Approved" over it as if it held the whole
                        // vault (eighth audit).
                        LabeledContent(member.map { "\($0.name)'s credentials" } ?? "Your credentials") {
                            Text(grant.only.isEmpty ? "Approved" : "Only " + grant.only.map(PhoneVault.label).joined(separator: ", "))
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.ok)
                        }
                        Button("Remove", role: .destructive) {
                            act { try await vault.remove(Fleet(settings: settings), grant: grant, for: member?.id) }
                        }
                        .disabled(busy)
                    } else {
                        Text("Check this matches fleetwright-sidecar identity on the machine before approving.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                        Text(fingerprint)
                            .fleetType(.labelMono)
                            .foregroundStyle(Design.Palette.ink)
                            .textSelection(.enabled)
                        Button("Approve") {
                            act { try await vault.approve(Fleet(settings: settings), host: host, for: member?.id) }
                        }
                        .disabled(busy)
                    }
                } else {
                    Text("\(host.hostId) · no key listed")
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                if !result.isBlank {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .textSelection(.enabled)
                }
            }
            .task { await reload() }
        }
    }

    @MainActor
    private func reload() async {
        do {
            let contents = try await vault.list(Fleet(settings: settings), for: member?.id)
            // The whole key hash, as the minter names the grant, not its
            // sixteen-character start.
            let whole = host.publicJwk.map(PhoneVault.keyHash)
            grant = contents.grants.first { $0.key == whole }
        } catch {
            failed = true
            result = error.localizedDescription
        }
        loaded = true
    }

    private func act(_ block: @escaping @MainActor () async throws -> String) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                result = try await block()
                failed = false
            } catch WebAuth.Failure.cancelled {
                failed = false
            } catch {
                failed = true
                result = error.localizedDescription
            }
            await reload()
        }
    }
}
