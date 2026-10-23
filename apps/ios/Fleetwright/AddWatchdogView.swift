import SwiftUI

/// Add Fleetwright's reconnect watchdog to a Xen Orchestra that predates it,
/// through the pool master that runs its VM. docs/hypervisors.md, "When Xen
/// Orchestra loses a pool"; the machine's half is src/fleet/host/xo-watchdog.js.
///
/// WHY THROUGH THE POOL MASTER. Xen Orchestra's API can load a plugin and
/// cannot install one, and one Fleetwright installed has no login anybody
/// holds. What reaches inside it is the pool master that runs its VM, with
/// the root password, so this is an install's first half asked for a second
/// reason: the pool master's address, a machine in the fleet that reaches it
/// over SSH, its host key compared, and its root password, sealed to one job
/// on that machine.
///
///   1. `xoprobe` of the pool master's address, whose answer says what
///      answered SSH there and with which host keys; the machines offered are
///      the ones an install would offer (DeployWords.canInstall), because the
///      job reaches the pool master with the same tools.
///   2. `xosetup watchdog`, pinned to that key's SHA-256. The job's key is
///      checked before anything is sealed to it, under the watchdog's own
///      context (XOSetupKey.isSignedForWatchdog), so an install's key cannot
///      be handed this root password, nor this job's key an install's.
///   3. `xosetup run`: the root password and the address this pool's Xen
///      Orchestra answers on, as this phone has it saved, sealed under the
///      watchdog's own binding (Seal.xowatchdogAAD). Nothing comes back, so
///      there is no reply key. The password leaves this screen's state the
///      moment it is sealed.
///   4. Progress: polled while this screen is open, and on the Lock Screen as
///      a watchdog, because Xen Orchestra is down for those minutes and the
///      person will want to know when it is back. The machine's last sentence
///      is the result, and says whether Xen Orchestra's VM was started again.
///
/// The same Form, rows and single asking card as the install it is modelled
/// on (DeployXOView, docs/design-system.md §4). The one thing that spends
/// emphasis is the host key question, because it is the screen asking; the
/// sentence that says Xen Orchestra goes down is plain ink, because it is
/// what will happen, not a warning about something that might.
struct AddWatchdogView: View {
    let settings: Settings
    /// Where this pool's Xen Orchestra answers, as this phone has it saved:
    /// what the machine finds its VM by.
    let xoAddress: String
    @Environment(\.dismiss) private var dismiss

    /// The pool master is filled in when this phone's record for the pool
    /// names one, which an install's does; otherwise the person types it.
    init(settings: Settings, xoAddress: String) {
        self.settings = settings
        self.xoAddress = xoAddress
        let master = XOSetupHandoff.poolMaster(of: xoAddress)
        _address = State(initialValue: master ?? "")
        _prefilled = State(initialValue: master != nil)
    }

    @State private var address = ""
    @State private var prefilled = false
    @State private var probing = false
    /// What every machine found, or nil until asked.
    @State private var probes: [Fleet.Probe]?
    @State private var probeText = ""
    @State private var chosen: Fleet.Probe?
    /// The person compared the host key with the pool master's own and said
    /// it matches. About one key from one machine: reset when either changes.
    @State private var matched = false
    @State private var rootPassword = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var begun: Begun?
    /// The fingerprint the person is asked to compare, when the vault has not
    /// vouched for the machine.
    @State private var toCompare: String?
    @State private var job: String?
    @State private var hostId = ""
    @State private var progress: Fleet.SetupState?
    @State private var cancelRequested = false

    private struct Begun {
        let job: String
        let hostId: String
        let address: String
        let key: String
        let fingerprint: String
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
                Text(WatchdogWords.intro)
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
        .navigationTitle(WatchdogWords.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: job) { await follow() }
    }

    // MARK: The pool master

    private var whereSection: some View {
        Section {
            TextField("Address of the pool master", text: $address)
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
            sectionHead("The pool master")
        } footer: {
            Text(WatchdogWords.whereFooter(prefilled: prefilled))
        }
    }

    // MARK: Which machine

