import SwiftUI

/// Set up a Proxmox VE node through a machine of the fleet, for when this
/// phone cannot reach the node itself. docs/proxmox.md, "Through a machine";
/// the machine's half is src/fleet/host/pve-setup.js.
///
/// THE SAME WAY AS EVERYTHING ELSE that reaches a server this phone cannot:
/// the fleet is asked who reaches the node over SSH (`xoprobe`), the person
/// compares the host key that machine saw with the node's console, the
/// machine signs a key for this job alone under `pvesetup-key`, and the root
/// password is sealed to that key, so the fleet relays what it cannot read.
/// The machine then runs on the node exactly what this phone runs when it
/// reaches it (ProxmoxSSH), and the line comes back sealed to a key this
/// phone keeps in the Keychain until the line is in the vault, under its own
/// name (Seal.pvesetupHandoffAAD). The screen may be closed while it runs:
/// the line is collected when the app is next in front (ProxmoxThroughHandoff).
///
/// The same Form, rows and single asking card as adding the watchdog
/// (AddWatchdogView), which is the job it is modelled on: the host key is the
/// one question, and spends the emphasis.
struct ProxmoxThroughMachineView: View {
    let settings: Settings
    /// Told once the line is kept in the vault, with the cluster's address:
    /// the screen this was opened from says it.
    let kept: (String) -> Void

    /// Opened because this phone could not reach the node (AddProxmoxView):
    /// machines are asked at once, and the first that reached it is chosen.
    let auto: Bool

    /// The range of machine numbers the person gave, or empty (AddProxmoxView).
    let vmids: String

    init(settings: Settings, node: String, password: String = "", vmids: String = "", auto: Bool = false, kept: @escaping (String) -> Void) {
        self.settings = settings
        self.kept = kept
        self.auto = auto
        self.vmids = ProxmoxLine.isVmids(vmids) ? vmids : ""
        _address = State(initialValue: node)
        _rootPassword = State(initialValue: password)
    }

    @State private var address = ""
    @State private var probing = false
    @State private var probes: [Fleet.Probe]?
    @State private var probeText = ""
    @State private var chosen: Fleet.Probe?
    @State private var matched = false
    @State private var rootPassword = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var begun: Begun?
    @State private var toCompare: String?
    @State private var job: String?
    @State private var jobAddress = ""
    @State private var hostId = ""
    @State private var progress: Fleet.SetupState?
    @State private var cancelRequested = false
    /// The line is in the vault.
    @State private var lineKept = false
    /// The vault did not take it yet; asked again by the button or later.
    @State private var keepAgain = false

    private struct Begun {
        let job: String
        let hostId: String
        let address: String
        let key: String
    }

    private var fleet: Fleet { Fleet(settings: settings) }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var able: [Fleet.Probe] { (probes ?? []).filter { DeployWords.canInstall($0) } }
    private var running: Bool {
        guard job != nil else { return false }
        return XOSetupWords.isLive(progress?.state ?? "running")
    }
    private var liveState: XOSetupAttributes.ContentState? { XOSetupActivities.contentState(progress) }

