import SwiftUI

/// One machine, everything about it, on a page of its own.
///
/// WHY THIS EXISTS. The fleet screen was two lists of the same machines — a
/// "Hosts" section carrying fingerprints and a revoke swipe, and a "Fleet"
/// section carrying health — so every box appeared twice, four hundred points
/// apart, and neither entry was complete. Below them sat four controls per card:
/// Check, Reboot, a full-width channel picker and a sign-in link, on every
/// machine, whether or not anything was wanted.
///
/// Putting the controls behind a tap made it worse rather than better. A row
/// that grows inside a List jumps: the height changes with no transition to
/// carry it, and what appears is the same wall arriving all at once. That was
/// the right instinct applied in the wrong place — the answer to "this card is
/// doing too much" is not "do it on demand", it is that a machine is a SUBJECT
/// and deserves a page.
///
/// So the list says what each machine is, and this says everything you can do
/// about one. A push animates itself, the controls get room instead of a squeeze
/// between two other cards, and the fingerprint finally sits next to the machine
/// it identifies rather than in a second list of names.
///
/// IT OWNS ITS OWN STATE, deliberately. SettingsView holds one busy flag, one
/// result string and one reboot ceremony shared across every host — which is
/// why the answer had to be tagged with a hostId to be rendered in the right
/// row. Here there is one host, so there is one of each, and none of it can be
/// about a different machine.
struct HostView: View {
    let settings: Settings
    let hostId: String
    /// What the fleet last reported. Passed in rather than fetched: the list
    /// already has it, and a page that starts blank to ask a question it was
    /// handed the answer to is the fault this whole change is about.
    let health: Fleet.HostHealth?
    let state: String?
    let reason: String?
    /// The membership record: fingerprint and whether it has been revoked.
    let enrolled: Fleet.Host?
    /// Called when this page changes something the list should know about.
    var onChange: () async -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var result = ""
    @State private var channel: String?
    @State private var channelPinned = false
    @State private var rebootPin = ""
    @State private var rebootConfirm = ""
    @State private var rebooting = false
    @State private var confirmingRevoke = false
    @State private var pin = ""

    private var fleet: Fleet { Fleet(settings: settings) }

    var body: some View {
        List {
            Section {
                summary
            }
            .listRowBackground(Design.Palette.card)

            Section {
                Button("Check for updates") { run { try await fleet.updates(host: hostId) } }
                if health?.updates?.appUpdatePending == true {
                    Button("Apply update") { run { try await fleet.update(host: hostId, restart: true) } }
                }
                if health?.updates?.systemPending == true {
                    Button("Apply system upgrade") { run { try await fleet.upgrade(host: hostId, apply: true) } }
                }
            } header: {
                sectionHead("Software")
            }
            .listRowBackground(Design.Palette.card)

            channelSection

            Section {
                NavigationLink("Sign in to Claude") {
                    CredentialsView(settings: settings, host: hostId, onlyClaude: true)
                }
                if let fingerprint = enrolled?.fingerprint, !fingerprint.isEmpty {
                    // NEXT TO THE MACHINE IT IDENTIFIES. It lived in a separate
                    // list of names, which is the one place it cannot do its
                    // job: two machines claiming one name is exactly when you
                    // need to see which key is which, beside everything else
                    // that machine is saying.
                    LabeledContent("Key") {
                        Text(fingerprint)
                            .fleetType(.labelMono)
                            .foregroundStyle(Design.Palette.inkDim)
                            .textSelection(.enabled)
                    }
                }
            } header: {
                sectionHead("Identity")
            }
            .listRowBackground(Design.Palette.card)

            dangerSection

            if !result.isEmpty {
                Section {
                    // THE BOX'S OWN WORDS, on an inner surface: this is quoted
                    // from somewhere else and should not look like something
                    // this screen said.
                    Text(result)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                }
                .listRowBackground(Design.Palette.inner)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(hostId)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
        .task {
            channel = health?.channel
            channelPinned = health?.channelPinned ?? false
        }
    }

    // MARK: - the parts
    //
    // Split up because this screen's body grew past what the Swift type checker
    // will spend on one expression — the failure names a line nobody edited, and
    // it only happens on CI, which is the only machine that builds for a device.

    @ViewBuilder private var summary: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline) {
                Text(state ?? "unknown")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(state == "healthy" ? Design.Palette.ok : Design.Palette.attention)
                Spacer(minLength: 0)
            }
            // Only when it is news. "reporting normally" under the word
            // "healthy" is the same fact twice.
            if let reason, !reason.isEmpty, state != "healthy" {
                Text(reason).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            if let accounts = health?.claudeAccounts {
                Text(describeWhoCanStart(accounts, account: health?.account))
                    .fleetType(.label)
                    .foregroundStyle(accounts == 0 ? Design.Palette.attention : Design.Palette.inkDim)
            }
            if let version = health?.version?.head, !version.isEmpty {
                Text(version).fleetType(.labelMono).foregroundStyle(Design.Palette.inkDim)
            }
        }
        .padding(.vertical, Design.Space.hair)
    }