    private var machinesSection: some View {
        Section {
            if let nobody = WatchdogWords.nobody(probes ?? [], address: trimmedAddress) {
                Text(nobody)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
            }
            ForEach(probes ?? []) { probe in
                if DeployWords.canInstall(probe) {
                    Button { choose(probe) } label: { probeRow(probe) }
                        .disabled(job != nil)
                } else if probe.ssh?.reachable == true {
                    // Said, and not offered (C-2): it reached the pool
                    // master, and cannot do this from there.
                    probeRow(probe)
                }
            }
        } header: {
            sectionHead("Which machine adds it")
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

    /// THE QUESTION THIS SCREEN ASKS, in an install's words: an SSH host key
    /// is vouched for by nobody, so it is always asked about.
    private func hostKeySection(_ probe: Fleet.Probe, key: Fleet.Probe.SSH.Key) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text("Check this key on the pool master")
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.attention)
                Text("On the pool master’s console, open Local Command Shell and run:")
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
                Text("It matches the pool master’s")
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

    // MARK: The root password, and what happens

    private func passwordSection(_ probe: Fleet.Probe) -> some View {
        Section {
            SecureField("Root password of the pool master", text: $rootPassword)
                .textContentType(.password)
                .disabled(busy || toCompare != nil)
            // WHAT WILL HAPPEN, said before the button rather than after it:
            // Xen Orchestra goes down for those minutes, and the person
            // should choose when.
            Text(WatchdogWords.whatHappens(xoAddress))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
            if let toCompare {
                compareRows(toCompare)
            } else {
                Button(busy ? "Beginning…" : WatchdogWords.addFrom(probe.hostId)) { Task { await begin(probe) } }
                    .disabled(busy || !matched || rootPassword.isEmpty || !XOSetupKey.isAddress(xoAddress))
                    .frame(minHeight: 44)
            }
        } header: {
            sectionHead("Root password")
        } footer: {
            Text(WatchdogWords.passwordFooter(probe.hostId))
        }
    }

    /// The same comparison an install asks for, in the same words.
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
                Text(liveState.map { XOSetupWords.headline($0, purpose: "watchdog") } ?? XOSetupWords.watchdogRunning)
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
                // THE MACHINE'S SENTENCE. While it runs, the step; once it
                // has ended, the result, which says whether Xen Orchestra's
                // VM was started again, so it is read at full weight.
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
            } else if progress?.state == "done" {
                Button("Done") { dismiss() }
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
            // One machine that can is not a choice, so it is chosen.
            if able.count == 1 { chosen = able.first }
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
            // A host older than the phase answers `host_outdated`, and its
            // words are what is shown.
            let reply = try await fleet.beginWatchdog(address: target, pin: key.sha256, host: probe.hostId)
            guard reply.ok != false, let setup = reply.xosetup, let begunJob = setup.job,
                  let jobKey = setup.key, let keySig = setup.keySig, let hostKey = setup.hostKey
            else {
                refuse(reply.text ?? "\(probe.hostId) did not begin adding the watchdog.")
                return
            }
            let machine = reply.hostId ?? probe.hostId
            // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under the
            // watchdog's own context and over the host key the person
            // compared: an install's key, or one signed over another pool
            // master's key, does not pass.
            guard XOSetupKey.isSignedForWatchdog(key: jobKey, keySig: keySig, hostKey: hostKey, address: target, job: begunJob, pin: key.sha256) else {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("The key \(machine) answered with did not come from that machine, so the root password was not sent.")
                return
            }
            let fingerprint = PhoneVault.fingerprint(hostKey)
            begun = Begun(job: begunJob, hostId: machine, address: target, key: jobKey, fingerprint: fingerprint)
            switch await vaultApproval(of: machine, key: hostKey) {
            case .approved:
                await send()
            case .anotherKey:
                _ = try? await fleet.cancelSetup(job: begunJob)
                begun = nil
                refuse("The key \(machine) answered with did not come from that machine: it is not the key this phone approved for it. The root password was not sent.")
            case .none:
                toCompare = fingerprint
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    /// What this phone's vault says about the key that machine answered
    /// with, or `.none` when it cannot ask, as an install asks it
    /// (PhoneVault.approval).
    private func vaultApproval(of hostId: String, key: Fleet.Host.PublicKey) async -> PhoneVault.Approval {
        guard PhoneGitHub(settings: settings).signedIn,
              let contents = try? await PhoneVault(settings: settings).list(fleet)
        else { return .none }
        return PhoneVault.approval(contents.grants, hostId: hostId, key: key)
    }

    /// The root password and where Xen Orchestra answers, sealed to the
    /// job's key and sent. The password is cleared from this screen the
    /// moment it is sealed, before the send.
    @MainActor
    private func send() async {
        guard let begun else { return }
        busy = true
        defer { busy = false }
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.xowatchdogAAD(job: begun.job, address: begun.address),
                payload: [
                    "v": 1,
                    "purpose": "watchdog",
                    "root": ["password": rootPassword],
                    "xo": ["address": xoAddress],
                ]
            )
        } catch {
            refuse(error.localizedDescription)
            return
        }
        rootPassword = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard answer.ok != false else {
                refuse(answer.text ?? "\(begun.hostId) did not take the root password.")
                return
            }
            hostId = begun.hostId
            progress = answer.xosetup
            job = begun.job
            self.begun = nil
            XOSetupActivities.start(fleet: fleet, job: begun.job, hostId: begun.hostId, address: begun.address,
                                    progress: answer.xosetup, purpose: "watchdog",
                                    otherwise: XOSetupAttributes.ContentState(step: 0, of: 0, phase: "reach", state: "running", since: Date()))
        } catch {
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
            let reply = try await fleet.cancelSetup(job: job)
            if let state = reply.xosetup { await apply(state) }
            if reply.ok == false {
                refuse(reply.text ?? "It could not be stopped.")
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
            guard let reply = try? await fleet.setupStatus(job: job) else { continue }
            if let state = reply.xosetup {
                await apply(state)
            } else if reply.ok == false {
                await apply(Fleet.SetupState(job: job, state: "failed", text: reply.text ?? "The fleet no longer knows this job."))
            }
        }
    }

