import SwiftUI

/// Runners from this phone: the minter key, this phone's GitHub sign-in, and
/// your Claude login for your runners. See PhoneGitHub for how each works and
/// why nothing between here and the minter can read what this sends.
///
/// In the order a person needs them. The key comes first because the other two
/// seal to it; the GitHub sign-in second because it is what starts a machine and
/// what proves whose Claude login this is; the Claude login last, because it is
/// optional and the runner repository's API key covers anybody who skips it.
///
/// Every control does something or is not drawn: the sign-in button appears
/// only once a key is saved, the Claude login only once GitHub is signed in.
/// The same sentences as Android (RunnersFromPhone.kt), which
/// test/runners-from-phone-in-apps.test.js holds them to.
///
/// Its own view rather than more of SettingsView, which is already at the size
/// where the type checker gives up, and none of this state is shared with it.
struct RunnersFromPhone: View {
    let settings: Settings
    @State private var pinDraft = ""
    @State private var signedInAs: String?
    @State private var signedIn = false
    @State private var claudeDraft = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    private var signedInLine: String {
        guard let login = signedInAs, !login.isEmpty else { return "Signed in to GitHub." }
        return "Signed in to GitHub as \(login)."
    }

    var body: some View {
        Text("Runners from this phone")
            .fleetType(.bodyStrong)
        Text("Sign in to GitHub here and this phone starts your machines itself, with no permanent box. "
             + "The minter key makes sure what this phone sends can be read by your fleet's minter and nothing in between.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
            .onAppear {
                pinDraft = settings.minterPin
                signedIn = phone.signedIn
                signedInAs = phone.signIn?.login
            }

        TextField("Minter key from whoever runs your fleet", text: $pinDraft)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .fleetType(.labelMono)
        Button(busy ? "Checking…" : "Check and save key") {
            act { try await phone.checkPin(Fleet(settings: settings), pin: pinDraft) }
        }
        .disabled(busy || pinDraft.isBlank || pinDraft == settings.minterPin)

        if !settings.minterPin.isEmpty {
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
