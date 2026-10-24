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
                result = "Signed out of GitHub on this phone. Machines you start now go through a permanent box."
                failed = false
            }
            .disabled(busy)
        } else {
            Text("Sign in to GitHub here and this phone starts your machines itself, with no permanent box. "
                 + "What this phone sends is sealed to your fleet's minter, so nothing in between can read it.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .onAppear { pinDraft = settings.minterPin }
                .task { minterFound = await Fleet(settings: settings).minterOwnKey() != nil }

            if minterFound == nil && settings.minterPin.isEmpty {
                Text("Looking for your fleet's minter…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }

            if minterFound == false {
                Text("This fleet's minter does not answer for its own key. Paste the key whoever runs your fleet gave you.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                TextField("Minter key from whoever runs your fleet", text: $pinDraft)
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
struct YourVault: View {
    let settings: Settings
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

    private var heldBy: String {
        if holders.isEmpty { return "No box holds your credentials yet. Approve one from its page under Machines." }
        return "Held by \(holders.joined(separator: ", ")). Approve or remove a box from its page under Machines."
    }

    /// Approved, and not in this fleet any more: still removable, because an
    /// approval outlives the box being taken out of the fleet.
    private var strays: [PhoneVault.Grant] {
        (contents?.grants ?? []).filter { inFleet[$0.fingerprint] == nil }
    }

    var body: some View {
        Text("Keep each credential here once. A box you approve gets them when a session needs them, "
             + "and loses them when you remove it.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
            .task { await reload() }

        if let kept = contents {
            Text(kept.items.isEmpty ? "Nothing kept yet." : "Kept: " + kept.items.map { PhoneVault.label($0.name) }.joined(separator: ", ") + ".")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .confirmationDialog("Forget \(PhoneVault.label(forgetting ?? ""))?",
                                    isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                                    titleVisibility: .visible) {
                    Button("Forget", role: .destructive) {
                        if let name = forgetting {
                            act { try await vault.forget(Fleet(settings: settings), name: name) }
                        }
                    }
                } message: {
                    Text(PhoneVault.forgetting(forgetting ?? ""))
                }
            // TEST, BECAUSE KEPT IS NOT WORKS. A Claude token Claude had
            // revoked sat here as "Kept" until a runner stopped at its first
            // message. Offered only where there is a service to ask (C-2).
            //
            // FORGET ASKS FIRST. It was one tap, beside the button people come
            // here to press, and it took the Claude login out from under every
            // runner without a word.
            ForEach(kept.items, id: \.name) { item in
                if PhoneVault.isTestable(item.name) {
                    Button("Test \(PhoneVault.label(item.name))") {
                        act { try await vault.test(Fleet(settings: settings), name: item.name) }
                    }
                    .disabled(busy)
                }
                Button("Forget \(PhoneVault.label(item.name))", role: .destructive) { forgetting = item.name }
                    .disabled(busy)
            }
        } else {
            Text("Loading your vault…")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }

        // CLAUDE, kept the same way: this is the vault's Claude row, which
        // runners and approved boxes both use. The same rows as Set up Claude,
        // so a machine can make the token here too, rather than a paste field
        // that wanted a computer from somebody holding a phone. Its own Forget
        // went: it was a second button doing what Forget Claude above does.
        ClaudeSetup(settings: settings) { Task { await reload() } }

        Button("Keep GitHub for my boxes") {
            act { try await vault.connect(Fleet(settings: settings), provider: "github") }
        }
        .disabled(busy)
        Button("Keep Cloudflare for my boxes") {
            act { try await vault.connect(Fleet(settings: settings), provider: "cloudflare") }
        }
        .disabled(busy)

        TextField("Secret name", text: $secretName)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        SecureField("Secret value", text: $secretValue)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        Button("Keep secret") {
            act {
                let text = try await vault.keepSecret(Fleet(settings: settings), name: secretName, value: secretValue)
                secretName = ""
                secretValue = ""
                return text
            }
        }
        .disabled(busy || secretName.isBlank || secretValue.isEmpty)

        if contents != nil {
            Text("Boxes")
                .fleetType(.bodyStrong)
            Text(heldBy)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            ForEach(strays, id: \.key) { grant in
                Text("\(grant.label.isEmpty ? "A box" : grant.label) · \(grant.fingerprint) · not in this fleet")
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.inkDim)
                Button("Remove", role: .destructive) {
                    act { try await vault.remove(Fleet(settings: settings), grant: grant) }
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

    @MainActor
    private func reload() async {
        let fleet = Fleet(settings: settings)
        do {
            contents = try await vault.list(fleet)
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
struct VaultApproval: View {
    let settings: Settings
    let host: Fleet.Host
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
                        Text("Loading your vault…")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    } else if let grant {
                        // ONLY WHAT IT WAS GIVEN. A grant scoped by `only` is a
                        // pool's own machine let in for its one record, and the
                        // page said "Approved" over it as if it held the whole
                        // vault (eighth audit).
                        LabeledContent("Your credentials") {
                            Text(grant.only.isEmpty ? "Approved" : "Only " + grant.only.map(PhoneVault.label).joined(separator: ", "))
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.ok)
                        }
                        Button("Remove", role: .destructive) {
                            act { try await vault.remove(Fleet(settings: settings), grant: grant) }
                        }
                        .disabled(busy)
                    } else {
                        Text("Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                        Text(fingerprint)
                            .fleetType(.labelMono)
                            .foregroundStyle(Design.Palette.ink)
                            .textSelection(.enabled)
                        Button("Approve") {
                            act { try await vault.approve(Fleet(settings: settings), host: host) }
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
            let contents = try await vault.list(Fleet(settings: settings))
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
