import SwiftUI

/// What the Proxmox VE machines a box made printed as they booted, kept by
/// that box (src/fleet/host/pve-console.js, docs/proxmox.md "A machine that
/// does not join"). Asked for: "add some troubleshooting for VMs that dont
/// join as we cant ssh and get the logs".
///
/// WHAT THIS PAGE IS FOR: the machine that never joined, which nothing else
/// reaches. One row per machine, newest first, with the one word for how its
/// join went; the one that did not say it joined wears the attention colour,
/// and its row opens what its screen showed. Same as Android (BootLogs.kt).
struct BootLogsView: View {
    let fleet: Fleet
    let hostId: String

    @State private var machines: [Fleet.BootMachine]?
    @State private var failed: String?

    var body: some View {
        List {
            Section {
                if let failed {
                    Text(failed)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.attention)
                } else if let machines {
                    if machines.isEmpty {
                        Text(BootWords.none)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    ForEach(machines, id: \.self) { m in
                        NavigationLink {
                            BootLogView(fleet: fleet, hostId: hostId, machine: m.name)
                        } label: {
                            row(m)
                        }
                    }
                } else {
                    Text(BootWords.reading)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            } footer: {
                Text(BootWords.footer)
            }
            .listRowBackground(Design.Palette.card)
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(BootWords.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func row(_ m: Fleet.BootMachine) -> some View {
        let state = BootWords.state(joined: m.joined, reading: m.reading)
        return VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(m.name)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                Text(state.word)
                    .fleetType(.label)
                    .foregroundStyle(state.trouble ? Design.Palette.attention : Design.Palette.inkDim)
            }
            Text([m.address, m.at.map { relativeTime($0) }].compactMap { $0 }.joined(separator: " · "))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        do {
            let r = try await fleet.logs(host: hostId, service: "boot")
            if r.ok == false || r.boot == nil {
                failed = r.text?.isBlank == false ? r.text : BootWords.couldNot
                return
            }
            machines = r.boot?.machines ?? []
            failed = nil
        } catch {
            failed = error.localizedDescription
        }
    }
}

/// One machine's boot, as the box kept it: the box's sentence on how the join
/// went, then what the screen showed, in the console's own monospace and
/// selectable, because it names addresses and errors that get searched for.
struct BootLogView: View {
    let fleet: Fleet
    let hostId: String
    let machine: String

    @State private var text: String?

    var body: some View {
        ScrollView {
            Text(text ?? BootWords.reading)
                .fleetType(.labelMono)
                .foregroundStyle(text == nil ? Design.Palette.inkDim : Design.Palette.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Design.Space.page)
        }
        .background(Design.Palette.bg)
        .navigationTitle(machine)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let r = try await fleet.logs(host: hostId, service: "boot", machine: machine, lines: 200)
            text = r.text?.isBlank == false ? r.text : BootWords.couldNot
        } catch {
            text = error.localizedDescription
        }
    }
}

/// The page's words, the same on Android (BootLogs.kt); a test holds the two
/// equal (test/boot-logs-in-apps.test.js).
enum BootWords {
    static let title = "Machines it made"
    static let none = "It has made no Proxmox VE machine since it last started."
    static let reading = "Reading…"
    static let couldNot = "Couldn’t read what this machine kept."
    static let footer = "What each Proxmox VE machine it made showed on its screen while it booted, kept for a day."
    static let joined = "Joined"
    static let stillReading = "Booting"
    static let notJoined = "Didn’t join"

    /// One word for how its join went. Not joined is the one that wants
    /// something, and it is said as that, never as nothing.
    static func state(joined: Bool?, reading: Bool?) -> (word: String, trouble: Bool) {
        if joined == true { return (Self.joined, false) }
        if reading == true { return (stillReading, false) }
        return (notJoined, true)
    }
}
