import SwiftUI

/// One machine made on your hypervisor: what it is, how to reach it, and what
/// you can do about it. docs/hypervisors.md, "Working a machine".
///
/// Asked for: "Vm console, settings, reboot, ssh". Everything here is what the
/// box holding the pool last saw, and every fact may be missing: nil is
/// CANNOT TELL and is said so, never drawn as a blank or a zero (C-5).
///
/// THE CONSOLE IS IN THE APP WHERE THIS PHONE HOLDS THE POOL'S TOKEN
/// (VMConsoleView, the pool page's own): the phone opens the socket to Xen
/// Orchestra with the token and the pinned certificate, and a web view draws
/// the bytes, never seeing the token. Asked for: "Why not open in web view":
/// this page is drawn from what the box holding the pool saw and works on a
/// phone without the token, so it offered only Xen Orchestra's own page in
/// Safari, and said this phone never holds the token, which on the phone
/// that set the pool up was not so. Without the token it is still Xen
/// Orchestra's page, where you sign in. Away from the pool, the console comes
/// through one of your machines (ConsoleTunnel), the TLS still this phone's.
///
/// THE ACTIONS ARE THE BOX'S: it holds the token and works the machine under
/// your name, and only a machine tagged as made for you (xo-pools.js,
/// `control`). Each that interrupts a session asks first.
///
/// WHAT IT DID ON THE NETWORK is the hypervisor's count at its interfaces,
/// which a session on the machine cannot change: how much, not where to.
struct VMMachineView: View {
    let settings: Settings
    let name: String

    @State private var machine: Fleet.VMMachine?
    @State private var loaded = false
    /// This phone holds the token of the pool this machine is on
    /// (XOSetupHandoff), read with the machine: the console in the app is
    /// offered only then (C-2).
    @State private var holdsHere = false
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
                traffic(machine)
                reach(machine)
                work(machine)
            } else if !loaded {
                Text("Loading…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            } else {
                // NO REPORT IS NOT "REMOVED" (C-5): the machine holding the
                // pool may not have looked yet, and this page cannot tell
                // that from a machine that is gone, so it says neither.
                Text("No report of this machine yet.")
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
            // IN A GROUP: where the others reach it, by address and by name.
            // An address the pool has not reported is unknown, not blank (C-5).
            if let group = m.group {
                fact("Group", "\(group) · \(m.groupIp ?? "address unknown") · \(m.name).local")
            }
            // IN A LAB: which, and its kind. What each kind reaches is New
            // session's sentence, where the choice is made.
            if let lab = m.lab {
                fact("Lab", "\(lab.name) · " + (lab.open ? "open" : "closed"))
            }
            fact("Size", sizeWords(m))
            fact("Ends", endWords(m))
        } header: {
            sectionHead("This machine")
        }
    }

    // MARK: What it did on the network

    @ViewBuilder
    private func traffic(_ m: Fleet.VMMachine) -> some View {
        Section {
            if let net = m.net, !net.rx.isEmpty {
                TrafficChart(traffic: net)
                    .frame(height: 56)
                    .padding(.vertical, Design.Space.insideTight)
                Text("Received is the solid line, sent the dashed one.")
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                fact("Now", nowWords(net))
                fact("Last \(net.minutes) minutes", totalWords(net))
            } else {
                Text(noTrafficWords(m))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("On the network")
        } footer: {
            // Who counted is the one fact that makes the figure trustworthy:
            // nothing on the machine can change the hypervisor's count. That
            // it is how much and not where to, the chart's two lines say.
            Text("Measured by the hypervisor.")
        }
    }

    private func nowWords(_ net: Fleet.VMMachine.Traffic) -> String {
        guard let rx = net.rx.last ?? nil, let tx = net.tx.last ?? nil else { return "Not counted in the last minute" }
        return "\(rateText(rx)) in, \(rateText(tx)) out"
    }

    private func totalWords(_ net: Fleet.VMMachine.Traffic) -> String {
        let total = "\(bytesText(net.received)) in, \(bytesText(net.sent)) out"
        guard net.gaps > 0 else { return total }
        let gap = Int((Double(net.gaps) * net.interval / 60).rounded())
        return "\(total), with \(gap) minute\(gap == 1 ? "" : "s") not counted"
    }

    /// Nothing reported is said for what it is: a stopped machine sends
    /// nothing, a running one the pool did not answer for has no data yet,
    /// and one whose state is unknown is unknown here too (C-5).
    private func noTrafficWords(_ m: Fleet.VMMachine) -> String {
        switch m.state {
        case "Running"?: return "No traffic data yet."
        case nil: return "Unknown."
        default: return "It is not running, so there is nothing to count."
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
                // Its guest agent reports the address once it is up; the
                // agent is mechanism, the boot is the news.
                Text("No address yet. It appears once the machine boots.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // IN THE APP where this phone holds the pool's token, for a machine
            // that is running (a stopped one has no screen); Xen Orchestra's
            // own page otherwise, where you sign in.
            if holdsHere, m.state == "Running", let vm = m.vm {
                NavigationLink {
                    VMConsoleView(address: m.address, vm: vm, name: m.name, settings: settings)
                } label: {
                    Label(Manage.Words.console, systemImage: "rectangle.on.rectangle")
                        .frame(minHeight: 44)
                }
            } else if let console = m.consoleURL {
                Link(destination: console) {
                    Label("Open its console in Xen Orchestra", systemImage: "rectangle.on.rectangle")
                        .frame(minHeight: 44)
                }
            }
        } header: {
            sectionHead("Reach it")
        } footer: {
            Text("SSH uses the keys under You › SSH keys, on machines made after you add them." + consoleFooter)
        }
    }

    /// Where the console goes, as it stands for this phone: nothing to add
    /// when it opens in the app, and that it is Xen Orchestra's own page,
    /// with its own sign-in, when it does not. How the one in the app holds
    /// the token and the certificate is this file's header, not the footer.
    /// The same words as Android (VmMachinePage).
    private var consoleFooter: String {
        holdsHere ? "" : " The console opens Xen Orchestra, where you sign in."
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
            // The one limit every button here runs into. A size the pool
            // refuses is said in the reply when it happens, not in advance.
            Text("Machines last up to \(Fleet.VMMachine.maxMinutes) minutes.")
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
        guard let until = m.until else { return "Unknown" }
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
            holdsHere = found.map { XOSetupHandoff.held().contains($0.address) } ?? false
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
            // The reason is the reply's own text where there is one; this is
            // the verdict for a refusal that gave none.
            message = r.text ?? (failed ? "Didn't work." : "Done.")
        } catch {
            failed = true
            message = error.localizedDescription
        }
        await load()
    }
}