    @ViewBuilder private var channelSection: some View {
        Section {
            if channelPinned {
                // Said as an answer rather than offered as a choice, because
                // the box's environment is forcing it and a picker that refuses
                // is worse than a sentence.
                LabeledContent("Channel") {
                    Text("\(channel ?? "stable"), set on the box").fleetType(.label)
                }
            } else if let now = channel {
                Picker("Channel", selection: Binding(
                    get: { now },
                    set: { pick in run { try await fleet.channel(host: hostId, to: pick) } }
                )) {
                    Text("Stable").tag("stable")
                    Text("Rolling").tag("rolling")
                }
                .pickerStyle(.segmented)
            }
        } header: {
            sectionHead("Releases")
        } footer: {
            Text("Stable takes published releases. Rolling takes the newest build of main, on every merge.")
        }
        .listRowBackground(Design.Palette.card)
    }

    @ViewBuilder private var dangerSection: some View {
        Section {
            Button("Reboot", role: .destructive) {
                rebooting = true
                run { try await fleet.reboot(host: hostId) }
            }
            if rebooting {
                // TWO STEPS, AND THE PIN COMES FROM THE BOX. A coordinator that
                // could mint it could reboot the fleet, so the machine issues
                // its own — and the hostname is typed out because a remote
                // reboot should be harder than a local one, not easier.
                TextField("PIN from the box", text: $rebootPin)
                    .fleetType(.labelMono)
                TextField("Type \(hostId) to confirm", text: $rebootConfirm)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("Reboot \(hostId)", role: .destructive) {
                    run { try await fleet.reboot(host: hostId, pin: rebootPin, confirm: rebootConfirm) }
                    rebooting = false
                    rebootPin = ""
                    rebootConfirm = ""
                }
                .disabled(rebootConfirm != hostId || rebootPin.isEmpty)
            }
            if enrolled?.isRevoked == false {
                Button("Revoke this host", role: .destructive) { confirmingRevoke = true }
            }
            if !pin.isEmpty {
                LabeledContent("Pin") { Text(pin).fleetType(.labelMono).textSelection(.enabled) }
            }
            Button(enrolled?.isRevoked == true ? "Readmit" : "Replace key") {
                Task {
                    busy = true
                    defer { busy = false }
                    do { pin = try await fleet.mintHostPin(hostId: hostId, readmit: enrolled?.isRevoked == true) }
                    catch { result = error.localizedDescription }
                }
            }
        } header: {
            sectionHead("This machine")
        }
        .listRowBackground(Design.Palette.card)
        .alert("Revoke \(hostId)?", isPresented: $confirmingRevoke) {
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) {
                Task {
                    busy = true
                    defer { busy = false }
                    // The refusal reaches the screen. Discarding it is how a 403
                    // reads as "the host came back".
                    do { result = try await fleet.revokeHost(hostId).text ?? "" }
                    catch { result = error.localizedDescription }
                    await onChange()
                    dismiss()
                }
            }
        } message: {
            Text("It is disconnected immediately, and its sessions keep running without it. "
                 + "Getting it back means a new pin, typed on that box.")
        }
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }

    /// One action, one place the busy flag and the answer are set.
    private func run(_ work: @escaping () async throws -> Fleet.Reply) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let reply = try await work()
                result = reply.text ?? ""
                // BELIEVE THE REPLY. The host pushes a health frame after a
                // mutating verb, but the list's own refresh races it, and losing
                // that race shows the value somebody just changed away from.
                if let now = reply.channel { channel = now; channelPinned = reply.channelPinned ?? false }
            } catch {
                result = error.localizedDescription
            }
            await onChange()
        }
    }
}
