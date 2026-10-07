import SwiftUI

/// Install Xen Orchestra on a pool that has none, from one machine already in
/// the fleet, and add the pool with it. docs/hypervisors.md, "A pool without
/// Xen Orchestra"; the machine's half is src/fleet/host/xo-deploy.js.
///
/// Reached from Add a hypervisor, and only when every machine that answered
/// found no Xen Orchestra at the address (C-2). WHAT A PERSON SUPPLIES is the
/// pool master's address, its root password, and the password Xen
/// Orchestra's admin will have instead of the installer's default. The rest
/// is one job on one machine, the same four phases a setup has:
///
///   1. `xoprobe`: every permanent machine that found no Xen Orchestra at the
///      address also says what answered SSH there, its host keys, and whether
///      it has what installing needs. The answer Add a hypervisor already had
///      is where this screen starts, so nothing is asked twice. The person
///      compares the key with what the pool master's own console prints,
///      because the root password only ever goes to a server with that key.
///   2. `xosetup deploy`, pinned to that key's SHA-256: the machine makes a key
///      for this job and signs it under the install's own context. THE KEY
///      IS CHECKED BEFORE ANYTHING IS SEALED TO IT (XOSetupKey.isSignedForDeploy),
///      against the fingerprint this phone's vault approved for the machine, or
///      by the person comparing it with `fleetwright-sidecar identity`.
///   3. `xosetup run`: both passwords sealed to that key under the install's own
///      binding (Seal.xodeployAAD), with a key for the token to come back to,
///      the same as a setup's (XOSetupHandoff). The passwords leave this
///      screen's state the moment they are sealed.
///   4. Progress: polled while this screen is open, and on the Lock Screen and
///      in the Dynamic Island when it is not, because the install is the half
///      hour the person should not have to watch.
///
/// The same Form, rows and single asking card as Add a hypervisor
/// (docs/design-system.md §4): every row is a platform control on the card
/// colour, and the one thing that spends emphasis is the host key question,
/// because it is the screen asking. The step line crossfades, so a change of
/// state reads as one and Reduce Motion is honoured (MOTION 2).
struct DeployXOView: View {
    let settings: Settings
    @Environment(\.dismiss) private var dismiss

    /// `probes` is what Add a hypervisor's probe of this address found, which
    /// already says what answered SSH; asked again only for another address.
    init(settings: Settings, address: String, probes: [Fleet.Probe]? = nil) {
        self.settings = settings
        _address = State(initialValue: address)
        _probes = State(initialValue: probes)
        let able = (probes ?? []).filter { DeployWords.canInstall($0) }
        _chosen = State(initialValue: able.count == 1 ? able.first : nil)
    }

    @State private var address = ""
    @State private var probing = false
    /// What every machine found, or nil until asked.
    @State private var probes: [Fleet.Probe]?
    @State private var probeText = ""
    @State private var chosen: Fleet.Probe?
    /// The person compared the host key with the pool master's own and said
    /// it matches. About one key from one machine: reset when either changes.
    @State private var matched = false
    @State private var rootPassword = ""
    @State private var adminPassword = ""
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
    @State private var handedBack: XOSetupHandoff.Outcome?
    @State private var fleetNote = ""
    /// Where the Xen Orchestra the machine installed answers, read from the
    /// record it handed back once this phone holds it. Nil until then: the
    /// screen never says where it is on the strength of a guess.
    @State private var installedAt: String?

    private struct Begun {
        let job: String
        let hostId: String
        let address: String
        let key: String
        let fingerprint: String
    }

    private var fleet: Fleet { Fleet(settings: settings) }
    private var trimmedAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// The machines that can install from here: reached the SSH server, saw a
    /// host key, and have what installing needs.
    private var able: [Fleet.Probe] { (probes ?? []).filter { DeployWords.canInstall($0) } }
    private var running: Bool {
        guard job != nil else { return false }
        return XOSetupWords.isLive(progress?.state ?? "running")
    }
    private var liveState: XOSetupAttributes.ContentState? { XOSetupActivities.contentState(progress) }

