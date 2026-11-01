import SwiftUI

/// The pools' own machines waiting on you, at the top of Machines: one card
/// each, the same shape as every other (RHYTHM 1), wearing the attention ring
/// when one has asked to join, because that is a machine wanting something.
///
/// LET IT IN IS ONE APPROVAL, AND THE PHONE THAT MADE IT GIVES IT BY ITSELF.
/// The secrets this phone gave the policy jobs that made them (HolderJoin)
/// prove the request of the machine each made; the request one of them
/// proves is the one let in, so the fleet enrols that key and the vault lets
/// the same key hold that pool and nothing else of yours. As soon as a card
/// with a request is on screen the phone tries that quietly (HolderJoin.admit),
/// and the card says how it went; the buttons stay for a request it could
/// not settle by itself: one this phone did not make, or one whose secret is
/// from before, behind Face ID, which the tap reads. A request none of the
/// secrets proves is said as such and nothing is let in.
///
/// ONLY WHAT EXISTS (C-2). A name that has not been asked under yet has no
/// buttons: there is nothing to let in, and the line says what to do if it
/// never asks, or that this phone will let it in when it does.
struct HoldersAskingView: View {
    let settings: Settings
    /// What the fleet said is waiting, asked for with the rest of Machines.
    let waiting: [HolderJoin.Waiting]
    /// Ask again, after one is let in or declined.
    var reload: () async -> Void = {}

    @State private var busy: String?
    @State private var said: [String: String] = [:]
    /// Let in from this screen: the card stays to say so, without buttons,
    /// for as long as the screen is open.
    @State private var admitted: [HolderJoin.Waiting] = []
    /// Names this phone keeps a secret for: the ones it made.
    @State private var mine: Set<String> = []

    private var fleet: Fleet { Fleet(settings: settings) }

    private var shown: [HolderJoin.Waiting] {
        waiting.filter { w in !admitted.contains { $0.hostId == w.hostId } } + admitted
    }

    var body: some View {
        ForEach(shown) { w in
            card(w)
                .fleetCard(radius: Design.Radius.cardSmall, ring: w.requests.isEmpty || isIn(w) ? Design.Palette.ring : Design.Palette.attention.opacity(0.55))
                .fleetRow()
                // BY ITSELF, once per request on this card: the quiet pass,
                // keyed on the keys asking, so a request that arrives while
                // Machines is open is let in without a tap and a redraw tries
                // nothing twice.
                .task(id: w.requests.map(\.key).sorted().joined(separator: ",")) {
                    if HolderJoin.made(w.address) { mine.insert(w.hostId) } else { mine.remove(w.hostId) }
                    guard !w.requests.isEmpty, !isIn(w), busy == nil else { return }
                    busy = w.hostId
                    let outcome = await HolderJoin.admit(w, fleet: fleet, settings: settings, quietly: true)
                    busy = nil
                    settle(w, outcome)
                }
        }
    }

    /// What an approval, from a tap or by itself, leaves on the card.
    @MainActor
    private func settle(_ w: HolderJoin.Waiting, _ outcome: HolderJoin.Outcome) {
        if let words = outcome.said { said[w.hostId] = words }
        if outcome.isIn {
            admitted.append(w)
            Task { await reload() }
        }
    }

    private func isIn(_ w: HolderJoin.Waiting) -> Bool { admitted.contains { $0.hostId == w.hostId } }

    private func card(_ w: HolderJoin.Waiting) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(w.requests.isEmpty ? w.hostId : HolderJoin.asks(w.hostId))
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
            Text(w.requests.isEmpty ? HolderJoin.notYet(w.hostId) : HolderJoin.toHold(w.address))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            if w.requests.isEmpty && mine.contains(w.hostId) {
                Text(HolderJoin.byItself(w.hostId))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if let words = said[w.hostId] {
                Text(words)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            if !w.requests.isEmpty && !isIn(w) {
                HStack(spacing: Design.Space.insideTight) {
                    Button("Let it in") { Task { await letIn(w) } }
                        .buttonStyle(.borderedProminent)
                    Button("Decline", role: .destructive) { Task { await decline(w) } }
                        .buttonStyle(.bordered)
                }
                .disabled(busy != nil)
                .frame(minHeight: 44)
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// From the tap: the same approval, reading a secret from before behind
    /// Face ID where that is what this phone keeps.
    @MainActor
    private func letIn(_ w: HolderJoin.Waiting) async {
        busy = w.hostId
        defer { busy = nil }
        settle(w, await HolderJoin.admit(w, fleet: fleet, settings: settings, quietly: false))
    }

    @MainActor
    private func decline(_ w: HolderJoin.Waiting) async {
        busy = w.hostId
        defer { busy = nil }
        for request in w.requests { _ = try? await fleet.declineHolder(w.hostId, key: request.key) }
        await reload()
    }
}
