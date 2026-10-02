import SwiftUI

/// Whether this person's Claude login is kept for their runners and the boxes
/// they approve: the vault's Claude row, which is what a runner fetches when it
/// joins (src/fleet/minter/claude.js).
///
/// FOUR ANSWERS, NOT TWO. "Not kept" is only said when the vault answered and
/// had no Claude row in it. Without this phone's GitHub sign-in the vault
/// cannot be asked at all, which is a step to take rather than a fact about the
/// login; and a vault that did not answer is cannot tell, which draws nothing.
enum ClaudeKept: Equatable {
    case kept, missing, needsGitHub, cannotTell
}

@MainActor
func claudeKept(_ settings: Settings) async -> ClaudeKept {
    guard settings.configured else { return .cannotTell }
    guard PhoneGitHub(settings: settings).signedIn else { return .needsGitHub }
    guard let contents = try? await PhoneVault(settings: settings).list(Fleet(settings: settings)) else { return .cannotTell }
    return contents.items.contains { $0.name == "claude" } ? .kept : .missing
}

/// Keep a Claude login for your runners, in the order it has to happen: this
/// phone's GitHub sign-in first, because the minter keeps the login under that
/// account, then the token.
///
/// WRITTEN BECAUSE NOTHING ASKED. A person signed in, started a machine from
/// New session, and the runner joined with no Claude login and refused the
/// session it was started for. The only place to keep one was a field four
/// screens deep under Credentials. This is that field, offered where it is
/// needed: on Sessions after sign-in, and in New session when a new machine is
/// chosen. The same view in both, so the words cannot drift apart.
///
/// Rows for a Form section; the caller supplies the section.
struct ClaudeSetup: View {
    let settings: Settings
    /// Told once the minter has kept it, so the place showing this can stop.
    var onKept: () -> Void = {}

    @State private var draft = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    var body: some View {
        if !phone.signedIn {
            Text("Your Claude login is kept under your GitHub account, so sign in to GitHub on this phone first.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            PhoneGitHubSignIn(settings: settings)
        } else {
            Text("Sessions run on your own Claude subscription. On a computer, run claude setup-token, sign in, "
                 + "and paste the line it prints here. Every runner you start, and every box you approve, uses it.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            SecureField("Token from claude setup-token", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(busy ? "Keeping…" : "Keep my Claude login") {
                Task {
                    busy = true
                    defer { busy = false }
                    do {
                        result = try await phone.depositClaudeLogin(Fleet(settings: settings), claudeToken: draft)
                        failed = false
                        draft = ""
                        onKept()
                    } catch {
                        result = error.localizedDescription
                        failed = true
                    }
                }
            }
            .disabled(busy || draft.isBlank)
        }
        if !result.isBlank {
            Text(result)
                .fleetType(.label)
                .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
        }
    }
}

/// The same steps as a page of their own, for the card on Sessions.
struct ClaudeSetupView: View {
    let settings: Settings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section {
                ClaudeSetup(settings: settings) { dismiss() }
            } header: {
                Text("Claude for your sessions").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Set up Claude")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The onboarding ask, on Sessions, until the login is kept or put off.
///
/// FleetView draws it only when the answer is known to be "not yet": the vault
/// said no Claude row, or there is no GitHub sign-in to ask it with. Cannot
/// tell draws nothing (C-5). "Not now" is remembered on this phone, because a
/// card that cannot be put away is a card people learn not to read.
struct ClaudeSetupCard: View {
    let settings: Settings
    let putOff: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text("Finish setting up")
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
            Text("Sessions run on your own Claude account. Keep your Claude login once, and every runner "
                 + "you start can use it.")
                .fleetType(.bodySmall)
                .foregroundStyle(Design.Palette.inkDim)
            HStack(spacing: Design.Space.groupTight) {
                NavigationLink("Set up Claude") { ClaudeSetupView(settings: settings) }
                Button("Not now", action: putOff)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            .fleetType(.bodySmall)
            .buttonStyle(.borderless)
            .frame(minHeight: 44)
        }
        .fleetCard(radius: Design.Radius.cardSmall)
    }
}
