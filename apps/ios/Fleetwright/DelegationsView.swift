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
///
/// WHOM AN MCP CLIENT MAY START SESSIONS AS IS CHOSEN HERE, AND SIGNED. A
/// session as a member runs on that member's sign-ins, and a box refuses a
/// delegated start as a member the grant does not name. So the members this
/// person may start as (`you.startAs`, the fleet's answer) are each a switch,
/// all off until one is turned on, and the ones that are on go into the grant
/// this phone signs. Nothing is drawn for somebody the fleet lists none for.
/// A delegation that names members says which on its row. A MACHINE FROM
/// BEFORE THE FIELD checks a signature over a grant without it, so it refuses
/// one that names members as badly signed: the switches say so, and what to
/// do, before anybody meets that refusal.
struct DelegationsView: View {
    let settings: Settings

    @State private var delegations: [Fleet.Delegation] = []
    @State private var loaded = false
    @State private var busy = false
    @State private var confirmingRevoke: Fleet.Delegation?
    @State private var result = ""
    /// The members this person may start a session as, as the fleet lists
    /// them. Empty until it answers, and from a fleet older than members.
    @State private var startable: [Fleet.Member] = []
    /// The members the next grant to an MCP client names. None, until chosen.
    @State private var chosen: Set<String> = []

    var body: some View {
        List {
            Section {
                if delegations.isEmpty {
                    Text(loaded ? "Nothing is delegated. What the app sends now, it signs as it sends it." : "Loading…")
                        .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                ForEach(delegations) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.what(d)).fleetType(.body)
                        Text(Self.scope(d) + Self.startsAs(d, names: startable)).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    .swipeActions {
                        Button("Revoke", role: .destructive) { confirmingRevoke = d }
                    }
                }
                if !result.isBlank {
                    Text(result).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
            } footer: {
                Text("A machine that takes only what you signed takes these in your name until they run out. Swipe to revoke one.")
            }

            Section {
                ForEach(startable) { member in
                    Toggle("Start sessions as \(member.name)", isOn: Binding(
                        get: { chosen.contains(member.id) },
                        set: { on in
                            if on { chosen.insert(member.id) } else { chosen.remove(member.id) }
                        }
                    ))
                    .disabled(busy)
                    .frame(minHeight: 44)
                }
                if !startable.isEmpty {
                    Text(mcpMembersSentence)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(mcpMembersOlderMachine)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Allow for a day") { Task { await allowMCP(days: 1) } }
                    .disabled(busy)
                Button("Allow for a week") { Task { await allowMCP(days: 7) } }
                    .disabled(busy)
            } header: {
                Text("An MCP client")
            } footer: {
                Text("Lets an MCP client signed in as you start, read, stop and resume sessions and make machines, on any machine, until it runs out. "
                     + "It cannot reboot or upgrade a machine, or move your credentials.")
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
            Text("Machines refuse it from the next key list they take, within ten minutes. What it was for asks you to sign again.")
        }
    }

    /// What a delegation is for, from what it covers.
    static func what(_ d: Fleet.Delegation) -> String {
        if d.verbs.contains("exchange") { return "Finishing a sign-in" }
        if d.verbs == ["vmctl"] { return "Ending machines kept ready" }
        if d.verbs == ["provision"] && d.expires - d.issuedAt > 24 * 3600 * 1000 { return "Making machines kept ready" }
        if d.verbs.count > 8 { return "An MCP client" }
        return "Sent in your name: \(d.verbs.joined(separator: ", "))"
    }

    /// Where, and until when.
    static func scope(_ d: Fleet.Delegation) -> String {
        let until = Date(timeIntervalSince1970: d.expires / 1000)
            .formatted(date: .abbreviated, time: .shortened)
        let machines = d.hosts == ["*"] ? "any machine" : d.hosts.joined(separator: ", ")
        return "\(machines) · until \(until)"
    }

    /// Whom a delegation may start sessions as, for the end of its row: by
    /// name where this page has the name, by id where it does not. Empty for
    /// a delegation that names nobody.
    static func startsAs(_ d: Fleet.Delegation, names: [Fleet.Member]) -> String {
        let ids = d.members ?? []
        if ids.isEmpty { return "" }
        let said = ids.map { id in names.first { $0.id == id }?.name ?? id }
        return " · starts sessions as \(said.joined(separator: ", "))"
    }

    @MainActor
    private func allowMCP(days: Int) async {
        busy = true
        defer { busy = false }
        do {
            let reply = try await Fleet(settings: settings).allowMCP(days: days, members: Array(chosen))
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
        // WHO THIS PERSON MAY START AS, for the switches under An MCP client.
        // Only from an answer that carries the list. Anything else leaves
        // what was there, and with nothing there no switch is drawn.
        if let got = try? await Fleet(settings: settings).members(), got.ok != false, let list = got.members {
            let ids = got.you?.startAs ?? []
            startable = list.filter { ids.contains($0.id) }
            chosen = chosen.intersection(ids)
        }
    }
}

/// What turning on a member under An MCP client does, in one sentence. The
/// same sentence as Android.
let mcpMembersSentence = "The MCP client may start a session as a member turned on here, on that member's sign-ins, and as no other member."

/// What an older machine does with a grant that names members, and what to
/// do first. It rebuilds the signed bytes without the field, so the whole
/// grant fails its check there: every stop and read the client sends that
/// machine, where this used to say only a start as a member was refused.
/// The same sentence as Android.
let mcpMembersOlderMachine = "A machine from before members could be named refuses everything sent under a grant that names one, not only a start as a member. Update that machine before turning a member on."
