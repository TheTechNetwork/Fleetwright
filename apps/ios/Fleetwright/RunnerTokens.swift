import SwiftUI

/// The tokens a repository's workflow uses to join runners to this fleet as
/// you, and the screen that mints and revokes them.
///
/// WHY A SCREEN. A runner token lives in a GitHub secret and is spent on every
/// run started by hand — the reusable half of runner central, kept beside the
/// single-use ticket the fleet mints when it dispatches a run itself. It has
/// been minted with curl since it shipped, which docs/runner-central.md showed
/// and the parity test recorded as a gap rather than a decision. A product
/// whose premise is "nothing to ssh into" should not need a terminal to let a
/// repository in.
///
/// WHAT A TOKEN IS, said on the screen because it is the thing people get
/// wrong: it authenticates nothing. It answers "whose runner is this" after
/// GitHub has already proved the job is real, and a leaked one attributes a
/// machine to you — it cannot call the API as you or admit a host by itself.
///
/// SHOWN ONCE. The coordinator keeps a hash, like every other secret it
/// issues, so the value on this screen is the only copy there will ever be.
struct RunnerTokensView: View {
    let settings: Settings

    @State private var tokens: [Fleet.Client] = []
    @State private var name = ""
    /// The secret just minted, and the id it belongs to. Cleared when the
    /// screen is left; nothing else holds it.
    @State private var minted: (id: String, token: String)?
    @State private var result = ""
    @State private var busy = false
    @State private var loaded = false
    @State private var confirming: Fleet.Client?

    var body: some View {
        List {
            Section {
                TextField("owner/repo", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Mint a token") { Task { await mint() } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                if let minted {
                    // MONOSPACE AND SELECTABLE, because the next thing that
                    // happens to it is a paste into a repository secret. Said
                    // where, rather than leaving the value to explain itself.
                    Text(minted.token)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                    Text("Shown once. Put it in the repository's FLEETWRIGHT_RUNNER_TOKEN secret.")
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.attention)
                }
            } header: {
                Text("Mint a token for a repository")
            } footer: {
                Text("A workflow started by hand presents this to join a runner to the fleet as you. It cannot call "
                     + "the API and cannot admit a machine on its own — GitHub proves the job is real first.")
            }

            Section {
                if tokens.isEmpty && loaded {
                    Text("No runner tokens. A run the fleet dispatches itself carries a single-use ticket instead, "
                         + "and needs none of these.")
                        .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                ForEach(tokens) { token in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(token.name ?? "unnamed")
                        Text(describeToken(token)).fleetType(.micro).foregroundStyle(Design.Palette.inkDim)
                        Button("Revoke", role: .destructive) { confirming = token }
                            .fleetType(.micro)
                            .buttonStyle(.borderless)
                            .disabled(busy)
                    }
                    .padding(.vertical, Design.Space.hair / 2)
                }
            } header: {
                Text("Tokens")
            } footer: {
                // SAID BEFORE IT MATTERS: revoking is refused at the next
                // enrolment, and a runner already in the fleet stays until its
                // job ends.
                Text("Revoking stops the next run from joining. A runner already in the fleet keeps working until "
                     + "its job ends.")
            }

            if !result.isBlank {
                Section { Text(result).fleetType(.bodySmall) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Runner tokens")
        .task { await load() }
        .onDisappear { minted = nil }
        .alert("Revoke \(confirming?.name ?? "this token")?", isPresented: Binding(
            get: { confirming != nil },
            set: { if !$0 { confirming = nil } }
        )) {
            Button("Cancel", role: .cancel) { confirming = nil }
            Button("Revoke", role: .destructive) {
                if let token = confirming { Task { await revoke(token) } }
                confirming = nil
            }
        } message: {
            Text("The next run that presents it is refused. Put a new one in the repository's secret to let it back in.")
        }
    }

    @MainActor
    private func load() async {
        busy = true
        defer { busy = false; loaded = true }
        do {
            tokens = try await Fleet(settings: settings).runnerTokens()
        } catch {
            // The refusal reaches the screen rather than an empty list: an
            // empty list is a lie about a request that did not happen.
            result = error.localizedDescription
        }
    }

    @MainActor
    private func mint() async {
        busy = true
        defer { busy = false }
        do {
            minted = try await Fleet(settings: settings).mintRunnerToken(name: name.trimmingCharacters(in: .whitespaces))
            name = ""
            result = ""
        } catch {
            result = error.localizedDescription
        }
        await load()
    }

    @MainActor
    private func revoke(_ token: Fleet.Client) async {
        busy = true
        defer { busy = false }
        do {
            result = try await Fleet(settings: settings).revokeRunnerToken(token.id).text ?? ""
        } catch {
            result = error.localizedDescription
        }
        if minted?.id == token.id { minted = nil }
        await load()
    }
}

/// "yours · minted 3 Mar · never used", which is what somebody deciding what to
/// revoke is asking. NEVER USED AND USED LONG AGO MUST LOOK DIFFERENT.
private func describeToken(_ token: Fleet.Client) -> String {
    var parts: [String] = []
    if let email = token.email, !email.isEmpty { parts.append(email) }
    if let at = token.createdAt, at > 0 {
        parts.append("minted " + Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .omitted))
    }
    if let seen = token.lastSeenAt, seen > 0 {
        parts.append("last run " + Date(timeIntervalSince1970: seen / 1000).formatted(date: .abbreviated, time: .omitted))
    } else {
        parts.append("never used")
    }
    return parts.joined(separator: " · ")
}