    var body: some View {
        Form {
            whereSection
            if probes != nil { machinesSection }
            if let chosen, job == nil, let key = DeployWords.hostKey(chosen) {
                hostKeySection(chosen, key: key)
                passwordsSection(chosen)
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
        .navigationTitle("Install Xen Orchestra")
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
            Text("Its host name or address, as you would SSH to it as root. Xen Orchestra goes on the pool master’s own network, "
                 + "with an address from DHCP there.")
        }
    }

    // MARK: Which machine

    private var machinesSection: some View {
        Section {
            // SAID PLAINLY, WITH WHAT TO CHECK, whenever no machine reached
            // the SSH server: an empty list under a heading is a screen that
            // has stopped talking.
            if let nobody = DeployWords.nobody(probes ?? [], address: trimmedAddress) {
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
                    // master, and cannot install from there.
                    probeRow(probe)
                }
            }
        } header: {
            sectionHead("Which machine installs it")
        }
    }

    private func probeRow(_ probe: Fleet.Probe) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(probe.hostId)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Text(DeployWords.describe(probe))
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

    /// THE QUESTION THIS SCREEN ASKS. An SSH host key is vouched for by
    /// nobody, so it is always asked about: the key, where on the pool master
    /// to read its own, and a switch the person turns on having compared them.
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

    // MARK: Passwords

    private func passwordsSection(_ probe: Fleet.Probe) -> some View {
        Section {
            SecureField("Root password of the pool master", text: $rootPassword)
                .textContentType(.password)
                .disabled(busy || toCompare != nil)
            SecureField("New password for Xen Orchestra’s admin", text: $adminPassword)
                .textContentType(.newPassword)
                .disabled(busy || toCompare != nil)
            if !adminPassword.isEmpty, !DeployWords.adminPasswordOK(adminPassword) {
                Text(DeployWords.adminPasswordShort)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
            }
            if let toCompare {
                compareRows(toCompare)
            } else {
                Button(busy ? "Beginning…" : "Install on \(probe.hostId)") { Task { await begin(probe) } }
                    .disabled(busy || !matched || rootPassword.isEmpty || !DeployWords.adminPasswordOK(adminPassword))
                    .frame(minHeight: 44)
            }
        } header: {
            sectionHead("Passwords")
        } footer: {
            Text(DeployWords.passwordsFooter(probe.hostId))
        }
    }