/// Bytes, the way a person reads them: 4.2 MB, and 0 bytes rather than
/// the formatter's "Zero KB".
func bytesText(_ bytes: Double) -> String {
    let f = ByteCountFormatter()
    f.countStyle = .decimal
    f.allowsNonnumericFormatting = false
    return f.string(fromByteCount: Int64(bytes.rounded()))
}

/// A rate, the same way: 12 kB/s.
func rateText(_ perSecond: Double) -> String { "\(bytesText(perSecond))/s" }

/// A machine's traffic as two lines on one scale: received solid, sent
/// dashed, so the two never rest on colour alone. A sample nobody counted
/// breaks the line rather than drawing it to zero. The palette's chart ramp,
/// chart5 and chart4, both clear 3:1 against the row in either theme.
struct TrafficChart: View {
    let traffic: Fleet.VMMachine.Traffic

    var body: some View {
        GeometryReader { geo in
            let top = max(1, (traffic.rx + traffic.tx).compactMap { $0 }.max() ?? 1)
            ZStack {
                line(traffic.tx, top: top, in: geo.size)
                    .stroke(Design.Palette.chart4, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round, dash: [4, 3]))
                line(traffic.rx, top: top, in: geo.size)
                    .stroke(Design.Palette.chart5, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
        .accessibilityElement()
        .accessibilityLabel(summary)
    }

    private var summary: String {
        let most = { (a: [Double?]) in a.compactMap { $0 }.max().map(rateText) ?? "nothing counted" }
        return "Over the last \(traffic.minutes) minutes, received at most \(most(traffic.rx)), sent at most \(most(traffic.tx))."
    }

    private func line(_ points: [Double?], top: Double, in size: CGSize) -> Path {
        Path { p in
            let step = points.count > 1 ? size.width / CGFloat(points.count - 1) : 0
            var drawing = false
            for (i, v) in points.enumerated() {
                guard let v else { drawing = false; continue }
                let at = CGPoint(x: CGFloat(i) * step, y: size.height * (1 - CGFloat(v / top)))
                if drawing { p.addLine(to: at) } else { p.move(to: at); drawing = true }
            }
        }
    }
}

/// Xen Orchestra's power state in this app's words; nil is unknown, said as
/// that and never as stopped (C-5).
func vmStateWords(_ state: String?) -> String {
    switch state {
    case "Running"?: return "running"
    case "Halted"?: return "stopped"
    case "Suspended"?: return "suspended"
    case "Paused"?: return "paused"
    case let other?: return other.lowercased()
    case nil: return "unknown"
    }
}