    /// Nothing is handed back to a watchdog's job, so there is nothing to
    /// collect: the state, on the screen and on the Lock Screen.
    @MainActor
    private func apply(_ state: Fleet.SetupState) async {
        progress = state
        guard let job else { return }
        await XOSetupActivities.apply(job: job, progress: state)
    }

    private func reset() {
        job = nil
        progress = nil
        begun = nil
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

/// Adding the watchdog's words. iOS only for now: Android has no screen for
/// it yet (docs/app-parity.md).
enum WatchdogWords {
    /// The row on the pool's page, and this screen's title.
    static let title = "Add the reconnect watchdog"

    static let intro = "Fleetwright’s reconnect watchdog runs inside Xen Orchestra and reconnects a pool it loses by itself. "
        + "A Xen Orchestra installed before it, or not by Fleetwright, may not have it. It goes in through the pool master "
        + "that runs Xen Orchestra’s VM."

    static func whereFooter(prefilled: Bool) -> String {
        let how = "Its host name or address, as you would SSH to it as root: the pool master of the pool Xen Orchestra’s VM runs in."
        return prefilled ? "\(how) Filled in from when Fleetwright installed this Xen Orchestra." : how
    }

    /// What will happen, in the order it happens, and what it costs.
    static func whatHappens(_ xo: String) -> String {
        "Xen Orchestra’s VM, the one answering at \(xo), is shut down for a minute or two while the watchdog is put on its disk, "
            + "then started again. Xen Orchestra is unavailable meanwhile, and so is this pool’s page."
    }

    static func addFrom(_ host: String) -> String { "Add it from \(host)" }

    static func passwordFooter(_ host: String) -> String {
        "The root password signs in to the pool master over SSH once, and \(host) forgets it as soon as it has. "
            + "It is sealed on this phone to a key only \(host) holds."
    }

    /// What one machine found over SSH. Nil is cannot tell, said as that
    /// (C-5), and an answer with no `ssh` is a machine too old to have looked.
    static func describe(_ probe: Fleet.Probe) -> String {
        guard let ssh = probe.ssh else { return "Too old to reach a pool master over SSH. Update it, then ask again." }
        switch ssh.reachable {
        case true?:
            if DeployWords.canInstall(probe) { return "Reached its SSH server" }
            let missing = ssh.missing ?? []
            if ssh.deploy == false, !missing.isEmpty {
                return "Reached its SSH server, and has no \(missing.joined(separator: ", ")) to work there with"
            }
            return "Reached its SSH server, and cannot tell whether it can work there"
        case false?:
            return "Could not reach its SSH server"
        case nil:
            return "Cannot tell: it has no ssh-keyscan to look with"
        }
    }

    /// Why no machine is offered when none reached the SSH server, with what
    /// to check; nil when one did, and its row says the rest.
    static func nobody(_ probes: [Fleet.Probe], address: String) -> String? {
        if probes.isEmpty {
            return "No permanent machine is connected, so nothing could try \(address). A machine in the fleet adds the watchdog."
        }
        if probes.contains(where: { $0.ssh?.reachable == true }) { return nil }
        let missed = probes.filter { $0.ssh?.reachable == false }.map(\.hostId).sorted()
        let unsure = probes.filter { $0.ssh != nil && $0.ssh?.reachable == nil }.map(\.hostId).sorted()
        let old = probes.filter { $0.ssh == nil }.map(\.hostId).sorted()
        var lines: [String] = []
        if !missed.isEmpty {
            lines.append("No machine reached SSH at \(address). Check the address, that SSH is on for the pool master, and that one of these "
                         + "is on a network that can reach it: \(missed.joined(separator: ", ")).")
        }
        if !unsure.isEmpty { lines.append("Cannot tell from \(unsure.joined(separator: ", ")), which has no ssh-keyscan to look with.") }
        if !old.isEmpty { lines.append("Too old to look over SSH: \(old.joined(separator: ", ")). Update one, then ask again.") }
        return lines.joined(separator: " ")
    }
}