    /// The same comparison Add a hypervisor asks for, in the same words.
    @ViewBuilder private func compareRows(_ fingerprint: String) -> some View {
        Text("This phone has not approved \(begun?.hostId ?? "that machine") before. On it, fleetwright-sidecar identity "
             + "prints its fingerprint; send the passwords only if it is this one.")
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
                Text(liveState.map { XOSetupWords.headline($0, purpose: "deploy") } ?? "Starting on \(hostId)")
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
                if let text = progress?.text, !text.isBlank {
                    Text(text)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                switch handedBack {
                case .kept:
                    Text("The token is in this phone’s Keychain now. No machine in the fleet keeps it on disk.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                case .failed(let why):
                    Text(why)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                case nil:
                    EmptyView()
                }
                if let installedAt {
                    Text(DeployWords.signInLine(installedAt))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                }
                if !fleetNote.isBlank {
                    Text(fleetNote)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
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
            let reply = try await fleet.beginDeploy(address: target, pin: key.sha256, host: probe.hostId)
            guard reply.ok != false, let setup = reply.xosetup, let begunJob = setup.job,
                  let jobKey = setup.key, let keySig = setup.keySig, let hostKey = setup.hostKey
            else {
                refuse(reply.text ?? "\(probe.hostId) did not begin the install.")
                return
            }
            let machine = reply.hostId ?? probe.hostId
            // THE KEY IS CHECKED BEFORE ANYTHING IS SEALED TO IT, under the
            // install's own context and over the host key the person
            // compared: a setup's key, or one signed over another pool
            // master's key, does not pass.
            guard XOSetupKey.isSignedForDeploy(key: jobKey, keySig: keySig, hostKey: hostKey, address: target, job: begunJob, pin: key.sha256) else {
                _ = try? await fleet.cancelSetup(job: begunJob)
                refuse("The key \(machine) answered with did not come from that machine, so the passwords were not sent.")
                return
            }
            let fingerprint = PhoneVault.fingerprint(hostKey)
            begun = Begun(job: begunJob, hostId: machine, address: target, key: jobKey, fingerprint: fingerprint)
            let approved = await approvedFingerprint(of: machine)
            if approved == fingerprint {
                await send()
            } else if approved != nil {
                _ = try? await fleet.cancelSetup(job: begunJob)
                begun = nil
                refuse("The key \(machine) answered with did not come from that machine: it is not the key this phone approved for it. The passwords were not sent.")
            } else {
                toCompare = fingerprint
            }
        } catch {
            refuse(error.localizedDescription)
        }
    }

    /// The fingerprint this phone's vault approved for that machine, or nil.
    private func approvedFingerprint(of hostId: String) async -> String? {
        guard PhoneGitHub(settings: settings).signedIn,
              let contents = try? await PhoneVault(settings: settings).list(fleet)
        else { return nil }
        return contents.grants.first { $0.label == hostId }?.fingerprint
    }

    /// Both passwords, sealed to the job's key and sent. They are cleared
    /// from this screen the moment they are sealed, before the send.
    @MainActor
    private func send() async {
        guard let begun else { return }
        busy = true
        defer { busy = false }
        let reply = XOSetupHandoff.newKey(job: begun.job, address: begun.address)
        let sealed: [String: String]
        do {
            sealed = try Seal.seal(
                to: begun.key,
                aad: Seal.xodeployAAD(job: begun.job, address: begun.address),
                payload: [
                    "v": 1,
                    "purpose": "deploy",
                    "root": ["password": rootPassword],
                    "xo": ["password": adminPassword],
                    "reply": reply.publicKey,
                ]
            )
        } catch {
            XOSetupHandoff.forget(job: begun.job)
            refuse(error.localizedDescription)
            return
        }
        rootPassword = ""
        adminPassword = ""
        toCompare = nil
        let joined = "\(sealed["epk"] ?? "").\(sealed["iv"] ?? "").\(sealed["ct"] ?? "")"
        do {
            let answer = try await fleet.runSetup(job: begun.job, sealed: joined)
            guard answer.ok != false else {
                XOSetupHandoff.forget(job: begun.job)
                refuse(answer.text ?? "\(begun.hostId) did not take the passwords.")
                return
            }
            hostId = begun.hostId
            progress = answer.xosetup
            job = begun.job
            self.begun = nil
            XOSetupActivities.start(fleet: fleet, job: begun.job, hostId: begun.hostId, address: begun.address,
                                    progress: answer.xosetup, purpose: "deploy")
        } catch {
            // NOT FORGOTTEN: the send may have arrived, and the key is what
            // the token comes back to. The next launch asks.
            refuse(error.localizedDescription)
        }
    }

    @MainActor
    private func abandon() async {
        rootPassword = ""
        adminPassword = ""
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

    @MainActor
    private func apply(_ state: Fleet.SetupState) async {
        progress = state
        guard let job else { return }
        let (outcome, inFleet) = await XOSetupHandoff.collectAndKeep(job: job, state: state, settings: settings)
        if let outcome { handedBack = outcome }
        if let inFleet { fleetNote = inFleet }
        if outcome == .kept { installedAt = XOSetupHandoff.installedFrom(trimmedAddress) }
        if state.state == "failed" || state.state == "cancelled" { XOSetupHandoff.forget(job: job) }
        await XOSetupActivities.apply(job: job, progress: state)
    }

    private func reset() {
        job = nil
        progress = nil
        begun = nil
        cancelRequested = false
        handedBack = nil
        installedAt = nil
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

/// An install's words, the same on Android (XoDeploy.kt), and what decides
/// which machines are offered.
enum DeployWords {
    /// The shortest admin password the machine takes (MIN_ADMIN_PASSWORD in
    /// src/fleet/host/xo-deploy.js).
    static let minAdminPassword = 12
    static let adminPasswordShort = "At least 12 characters."

    static func adminPasswordOK(_ p: String) -> Bool { p.count >= minAdminPassword && p.count <= 256 }

    /// Reached the SSH server, saw a host key, and can install from there.
    static func canInstall(_ probe: Fleet.Probe) -> Bool {
        probe.ssh?.reachable == true && probe.ssh?.deploy == true && hostKey(probe) != nil
    }

    /// The key to pin: Ed25519 when the server has one, then ECDSA, then RSA.
    static func hostKey(_ probe: Fleet.Probe) -> Fleet.Probe.SSH.Key? {
        let keys = probe.ssh?.keys ?? []
        for type in ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"] {
            if let key = keys.first(where: { $0.type == type && XOSetupKey.isSSHKey($0.fingerprint) && XOSetupKey.isPin($0.sha256) }) { return key }
        }
        return nil
    }

    /// What prints that key's fingerprint on an XCP-ng host.
    static func keygenCommand(_ type: String) -> String {
        switch type {
        case "ssh-ed25519": return "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
        case "ssh-rsa": return "ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub"
        default: return "ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub"
        }
    }

    /// What one machine found over SSH. Nil is cannot tell, said as that
    /// (C-5), and an answer with no `ssh` is a machine too old to have looked.
    static func describe(_ probe: Fleet.Probe) -> String {
        guard let ssh = probe.ssh else { return "Too old to install Xen Orchestra. Update it, then ask again." }
        switch ssh.reachable {
        case true?:
            if ssh.deploy == true, hostKey(probe) != nil { return "Reached its SSH server" }
            let missing = ssh.missing ?? []
            if ssh.deploy == false, !missing.isEmpty {
                return "Reached its SSH server, and has no \(missing.joined(separator: ", ")) to install with"
            }
            return "Reached its SSH server, and cannot tell whether it can install from there"
        case false?:
            return "Could not reach its SSH server"
        case nil:
            return "Cannot tell: it has no ssh-keyscan to look with"
        }
    }

    /// Why no machine is offered when none reached the SSH server, with what
    /// to check; nil when one did, and its row says the rest. Machines too
    /// old to look did not find it unreachable, and are named as that.
    static func nobody(_ probes: [Fleet.Probe], address: String) -> String? {
        if probes.isEmpty {
            return "No permanent machine is connected, so nothing could try \(address). A machine has to be in the fleet to install Xen Orchestra."
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
        if !old.isEmpty { lines.append("Too old to install Xen Orchestra, so they did not look: \(old.joined(separator: ", ")). Update one, then ask again.") }
        return lines.joined(separator: " ")
    }

    static func passwordsFooter(_ host: String) -> String {
        "The root password signs in to the pool master over SSH once, and \(host) forgets it as soon as it has. Xen Orchestra’s admin is "
            + "admin@admin.net, and its default password is replaced with this one before anything else uses it. Both are sealed on "
            + "this phone to a key only \(host) holds."
    }

    /// "Step 4 of 17", and "Step 4 of 17 · 42%" while the download says how far.
    static func stepLine(step: Int, of: Int, fill: Int?) -> String {
        let line = "Step \(min(step + 1, max(of, 1))) of \(max(of, 1))"
        return fill.map { "\(line) · \($0 / 10)%" } ?? line
    }

    static func signInLine(_ address: String) -> String {
        "Sign in to Xen Orchestra at https://\(address) as admin@admin.net with the password you chose."
    }
}