    var body: some View {
        Form {
            Section {
                Text(auto ? ProxmoxThroughWords.unreachable(trimmedAddress) : ProxmoxThroughWords.intro)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            whereSection
            if probes != nil { machinesSection }
            if let chosen, job == nil, let key = DeployWords.hostKey(chosen) {
                hostKeySection(chosen, key: key)
                passwordSection(chosen)
            }
            if let job { progressSection(job) }
            if !result.isBlank {
                Section {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .textSelection(.enabled)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle(ProxmoxThroughWords.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: job) { await follow() }
        .task {
            if auto, probes == nil, job == nil, XOSetupKey.isAddress(trimmedAddress) { await probe() }
        }
        .onDisappear { rootPassword = "" }
    }

    // MARK: The node

    private var whereSection: some View {
        Section {
            TextField("The node's address", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(job != nil || busy)
                .onChange(of: address) { _, _ in
                    guard job == nil else { return }
                    probes = nil
                    chosen = nil
                    probeText = ""
                    matched = false
                    toCompare = nil
                }
            Button(probing ? "Asking your machines…" : "Find a machine that can reach it over SSH") { Task { await probe() } }
                .disabled(probing || busy || job != nil || !XOSetupKey.isAddress(trimmedAddress))
                .frame(minHeight: 44)
            if !probeText.isBlank {
                Text(probeText)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        } header: {
            sectionHead("The node")
        } footer: {
            Text("Its host name or address, as you would SSH to it as root.")
        }
    }

    // MARK: Which machine

    private var machinesSection: some View {
        Section {
            if let nobody = ProxmoxThroughWords.nobody(probes ?? [], address: trimmedAddress) {
                Text(nobody)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            ForEach(probes ?? []) { probe in
                if DeployWords.canInstall(probe) {
                    Button { choose(probe) } label: { probeRow(probe) }
                        .disabled(job != nil)
                } else if probe.ssh?.reachable == true {
                    // Said, and not offered (C-2): it reached the node, and
                    // cannot work there.
                    probeRow(probe)
                }
            }
        } header: {
            sectionHead("Which machine sets it up")
        }
    }

    private func probeRow(_ probe: Fleet.Probe) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(probe.hostId)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Text(WatchdogWords.describe(probe))
                    .fleetType(.label)
                    .foregroundStyle(DeployWords.canInstall(probe) ? Design.Palette.inkDim : Design.Palette.attention)
            }
            Spacer(minLength: 0)
            if chosen?.hostId == probe.hostId {
                Image(systemName: "checkmark")
                    .foregroundStyle(Design.Palette.accent)
                    .accessibilityLabel("Chosen")
            }
        }
        .contentShape(Rectangle())
        .frame(minHeight: 44)
    }

    // MARK: The host key

    private func hostKeySection(_ probe: Fleet.Probe, key: Fleet.Probe.SSH.Key) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text("Check this key on the node")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.attention)
                Text("In Proxmox's web interface, open the node's Shell and run:")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Text(DeployWords.keygenCommand(key.type))
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
                Text("It prints this fingerprint, as \(probe.hostId) saw it. If it prints another, something else answered at \(trimmedAddress).")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Text(key.fingerprint)
                    .fleetType(.labelMono)
                    .foregroundStyle(Design.Palette.ink)
                    .textSelection(.enabled)
            }
            .padding(.vertical, Design.Space.hair)
            Toggle(isOn: $matched) {
                Text("It matches the node’s")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
            }
            .tint(Design.Palette.accent)
            .frame(minHeight: 44)
            .disabled(busy || toCompare != nil)
        } header: {
            sectionHead("Its SSH host key")
        } footer: {
            Text("The root password goes only to a server that answers with this key.")
        }
    }

    // MARK: The root password

    private func passwordSection(_ probe: Fleet.Probe) -> some View {
        Section {
            SecureField("Root password of the node", text: $rootPassword)
                .textContentType(.password)
                .disabled(busy || toCompare != nil)
            if let toCompare {
                compareRows(toCompare)
            } else {
                Button(busy ? "Beginning…" : "Set it up from \(probe.hostId)") { Task { await begin(probe) } }
                    .disabled(busy || !matched || rootPassword.isEmpty)
                    .frame(minHeight: 44)
            }
        } header: {
            sectionHead("Root password")
        } footer: {
            Text(ProxmoxThroughWords.passwordFooter(probe.hostId))
        }
    }

    @ViewBuilder private func compareRows(_ fingerprint: String) -> some View {
        Text("This phone has not approved \(begun?.hostId ?? "that machine") before. On it, fleetwright-sidecar identity "
             + "prints its fingerprint; send the root password only if it is this one.")
            .fleetType(.label)
            .foregroundStyle(Design.Palette.ink)
        Text(fingerprint)
            .fleetType(.labelMono)
            .foregroundStyle(Design.Palette.ink)
            .textSelection(.enabled)
        Button(busy ? "Sending…" : "They match") { Task { await send() } }
            .disabled(busy)
            .frame(minHeight: 44)
        Button("Cancel", role: .cancel) { Task { await abandon() } }
            .disabled(busy)
            .frame(minHeight: 44)
    }

