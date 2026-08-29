import SwiftUI

/// Sessions that were forgotten and are still recoverable.
///
/// IT LIVES WITH SESSIONS, NOT WITH MACHINES. It was under each host's row,
/// because that is where the volumes are — an implementation detail leaking
/// into the layout. A person forgetting a session is not thinking about which
/// box held it, and by three entries across two hosts the Fleet section was
/// unreadable.
///
/// It is also reachable when EMPTY, which is the other half. A safety net
/// nobody can find until they need it does not reassure anybody, and the app
/// looked for a while like it had no recycle bin at all.
struct RecycleBinView: View {
    let settings: Settings
    let hosts: [Fleet.FleetHost]
    let onChanged: () -> Void

    @State private var busy: String?
    @State private var result = ""
    @State private var purgeTarget: (host: String, name: String)?

    /// Everything binned anywhere, soonest to go first. Flattened across hosts
    /// on purpose: the deadline is what somebody is deciding on, and which
    /// machine holds the volume is a detail they can see but need not sort by.
    private var items: [(host: String, item: Fleet.Binned)] {
        hosts
            .flatMap { host in (host.health?.bin ?? []).map { (host: host.hostId, item: $0) } }
            .sorted { ($0.item.expiresAt ?? 0) < ($1.item.expiresAt ?? 0) }
    }

    var body: some View {
        List {
            if items.isEmpty {
                Section {
                    Text("Nothing here.")
                        .foregroundStyle(.secondary)
                } footer: {
                    // Says what the feature IS, to somebody who has never used
                    // it. An empty screen that only says "empty" teaches
                    // nothing, and this one is the answer to a mistake people
                    // make at most once.
                    Text("Forgetting a session puts it here for seven days rather than deleting it. "
                         + "Its conversation and workspace are kept, and restoring brings both back.")
                }
            }

            ForEach(items, id: \.item.name) { entry in
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.item.title ?? entry.item.name).font(.headline)
                        Text(describeBinned(entry.item, on: entry.host))
                            .font(.caption)
                            .foregroundStyle((entry.item.remaining ?? "").hasPrefix("goes") ? .orange : .secondary)
                        HStack(spacing: 16) {
                            Button("Restore") { Task { await act(entry.host, entry.item.name, restore: true) } }
                            Button("Delete now", role: .destructive) {
                                purgeTarget = (entry.host, entry.item.name)
                            }
                        }
                        .buttonStyle(.borderless)
                        .disabled(busy != nil)
                    }
                }
            }

            if let target = purgeTarget {
                Section {
                    Text("Delete \(target.name) for good?")
                    Text("The conversation and the workspace go with it. This is the only step here that cannot be undone — forgetting was reversible, this is not.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Delete", role: .destructive) {
                        Task { await act(target.host, target.name, restore: false) }
                    }
                    Button("Cancel", role: .cancel) { purgeTarget = nil }
                }
            }

            if !result.isEmpty {
                Section { Text(result).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Recycle bin")
    }

    @MainActor
    private func act(_ host: String, _ name: String, restore: Bool) async {
        busy = name
        defer { busy = nil }
        do {
            let fleet = Fleet(settings: settings)
            let reply = restore ? try await fleet.restore(name) : try await fleet.purge(name)
            // THE APP WRITES ITS OWN SENTENCE. The host's reply is written for
            // chat and ends in "/restore <name> brings it back" — correct
            // there, and nonsense here, where there is nothing to type and a
            // button that already did it.
            result = reply.ok == false ? (reply.text ?? "That did not work.")
                : restore ? "Restored \(name)." : "Deleted \(name)."
        } catch {
            result = error.localizedDescription
        }
        purgeTarget = nil
        onChanged()
    }
}

/// "on deb132 · 6 days left". The machine is shown because a name can exist on
/// two of them, not because anybody is choosing by it.
private func describeBinned(_ item: Fleet.Binned, on host: String) -> String {
    var parts: [String] = []
    if item.title != nil { parts.append(item.name) }
    parts.append("on \(host)")
    if let remaining = item.remaining { parts.append(remaining) }
    return parts.joined(separator: " · ")
}
