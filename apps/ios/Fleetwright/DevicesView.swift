import SwiftUI

/// The devices holding a credential for this fleet.
///
/// Signing in mints one credential per device precisely so that revoking one
/// leaves every other alone, and that is worth nothing while nobody can see
/// the list. Revoking is the fleet admin's: the coordinator refuses it to
/// anybody else, so for anybody else there is no swipe to refuse.
struct DevicesView: View {
    let settings: Settings

    @State private var clients: [Fleet.Client] = []
    @State private var loaded = false
    @State private var confirmingRevoke: Fleet.Client?
    @State private var result = ""

    private var canRevoke: Bool { settings.showsAdmin }

    /// IN USE FIRST, newest first. The coordinator sorts by when a credential
    /// was MINTED, which put seven never-used sign-ins above the phone in the
    /// hand holding it.
    private var clientsInUse: [Fleet.Client] {
        clients.filter { $0.lastSeenAt != nil }.sorted { ($0.lastSeenAt ?? 0) > ($1.lastSeenAt ?? 0) }
    }

    /// Minted and never spent — an abandoned sign-in.
    private var clientsNeverUsed: [Fleet.Client] {
        clients.filter { $0.lastSeenAt == nil }
    }

    var body: some View {
        List {
            Section {
                if clients.isEmpty {
                    Text(loaded ? "No devices reported." : "Asking the fleet…")
                        .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                ForEach(clientsInUse) { c in
                    clientRow(c)
                }
                // AND THE ABANDONED ONES FOLD AWAY: still here, still
                // revocable, no longer the first thing on the screen.
                if !clientsNeverUsed.isEmpty {
                    DisclosureGroup("\(clientsNeverUsed.count) never used") {
                        ForEach(clientsNeverUsed) { c in
                            clientRow(c)
                        }
                    }
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                }
                if !result.isBlank {
                    Text(result).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
            } footer: {
                Text(canRevoke
                     ? "Each sign-in mints a credential for that device alone, so revoking one leaves the others working. Swipe to revoke a device you no longer have."
                     : "Each sign-in mints a credential for that device alone. Lost one? This fleet's admin can revoke it.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Devices")
        .refreshable { await load() }
        .task { await load() }
        .alert(
            "Revoke \(confirmingRevoke?.name ?? "this device")?",
            isPresented: Binding(
                get: { confirmingRevoke != nil },
                set: { if !$0 { confirmingRevoke = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { confirmingRevoke = nil }
            Button("Revoke", role: .destructive) {
                guard let c = confirmingRevoke else { return }
                confirmingRevoke = nil
                Task {
                    // The refusal reaches the screen: a discarded error reads
                    // as "it came back".
                    do {
                        result = try await Fleet(settings: settings).revokeClient(c.id).text ?? ""
                    } catch {
                        result = error.localizedDescription
                    }
                    await load()
                }
            }
        } message: {
            Text("That device stops being able to reach this fleet, and its push notifications "
                 + "stop. Every other device keeps working. Signing in again on it mints a new one.")
        }
    }

    @ViewBuilder private func clientRow(_ c: Fleet.Client) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(c.name ?? "unnamed device").fleetType(.body)
            Text(describeClient(c)).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
        }
        .swipeActions {
            if canRevoke {
                Button("Revoke", role: .destructive) { confirmingRevoke = c }
            }
        }
    }

    /// "last used 2 hours ago", and the address only when it is somebody
    /// else's, which is the case where it is news. The name already carries
    /// the address, and eleven rows printing it twice told nothing apart.
    private func describeClient(_ c: Fleet.Client) -> String {
        var parts: [String] = []
        if let email = c.email, !email.isEmpty, email != settings.signedInAs { parts.append(email) }
        if let seen = c.lastSeenAt {
            parts.append("last used \(relativeTime(seen))")
        } else {
            // NOT A FOOTNOTE: an abandoned sign-in is why somebody is here.
            parts.append(canRevoke ? "never used — safe to revoke" : "never used")
        }
        return parts.joined(separator: " · ")
    }

    @MainActor
    private func load() async {
        if let got = try? await Fleet(settings: settings).clients() { clients = got }
        loaded = true
    }
}
