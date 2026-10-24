import SwiftUI

/// What this person has let the fleet send in their name while they are away
/// (docs/signed-intents.md, "Delegations"), and the one they grant by hand:
/// an MCP client acting for them.
///
/// The others are signed without asking, because each is the person doing
/// something they already chose: keeping machines ready, finishing a sign-in,
/// a request the fleet places. They are listed here because a standing
/// permission nobody can see is one nobody can take back.
///
/// TAKING ONE BACK goes to the minter first. The coordinator carries
/// delegations, so only the minter's list, which boxes check, makes a box
/// refuse it.
struct DelegationsView: View {
    let settings: Settings

    @State private var delegations: [Fleet.Delegation] = []
    @State private var loaded = false
    @State private var busy = false
    @State private var confirmingRevoke: Fleet.Delegation?
    @State private var result = ""

    var body: some View {
        List {
            Section {
                if delegations.isEmpty {
                    Text(loaded ? "Nothing is delegated. What the app sends now, it signs as it sends it." : "Asking the fleet…")
                        .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                ForEach(delegations) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.what(d)).fleetType(.body)
                        Text(Self.scope(d)).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    .swipeActions {
                        Button("Revoke", role: .destructive) { confirmingRevoke = d }
                    }
                }
                if !result.isBlank {
                    Text(result).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
            } footer: {
                Text("A box that takes only what you signed takes these in your name until they run out. Swipe to revoke one.")
            }

            Section {
                Button("Allow for a day") { Task { await allowMCP(days: 1) } }
                    .disabled(busy)
                Button("Allow for a week") { Task { await allowMCP(days: 7) } }
                    .disabled(busy)
            } header: {
                Text("An MCP client")
            } footer: {
                Text("Lets an MCP client signed in as you start, read, stop and resume sessions and make machines, on any box, until it runs out. "
                     + "It cannot reboot or upgrade a box, or move your credentials.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Delegations")
        .refreshable { await load() }
        .task { await load() }
        .alert(
            "Revoke this delegation?",
            isPresented: Binding(
                get: { confirmingRevoke != nil },
                set: { if !$0 { confirmingRevoke = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { confirmingRevoke = nil }
            Button("Revoke", role: .destructive) {
                guard let d = confirmingRevoke else { return }
                confirmingRevoke = nil
                Task { await revoke(d) }
            }
        } message: {
            Text("Boxes refuse it from the next key list they take, within ten minutes. What it was for asks you to sign again.")
        }
    }

    /// What a delegation is for, from what it covers.
    static func what(_ d: Fleet.Delegation) -> String {
        if d.verbs.contains("exchange") { return "Finishing a sign-in" }
        if d.verbs == ["vmctl"] { return "Ending machines kept ready" }
        if d.verbs == ["provision"] && d.expires - d.issuedAt > 24 * 3600 * 1000 { return "Making machines kept ready" }
        if d.verbs.count > 8 { return "An MCP client" }
        return "A request the fleet places: \(d.verbs.joined(separator: ", "))"
    }

    /// Where, and until when.
    static func scope(_ d: Fleet.Delegation) -> String {
        let until = Date(timeIntervalSince1970: d.expires / 1000)
            .formatted(date: .abbreviated, time: .shortened)
        let boxes = d.hosts == ["*"] ? "any box" : d.hosts.joined(separator: ", ")
        return "\(boxes) · until \(until)"
    }

    @MainActor
    private func allowMCP(days: Int) async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).allowMCP(days: days)
            result = reply.text ?? ""
        } catch {
            result = error.localizedDescription
        }
        await load()
    }

    @MainActor
    private func revoke(_ d: Fleet.Delegation) async {
        do {
            result = try await Fleet(settings: settings).revokeDelegation(d).text ?? ""
        } catch {
            // Not revoked at the minter, so boxes still take it: said, not swallowed.
            result = error.localizedDescription
        }
        await load()
    }

    @MainActor
    private func load() async {
        do {
            delegations = try await Fleet(settings: settings).delegations()
        } catch {
            if delegations.isEmpty { result = error.localizedDescription }
        }
        loaded = true
    }
}
