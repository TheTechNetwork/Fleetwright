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
    /// Machines that could run `claude setup-token` for this person, by name.
    /// Empty until asked and on a fleet with none connected, which leaves only
    /// the paste field: nothing is offered that could not happen.
    @State private var machines: [String] = []
    @State private var machine = ""
    /// The sign-in page the chosen machine started, once it has.
    @State private var page: URL?
    @State private var pageHost = ""
    @State private var code = ""
    @Environment(\.openURL) private var openURL

    private var phone: PhoneGitHub { PhoneGitHub(settings: settings) }

    var body: some View {
        if !phone.signedIn {
            Text("Your Claude login is kept under your GitHub account, so sign in to GitHub on this phone first.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            PhoneGitHubSignIn(settings: settings)
        } else {
            Text("Sessions run on your own Claude subscription. Keep your login once, and every runner you start, "
                 + "and every box you approve, uses it.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .task { await loadMachines() }
            if let page {
                // A MACHINE IS MAKING IT. The page opened by itself; the link
                // is for coming back to it. Numbered, because the person
                // leaves the app in the middle and has to know what they are
                // coming back to do.
                Link("1. Open the sign-in page", destination: page)
                Text("2. Sign in to Claude, copy the code the page shows, and paste it here.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                SecureField("Code from the sign-in page", text: $code)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(busy ? "Keeping…" : "3. Keep my Claude login") { Task { await keepFromMachine() } }
                    .disabled(busy || code.isBlank)
                Button("Cancel", role: .cancel) {
                    self.page = nil
                    code = ""
                }
            } else {
                // WRITTEN BECAUSE IT WAS ASKED FOR: "If a host is available why
                // not offer to run it, return the link, open the page, capture
                // the token?" The field below wanted the output of a command run
                // on a computer, from somebody holding a phone.
                if !machines.isEmpty {
                    if machines.count > 1 {
                        Picker("Machine", selection: $machine) {
                            ForEach(machines, id: \.self) { Text($0).tag($0) }
                        }
                    }
                    Button(busy ? "Starting…" : "Make it on \(machine)") { Task { await startOnMachine() } }
                        .disabled(busy || machine.isEmpty)
                    Text("\(machine) runs claude setup-token for you. The token comes back sealed to this phone, "
                         + "and the machine keeps no copy.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                Text(machines.isEmpty
                     ? "On a computer, run claude setup-token, sign in, and paste the line it prints here."
                     : "Or, on a computer, run claude setup-token, sign in, and paste the line it prints here.")
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
        }
        if !result.isBlank {
            Text(result)
                .fleetType(.label)
                .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
        }
    }

    /// The machines that could make it: every connected one. Nil from the
    /// fleet leaves the list empty, which offers nothing rather than guessing.
    @MainActor
    private func loadMachines() async {
        guard machines.isEmpty, let hosts = try? await Fleet(settings: settings).fleetHosts() else { return }
        machines = hosts.filter { ($0.state ?? "") != "offline" }.map(\.hostId).sorted()
        if machine.isEmpty { machine = machines.first ?? "" }
    }

    @MainActor
    private func startOnMachine() async {
        busy = true
        defer { busy = false }
        result = ""
        do {
            let reply = try await Fleet(settings: settings).setupToken(host: machine)
            guard reply.ok != false, let raw = reply.url, let url = URL(string: raw) else {
                result = reply.text ?? "\(machine) did not start a sign-in."
                failed = true
                return
            }
            page = url
            pageHost = machine
            code = ""
            openURL(url)
        } catch {
            result = error.localizedDescription
            failed = true
        }
    }

    @MainActor
    private func keepFromMachine() async {
        busy = true
        defer { busy = false }
        let sending = code.trimmingCharacters(in: .whitespacesAndNewlines)
        code = ""
        do {
            result = try await phone.keepTokenFromMachine(Fleet(settings: settings), host: pageHost, code: sending)
            failed = false
            page = nil
            onKept()
        } catch {
            result = error.localizedDescription
            failed = true
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
