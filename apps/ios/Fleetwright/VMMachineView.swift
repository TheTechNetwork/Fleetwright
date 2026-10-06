import SwiftUI

/// One machine made on your hypervisor: what it is, how to reach it, and what
/// you can do about it. docs/hypervisors.md, "Working a machine".
///
/// Asked for: "Vm console, settings, reboot, ssh". Everything here is what the
/// box holding the pool last saw, and every fact may be missing: nil is
/// CANNOT TELL and is said so, never drawn as a blank or a zero (C-5).
///
/// THE CONSOLE IS XEN ORCHESTRA'S OWN, opened in the browser where you sign in
/// to it. This phone never holds the pool's token, and a console stream
/// through the fleet would make it hold one.
///
/// THE ACTIONS ARE THE BOX'S: it holds the token and works the machine under
/// your name, and only a machine tagged as made for you (xo-pools.js,
/// `control`). Each that interrupts a session asks first.
struct VMMachineView: View {
    let settings: Settings
    let name: String

    @State private var machine: Fleet.VMMachine?
    @State private var loaded = false
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var cpus = 2
    @State private var memoryGiB = 4
    @State private var asking: Ask?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What is waiting on a yes.
    private enum Ask: Identifiable {
        case restart, resize, end
        var id: Self { self }
    }

    private var fleet: Fleet { Fleet(settings: settings) }

