import SwiftUI

/// Runners from this phone: the minter key, this phone's GitHub sign-in, and
/// your Claude login for your runners. See PhoneGitHub for how each works and
/// why nothing between here and the minter can read what this sends.
///
/// In the order a person needs them. The minter's key comes first because the
/// other two seal to it, and the phone finds it itself at the fleet's address
/// (PhoneGitHub.minterKey); the field to paste one is drawn only when nothing
/// answers there. The GitHub sign-in second because it is what starts a machine and
/// what proves whose Claude login this is; the Claude login last, because it is
/// optional and the runner repository's API key covers anybody who skips it.
///
/// Every control does something or is not drawn: the sign-in button appears
/// only once there is a key to seal to, the Claude login only once GitHub is
/// signed in.
/// The same sentences as Android (RunnersFromPhone.kt), which
/// test/runners-from-phone-in-apps.test.js holds them to.
///
/// Its own view rather than more of SettingsView, which is already at the size
/// where the type checker gives up, and none of this state is shared with it.
struct RunnersFromPhone: View {
    let settings: Settings
    @State private var pinDraft = ""
    /// Did the minter answer for its own key? Nil while asking: CANNOT TELL
    /// yet, which draws neither the sign-in nor the field to paste a key.
    @State private var minterFound: Bool?
    @State private var signedInAs: String?
    @State private var signedIn = false
    @State private var claudeDraft = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    private var haveKey: Bool { !settings.minterPin.isEmpty || minterFound == true }

    private var signedInLine: String {
        guard let login = signedInAs, !login.isEmpty else { return "Signed in to GitHub." }
        return "Signed in to GitHub as \(login)."
    }

    var body: some View {
        Text("Runners from this phone")
            .fleetType(.bodyStrong)
        Text("Sign in to GitHub here and this phone starts your machines itself, with no permanent box. "
             + "What this phone sends is sealed to your fleet's minter, so nothing in between can read it.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
            .onAppear {
                pinDraft = settings.minterPin
                signedIn = phone.signedIn
                signedInAs = phone.signIn?.login
            }
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
            if signedIn {
                Text(signedInLine)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Button("Sign out of GitHub", role: .destructive) {
                    phone.signOut()
                    signedIn = false
                    signedInAs = nil
                    result = "Signed out of GitHub on this phone. Machines you start now go through a permanent box."
                    failed = false
                }
                .disabled(busy)
            } else {
                Button("Sign in to GitHub") {
                    act {
                        let text = try await phone.signInWith(Fleet(settings: settings))
                        signedIn = phone.signedIn
                        signedInAs = phone.signIn?.login
                        return text
                    }
                }
                .disabled(busy)
            }
        }

        if signedIn {
            Text("Runners you start can use your Claude subscription instead of the runner repository's API key. "
                 + "Make the token on a computer with claude setup-token, and paste it here.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            SecureField("Token from claude setup-token", text: $claudeDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Keep for my runners") {
                act {
                    let text = try await phone.depositClaudeLogin(Fleet(settings: settings), claudeToken: claudeDraft)
                    claudeDraft = ""
                    return text
                }
            }
            .disabled(busy || claudeDraft.isBlank)
            Button("Forget my Claude login", role: .destructive) {
                act { try await phone.depositClaudeLogin(Fleet(settings: settings), claudeToken: nil) }
            }
            .disabled(busy)

            // YOUR VAULT, below what it builds on: the key it seals to and the
            // sign-in that says whose it is.
            YourVault(settings: settings)
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
/// Drawn inside RunnersFromPhone once the minter key is saved and this phone is
/// signed in to GitHub, because every request here is sealed to that key and
/// proves whose vault it is with that sign-in. The Claude login kept above is
/// the same vault's, and shows in the list.
///
/// A box is offered for approval with the fingerprint this phone worked out
/// from its key, beside the sentence that says to compare it, because the
/// comparison is the whole of why approving is safe. The same sentences as
/// Android (YourVault.kt), which test/runners-from-phone-in-apps.test.js holds
/// them to.
struct YourVault: View {
    let settings: Settings
    @State private var contents: PhoneVault.Contents?
    @State private var boxes: [Fleet.Host] = []
    @State private var secretName = ""
    @State private var secretValue = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var vault: PhoneVault { PhoneVault(settings: settings) }

    /// A box the fleet lists, with the fingerprint worked out here from its
    /// key, never the one the fleet says beside it.
    private struct Listed: Identifiable {
        let host: Fleet.Host
        let fingerprint: String?
        var id: String { host.hostId }
    }

    private var listed: [Listed] {
        boxes.map { Listed(host: $0, fingerprint: $0.publicJwk.map(PhoneVault.fingerprint)) }
    }

    /// Approved, and not in this fleet any more: still removable, because an
    /// approval outlives the box being taken out of the fleet.
    private var strays: [PhoneVault.Grant] {
        let shown = Set(listed.compactMap { $0.fingerprint })
        return (contents?.grants ?? []).filter { !shown.contains($0.fingerprint) }
    }

    var body: some View {
        Text("Your vault")
            .fleetType(.bodyStrong)
            .task { await reload() }
        Text("Keep each credential here once. A box you approve gets them when a session needs them, "
             + "and loses them when you remove it.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)

        if let kept = contents {
            Text(kept.items.isEmpty ? "Nothing kept yet." : "Kept: " + kept.items.map { PhoneVault.label($0.name) }.joined(separator: ", ") + ".")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            ForEach(kept.items, id: \.name) { item in
                Button("Forget \(PhoneVault.label(item.name))", role: .destructive) {
                    act { try await vault.forget(Fleet(settings: settings), name: item.name) }
                }
                .disabled(busy)
            }
        } else {
            Text("Loading your vault…")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }

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

        Text("Boxes")
            .fleetType(.bodyStrong)
        Text("Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
        ForEach(listed) { box in
            Text("\(box.host.hostId) · \(box.fingerprint ?? "no key listed")")
                .fleetType(.labelMono)
                .foregroundStyle(Design.Palette.ink)
            if let grant = contents?.grants.first(where: { $0.fingerprint == box.fingerprint }) {
                Text("Approved")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ok)
                Button("Remove", role: .destructive) {
                    act { try await vault.remove(Fleet(settings: settings), grant: grant) }
                }
                .disabled(busy)
            } else if box.fingerprint != nil {
                Button("Approve") {
                    act { try await vault.approve(Fleet(settings: settings), host: box.host) }
                }
                .disabled(busy || contents == nil)
            }
        }
        ForEach(strays, id: \.key) { grant in
            Text("\(grant.label.isEmpty ? "A box" : grant.label) · \(grant.fingerprint)")
                .fleetType(.labelMono)
                .foregroundStyle(Design.Palette.inkDim)
            Button("Remove", role: .destructive) {
                act { try await vault.remove(Fleet(settings: settings), grant: grant) }
            }
            .disabled(busy)
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
        boxes = ((try? await fleet.enrolledHosts()) ?? []).filter { !$0.isRevoked && $0.ephemeral != true }
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
