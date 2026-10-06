import SwiftUI

/// Machines kept ready on your hypervisor, so a session starts in seconds.
/// docs/hypervisors.md, "Machines kept ready".
///
/// Asked for: "standby vms to speed up session starts". Up to three machines
/// from one image, booted and joined: a session asking for that image on that
/// network starts on one at once, and the fleet makes another behind it. A
/// machine a session has used is never handed to the next one.
///
/// WHAT IT COSTS IS SAID BEFORE IT IS ASKED FOR: each is a machine's worth of
/// the pool, all the time, replaced when its life runs out.
struct VMStandbyView: View {
    let settings: Settings
    let images: [Fleet.VMImage]

    @State private var kept: Fleet.VMStandby?
    @State private var template = ""
    @State private var network = ""
    @State private var count = 1
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false

    private var fleet: Fleet { Fleet(settings: settings) }
    private var chosen: Fleet.VMImage? { images.first { $0.template == template } }

    var body: some View {
        Form {
            Section {
                Text(stateLine)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                Picker("Image", selection: $template) {
                    ForEach(images) { image in Text(image.label).tag(image.template) }
                }
                .onChange(of: template) { _, _ in network = "" }
                if let networks = chosen?.networks, !networks.isEmpty {
                    Picker("Network", selection: $network) {
                        Text("Behind the edge router").tag("")
                        ForEach(networks) { n in Text(n.name).tag(n.id) }
                    }
                }
                Stepper("Keep \(count) ready", value: $count, in: 0...3)
                Button(count == 0 ? "Stop keeping any" : "Keep them ready") { Task { await save() } }
                    .disabled(busy || (count > 0 && chosen == nil))
                    .frame(minHeight: 44)
                if !message.isBlank {
                    Text(message).fleetType(.label).foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                }
            } header: {
                Text("Keep machines ready").fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
            } footer: {
                Text("A session from this image starts on a ready one at once, and another is made behind it. Each uses a machine’s worth of your pool all the time, and is replaced when its 350 minutes run out.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Keep machines ready")
        .task { await load() }
    }

    /// "2 ready, 1 being made", or that none are kept.
    private var stateLine: String {
        guard let kept else { return "None kept ready." }
        return "\(kept.ready) ready now, \(kept.starting) being made, of \(kept.count) kept."
    }

    @MainActor
    private func load() async {
        // A failure keeps what was shown: nil is keeping none, not cannot tell.
        if let got = try? await fleet.vmStandby() {
            kept = got
            template = got.template
            network = got.network ?? ""
            count = got.count
        } else if template.isEmpty, let first = images.first {
            template = first.template
        }
    }

    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        do {
            let r = try await fleet.setVMStandby(template: count == 0 ? nil : template, count: count,
                                                 network: network.isEmpty ? nil : network)
            failed = r.ok == false
            message = r.text ?? ""
        } catch {
            failed = true
            message = error.localizedDescription
        }
        kept = try? await fleet.vmStandby()
    }
}