    var body: some View {
        Form {
            if let machine {
                facts(machine)
                reach(machine)
                work(machine)
            } else if !loaded {
                Text("Asking the fleet…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            } else {
                Text("The fleet has no report of this machine. The box holding your pool may not have looked yet, or it has been removed.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(name)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(askTitle, isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible, presenting: asking) { ask in
            switch ask {
            case .restart:
                Button("Restart") { Task { await act("reboot") } }
            case .resize:
                Button("Restart with \(cpus) vCPUs and \(memoryGiB) GiB") { Task { await act("resize") } }
            case .end:
                Button("End it now", role: .destructive) { Task { await act("stop") } }
            }
        }
    }

    private var askTitle: String {
        switch asking {
        case .restart?: return "Restart \(name)? A session running on it ends."
        case .resize?: return "Restart \(name) with the new size? A session running on it ends."
        case .end?: return "End \(name) now? It is stopped and removed with its disk, and anything on it is lost."
        case nil: return ""
        }
    }

    // MARK: What it is

    @ViewBuilder
    private func facts(_ m: Fleet.VMMachine) -> some View {
        Section {
            fact("State", vmStateWords(m.state), tone: m.state == "Running" ? Design.Palette.ok : Design.Palette.attention)
            fact("Made from", m.image ?? "Not reported")
            fact("On", m.address)
            fact("Network", m.network ?? "Not reported")
            fact("Size", sizeWords(m))
            fact("Ends", endWords(m))
        } header: {
            sectionHead("This machine")
        }
    }

    // MARK: How to reach it

    @ViewBuilder
    private func reach(_ m: Fleet.VMMachine) -> some View {
        Section {
            if let ssh = m.sshCommand {
                HStack {
                    Text(ssh)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                    Spacer(minLength: Design.Space.insideTight)
                    Button("Copy") { UIPasteboard.general.string = ssh }
                        .frame(minHeight: 44)
                        .accessibilityLabel("Copy the SSH command")
                }
            } else {
                Text("No address reported yet. Its guest agent says it once it has booted.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if let console = m.consoleURL {
                Link(destination: console) {
                    Label("Open its console in Xen Orchestra", systemImage: "rectangle.on.rectangle")
                        .frame(minHeight: 44)
                }
            }
        } header: {
            sectionHead("Reach it")
        } footer: {
            Text("SSH takes the public keys you keep under You › SSH keys, on machines made after you add them. "
                 + "The console is Xen Orchestra’s own page, which asks you to sign in there: this phone never holds the pool’s token.")
        }
    }

    // MARK: What you can do

    @ViewBuilder
    private func work(_ m: Fleet.VMMachine) -> some View {
        Section {
            Button("Restart") { asking = .restart }
                .disabled(busy || m.state != "Running")
                .frame(minHeight: 44)
            // LONGER, up to its longest life from when it was made. Not drawn
            // past that: a button that can only be refused is not an action.
            if canExtend(m) {
                Menu("Give it longer") {
                    Button("30 minutes") { Task { await act("extend", minutes: 30) } }
                    Button("1 hour") { Task { await act("extend", minutes: 60) } }
                    Button("2 hours") { Task { await act("extend", minutes: 120) } }
                }
                .disabled(busy)
                .frame(minHeight: 44)
            }
            Stepper("\(cpus) vCPU\(cpus == 1 ? "" : "s")", value: $cpus, in: 1...64)
                .disabled(busy)
            Stepper("\(memoryGiB) GiB of memory", value: $memoryGiB, in: 1...512)
                .disabled(busy)
            Button("Restart with this size") { asking = .resize }
                .disabled(busy || (cpus == m.cpus && Int64(memoryGiB) * gib == Int64(m.memory ?? -1)))
                .frame(minHeight: 44)
            Button("End it now", role: .destructive) { asking = .end }
                .disabled(busy)
                .frame(minHeight: 44)
            if !message.isBlank {
                Text(message)
                    .fleetType(.label)
                    .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                    .textSelection(.enabled)
            }
        } header: {
            sectionHead("Work it")
        } footer: {
            Text("A machine lives at most \(Fleet.VMMachine.maxMinutes) minutes from when it was made. A new size is "
                 + "held to your pool’s limits, and the machine restarts at its old size if the pool refuses.")
        }
    }

    // MARK: Words

    private func fact(_ label: String, _ value: String, tone: Color = Design.Palette.ink) -> some View {
        LabeledContent {
            Text(value).fleetType(.label).foregroundStyle(tone).multilineTextAlignment(.trailing)
        } label: {
            Text(label).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44)
    }

    private func sizeWords(_ m: Fleet.VMMachine) -> String {
        let parts = [m.cpus.map { "\($0) vCPU\($0 == 1 ? "" : "s")" },
                     m.memory.map { XOPolicy.gibText(Int64($0)) }].compactMap { $0 }
        return parts.isEmpty ? "Not reported" : parts.joined(separator: ", ")
    }

    private func endWords(_ m: Fleet.VMMachine) -> String {
        guard let until = m.until else { return "Cannot tell" }
        let at = Date(timeIntervalSince1970: until / 1000).formatted(date: .omitted, time: .shortened)
        return "\(at), \(relativeTime(until))"
    }

    private func canExtend(_ m: Fleet.VMMachine) -> Bool {
        guard let made = m.madeAt, let until = m.until else { return false }
        return until < made + Double(Fleet.VMMachine.maxMinutes) * 60_000
    }

    private let gib: Int64 = 1024 * 1024 * 1024

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }

    // MARK: Asking

    @MainActor
    private func load() async {
        // A FAILED REQUEST IS NOT A MISSING MACHINE: what was shown stays.
        if let got = try? await fleet.vmMachines() {
            let found = got.first { $0.name == name }
            withAnimation(Design.Motion.settle(reduceMotion)) { machine = found }
            if let found, !busy {
                cpus = found.cpus ?? cpus
                if let bytes = found.memory { memoryGiB = max(1, Int((bytes / Double(gib)).rounded())) }
            }
        }
        loaded = true
    }

    @MainActor
    private func act(_ action: String, minutes: Int? = nil) async {
        busy = true
        defer { busy = false }
        message = ""
        do {
            let r = try await fleet.vmctl(name, action: action, minutes: minutes,
                                          cpus: action == "resize" ? cpus : nil,
                                          memoryGiB: action == "resize" ? memoryGiB : nil)
            failed = r.ok == false
            message = r.text ?? (failed ? "The fleet refused that." : "Done.")
        } catch {
            failed = true
            message = error.localizedDescription
        }
        await load()
    }
}

/// Xen Orchestra's power state in this app's words; nil is cannot tell.
func vmStateWords(_ state: String?) -> String {
    switch state {
    case "Running"?: return "running"
    case "Halted"?: return "stopped"
    case "Suspended"?: return "suspended"
    case "Paused"?: return "paused"
    case let other?: return other.lowercased()
    case nil: return "cannot tell"
    }
}
