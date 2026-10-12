import SwiftUI

/// The pools' own machines waiting on you, at the top of Machines: one card
/// each, the same shape as every other (RHYTHM 1), wearing the attention ring
/// when one has asked to join, because that is a machine wanting something.
///
/// LET IT IN IS ONE APPROVAL. Face ID opens the secrets this phone gave the
/// policy jobs that made them (HolderJoin); the request one of them proves
/// is the one let in, so the fleet enrols that key and the vault lets the
/// same key hold that pool and nothing else of yours. A request none of them
/// proves is said as such and nothing is let in.
///
/// ONLY WHAT EXISTS (C-2). A name that has not been asked under yet has no
/// buttons: there is nothing to let in, and the line says what to do if it
/// never asks.
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

    private var fleet: Fleet { Fleet(settings: settings) }

    private var shown: [HolderJoin.Waiting] {
        waiting.filter { w in !admitted.contains { $0.hostId == w.hostId } } + admitted
    }

    var body: some View {
        ForEach(shown) { w in
            card(w)
                .fleetCard(radius: Design.Radius.cardSmall, ring: w.requests.isEmpty || isIn(w) ? Design.Palette.ring : Design.Palette.attention.opacity(0.55))
                .fleetRow()
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

    @MainActor
    private func letIn(_ w: HolderJoin.Waiting) async {
        busy = w.hostId
        defer { busy = nil }
        guard let secrets = await HolderJoin.unlock(w.address, reason: HolderJoin.reason(w.hostId, w.address)) else { return }
        if secrets.isEmpty {
            said[w.hostId] = HolderJoin.notThisPhone(w.hostId)
            return
        }
        guard let match = HolderJoin.proven(w, secrets: secrets.map(\.value)) else {
            said[w.hostId] = HolderJoin.notProven(w.hostId)
            return
        }
        do {
            let answer = try await fleet.approveHolder(w.hostId, key: match.request.key)
            guard answer.ok == true else {
                said[w.hostId] = answer.text ?? "The fleet did not let \(w.hostId) in."
                return
            }
            admitted.append(w)
            if let secret = secrets.first(where: { $0.value == match.secret }) { HolderJoin.spent(secret) }
            do {
                _ = try await PhoneVault(settings: settings).approveHolder(fleet, hostId: w.hostId, key: match.request.publicJwk, address: w.address)
                said[w.hostId] = HolderJoin.joined(w.hostId, w.address)
            } catch {
                said[w.hostId] = HolderJoin.joinedNotHolding(w.hostId, error.localizedDescription)
            }
            await reload()
        } catch {
            said[w.hostId] = error.localizedDescription
        }
    }

    @MainActor
    private func decline(_ w: HolderJoin.Waiting) async {
        busy = w.hostId
        defer { busy = nil }
        for request in w.requests { _ = try? await fleet.declineHolder(w.hostId, key: request.key) }
        await reload()
    }
}