    // MARK: Progress

    private func progressSection(_ job: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text(liveState.map { XOSetupWords.headline($0, purpose: "pve") } ?? XOSetupWords.pveRunning)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(tone(progress?.state))
                    .contentTransition(.opacity)
                if let state = liveState, XOSetupWords.ordinal(state) != nil {
                    let (value, total) = XOSetupWords.bar(state)
                    ProgressView(value: value, total: total)
                        .tint(Design.Palette.active)
                        .animation(Design.Motion.change, value: value)
                    Text(DeployWords.stepLine(step: state.step, of: state.of, fill: state.fill))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .contentTransition(.opacity)
                }
                if !lineKept {
                    Text(ProxmoxThroughWords.mayClose)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                if let text = progress?.text, !text.isBlank {
                    Text(text)
                        .fleetType(.label)
                        .foregroundStyle(running ? Design.Palette.inkDim : Design.Palette.ink)
                        .textSelection(.enabled)
                }
            }
            .animation(Design.Motion.change, value: progress?.phase)
            .animation(Design.Motion.change, value: progress?.state)
            .padding(.vertical, Design.Space.hair)
            if running, !cancelRequested {
                Button("Cancel", role: .destructive) { Task { await cancel(job) } }
                    .disabled(busy)
                    .frame(minHeight: 44)
            } else if running {
                EmptyView()
            } else if progress?.state == "done", lineKept {
                Button("Done") { dismiss() }
                    .frame(minHeight: 44)
            } else if progress?.state == "done", keepAgain, let state = progress {
                Button("Keep the line") { Task { await apply(state) } }
                    .disabled(busy)
                    .frame(minHeight: 44)
            } else {
                // A new begin, because the key was for the job that ended.
                Button("Try again") { reset() }
                    .frame(minHeight: 44)
            }
        } header: {
            sectionHead("On \(hostId)")
        }
    }

    @Environment(\.dismiss) private var dismiss

    private func tone(_ state: String?) -> Color {
        switch state ?? "" {
        case "done": return Design.Palette.ok
        case "failed": return Design.Palette.bad
        case "cancelled": return Design.Palette.inkDim
        default: return Design.Palette.ink
        }
    }

    // MARK: Actions

    @MainActor
    private func probe() async {
        probing = true
        defer { probing = false }
        probes = nil
        chosen = nil
        probeText = ""
        matched = false
        result = ""
        failed = false
        do {
            let reply = try await fleet.xoprobe(address: trimmedAddress)
            guard reply.ok != false else {
                probeText = reply.text ?? "The fleet did not try that address."
                return
            }
            guard let found = reply.probes else {
                probeText = "This fleet did not say which machines tried. Update it, then try again."
                return
            }
            probes = found
            // The first that reached it, when there is a choice to make for
            // the person; any other is one tap away in the list.
            if able.count == 1 || (auto && chosen == nil) { chosen = able.first }
        } catch {
            probeText = error.localizedDescription
        }
    }

    private func choose(_ probe: Fleet.Probe) {
        if chosen?.hostId != probe.hostId { matched = false }
        chosen = probe
        toCompare = nil
        begun = nil
        result = ""
        failed = false
    }

    @MainActor
    private func begin(_ probe: Fleet.Probe) async {
        guard matched, let key = DeployWords.hostKey(probe) else { return }
        busy = true
        defer { busy = false }
        result = ""
        failed = false
        let target = trimmedAddress
        if let stale = begun {
            _ = try? await fleet.cancelSetup(job: stale.job)
            begun = nil
        }
        do {
            let reply = try await fleet.beginPve(address: target, pin: key.sha256, host: probe.hostId)
            guard reply.ok != false, let setup = reply.xosetup, let begunJob = setup.job,
                  let jobKey = setup.key, let keySig = setup.keySig, let hostKey = setup.hostKey
            else {
                refuse(reply.text ?? "\(probe.hostId) did not begin setting up Proxmox VE.")
                return
            }
            let machine = reply.hostId ?? probe.hostId
            // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under this
            // job's own context and over the host key the person compared.
            guard XOSetupKey.isSignedForPve(key: jobKey, keySig: keySig, hostKey: hostKey, address: target, job: begunJob, pin: key.sha256) else {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("The key \(machine) answered with did not come from that machine, so the root password was not sent.")
                return
            }
            begun = Begun(job: begunJob, hostId: machine, address: target, key: jobKey)
            switch await vaultApproval(of: machine, key: hostKey) {
            case .approved:
                await send()
            case .anotherKey:
                _ = try? await fleet.cancelSetup(job: begunJob)
                begun = nil
                refuse("The key \(machine) answered with did not come from that machine: it is not the key this phone approved for it. The root password was not sent.")
            case .none:
                toCompare = PhoneVault.fingerprint(hostKey)
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    private func vaultApproval(of hostId: String, key: Fleet.Host.PublicKey) async -> PhoneVault.Approval {
        guard PhoneGitHub(settings: settings).signedIn,
              let contents = try? await PhoneVault(settings: settings).list(fleet)
        else { return .none }
        return PhoneVault.approval(contents.grants, hostId: hostId, key: key)
    }

    /// The root password and the key the line comes back to, sealed to the
    /// job's key and sent. The password is cleared the moment it is sealed.
    @MainActor
    private func send() async {
        guard let begun else { return }
        busy = true
        defer { busy = false }
        // THE KEY THE LINE COMES BACK TO OUTLIVES THIS SCREEN: kept in the
        // Keychain under the job until the line is in the vault.
        let back = ProxmoxThroughHandoff.newKey(job: begun.job, address: begun.address)
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.pvesetupAAD(job: begun.job, address: begun.address),
                payload: ["v": 1, "purpose": "pve", "root": ["password": rootPassword], "reply": back.publicKey, "vmids": vmids]
            )
        } catch {
            ProxmoxThroughHandoff.forget(job: begun.job)
            refuse(error.localizedDescription)
            return
        }
        rootPassword = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard answer.ok != false else {
                ProxmoxThroughHandoff.forget(job: begun.job)
                refuse(answer.text ?? "\(begun.hostId) did not take the root password.")
                return
            }
            hostId = begun.hostId
            jobAddress = begun.address
            progress = answer.xosetup
            job = begun.job
            self.begun = nil
            XOSetupActivities.start(fleet: fleet, job: begun.job, hostId: begun.hostId, address: begun.address,
                                    progress: answer.xosetup, purpose: "pve",
                                    otherwise: XOSetupAttributes.ContentState(step: 0, of: 0, phase: "node", state: "running", since: Date()))
        } catch {
            ProxmoxThroughHandoff.forget(job: begun.job)
            refuse(error.localizedDescription)
        }
    }

    @MainActor
    private func abandon() async {
        rootPassword = ""
        toCompare = nil
        if let begun { _ = try? await fleet.cancelSetup(job: begun.job) }
        begun = nil
        result = "Nothing was sent."
        failed = false
    }

    @MainActor
    private func cancel(_ job: String) async {
        busy = true
        defer { busy = false }
        do {
            let answer = try await fleet.cancelSetup(job: job)
            if let state = answer.xosetup { await apply(state) }
            if answer.ok == false {
                refuse(answer.text ?? "It could not be stopped.")
            } else {
                cancelRequested = true
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    @MainActor
    private func follow() async {
        guard let job else { return }
        while !Task.isCancelled, running {
            guard (try? await Task.sleep(for: .seconds(3))) != nil else { return }
            guard let answer = try? await fleet.setupStatus(job: job) else { continue }
            if let state = answer.xosetup {
                await apply(state)
            } else if answer.ok == false {
                await apply(Fleet.SetupState(job: job, state: "failed", text: answer.text ?? "The fleet no longer knows this job."))
            }
        }
    }

    /// The state, on the screen and on the Lock Screen; once it is done, the
    /// line opened with the kept key and put in the vault, and the key
    /// dropped. A job that ended otherwise drops its key too.
    @MainActor
    private func apply(_ state: Fleet.SetupState) async {
        progress = state
        guard let job else { return }
        await XOSetupActivities.apply(job: job, progress: state)
        if state.state == "failed" || state.state == "cancelled" { ProxmoxThroughHandoff.forget(job: job) }
        guard state.state == "done", !lineKept else { return }
        busy = true
        defer { busy = false }
        switch await ProxmoxThroughHandoff.collect(job: job, state: state, settings: settings) {
        case let .kept(at):
            lineKept = true
            keepAgain = false
            kept(at)
        case let .failed(text, again):
            keepAgain = again
            refuse(text)
        case nil:
            // BEING COLLECTED from the front of the app this moment: the
            // button asks again. Gone from the list: kept there already.
            if ProxmoxThroughHandoff.pending().contains(where: { $0.job == job }) {
                keepAgain = true
                return
            }
            lineKept = true
            kept(jobAddress)
        }
    }

    private func reset() {
        job = nil
        progress = nil
        begun = nil
        lineKept = false
        keepAgain = false
        cancelRequested = false
        toCompare = nil
        matched = false
        result = ""
        failed = false
    }

    private func refuse(_ text: String) {
        result = text
        failed = true
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// Setting up Proxmox VE through a machine's words, and its one piece of
/// logic that is not drawing: opening the line. Android's ProxmoxThrough
/// says the same.
enum ProxmoxThroughWords {
    static let title = "Through a machine"

    static let intro = "When this phone cannot reach the node, one of your machines that can does the setup for it: "
        + "the same steps, run on the node over SSH. The root password is sealed on this phone to that machine alone."

    /// Said when this phone tried the node and could not reach it.
    static func unreachable(_ node: String) -> String {
        "This phone could not reach \(node), so one of your machines that can sets it up: the same steps, run on the node over SSH. "
            + "The root password is sealed on this phone to that machine alone."
    }

    static let mayClose = "With the machine image this takes several minutes, and you need not watch: the setup goes on on the node, "
        + "and the line comes back sealed to this phone, which keeps it in your vault when Fleetwright is next open."

    static func passwordFooter(_ host: String) -> String {
        "It signs in to the node over SSH once, and \(host) forgets it as soon as it has. "
            + "The line comes back sealed to this phone, and \(host) keeps no copy."
    }

    /// Why no machine is offered when none reached the node's SSH, with what
    /// to check; nil when one did.
    static func nobody(_ probes: [Fleet.Probe], address: String) -> String? {
        if probes.isEmpty {
            return "No permanent machine is connected, so nothing could try \(address). Set it up by hand on the node instead."
        }
        if probes.contains(where: { $0.ssh?.reachable == true }) { return nil }
        let missed = probes.filter { $0.ssh?.reachable == false }.map(\.hostId).sorted()
        let old = probes.filter { $0.ssh == nil }.map(\.hostId).sorted()
        var lines: [String] = []
        if !missed.isEmpty {
            lines.append("No machine reached SSH at \(address). Check the address, that SSH is on for the node, and that one of these "
                         + "is on a network that can reach it: \(missed.joined(separator: ", ")).")
        }
        if !old.isEmpty { lines.append("Too old to look over SSH: \(old.joined(separator: ", ")). Update one, then ask again.") }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }

    /// The line the machine sealed back, or nil for anything that does not
    /// open under this job and node with this key, or is not a line.
    static func open(_ handoff: String, job: String, address: String, key: Seal.OneUseKey) -> ProxmoxLine.Record? {
        let parts = handoff.split(separator: ".").map(String.init)
        guard parts.count == 3,
              let inside = try? Seal.open(key, aad: Seal.pvesetupHandoffAAD(job: job, address: address),
                                          sealed: ["epk": parts[0], "iv": parts[1], "ct": parts[2]]),
              let line = inside["line"] as? String
        else { return nil }
        return ProxmoxLine.parse(line)
    }
}
