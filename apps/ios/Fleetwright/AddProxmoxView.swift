import SwiftUI
import UIKit

/// Add a Proxmox VE cluster, from this phone or by hand. docs/proxmox.md,
/// "From the phone" and "By hand". The same screen as Android's
/// ProxmoxSheet, in the same words.
///
/// ONE WAY IN: the node's address and its root password, and Set it up.
/// Asked for: "the route through a machine and main direct route can be
/// combined". The phone tries the node itself first (ProxmoxSSH), so the
/// password goes nowhere but the node: it shows the node's key for the
/// person to check the first time, starts the setup as a unit of its own on
/// the node, and follows it. When the phone cannot reach the node, one of
/// the person's machines that can is asked instead, with the address and
/// password already filled in (ProxmoxThroughMachineView, `auto`), and the
/// password sealed to that machine alone. Either way the screen may close:
/// the line is collected when the app is next open (ProxmoxDirectHandoff,
/// ProxmoxThroughHandoff).
///
/// BY HAND: the same command in the node's own Shell, and the line it prints
/// pasted here. Either way the line is kept in the vault as
/// `hypervisor:<address>`, as a Xen Orchestra pool's token is, and the boxes
/// this person approved pick it up within ten minutes
/// (src/fleet/host/pve-pools.js).
///
struct AddProxmoxView: View {
    let settings: Settings
    /// The node's address when Add a hypervisor found Proxmox VE there.
    var startNode: String = ""
    /// Options to open with, over the remembered ones: the cluster's page
    /// opens this with the firewall on, for Turn on the datacenter firewall.
    var startOptions: ProxmoxOptions? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var line = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var kept = false
    @State private var copied = false

    // FROM THIS PHONE. The password is in this view's state alone.
    @State private var node = ""
    @State private var password = ""
    /// The VM IDs the fleet's image and machines take, FROM-TO, or empty
    /// for the cluster's next free ones. Asked for: "vmid range user
    /// deserves a choice".
    @AppStorage("proxmox-vmids") private var vmids = ""
    /// Every other option, remembered for next time as the numbers are.
    @AppStorage("proxmox-options") private var optionsText = ""
    @State private var options = ProxmoxOptions()
    @State private var optionsOpen = false
    /// The key the node answered with, waiting on the person's word.
    @State private var offered: String?
    /// The key the person checked, which every connection holds the node to.
    @State private var trusted: String?
    @State private var since: Int?
    @State private var progress: ProxmoxSSH.Progress?
    @State private var sshText = ""
    @State private var sshBusy = false
    /// The phone could not reach the node: a machine that can does it.
    @State private var through = false
    @AppStorage("proxmox-host-keys") private var knownKeys = "{}"

    /// What the pasted line carries, or nil while it is not one.
    private var parsed: ProxmoxLine.Record? { ProxmoxLine.parse(line) }
    private var command: String { ProxmoxLine.setupCommand(coordinator: settings.coordinatorURL, vmids: trimmedVmids, options: options) }
    private var trimmedVmids: String { vmids.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "–", with: "-") }
    private var vmidsOk: Bool { trimmedVmids.isEmpty || ProxmoxLine.isVmids(trimmedVmids) }
    private var coordinatorOk: Bool {
        settings.coordinatorURL.range(of: "^https://[A-Za-z0-9.:/_-]+$", options: .regularExpression) != nil
    }
    private var nodeKey: String { node.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var known: [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: Data(knownKeys.utf8))) ?? [:]
    }

    var body: some View {
        Form {
            Section {
                TextField("The node's address", text: $node)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .disabled(since != nil || kept)
                    .onChange(of: node) { _, _ in offered = nil; trusted = nil }
                SecureField("Its root password", text: $password)
                    .disabled(since != nil || kept)
                TextField("VM IDs, such as 9000-9099 (optional)", text: $vmids)
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(since != nil || kept)
                if !vmidsOk {
                    Text("Two numbers from 100 up with a dash between, the first no larger, such as 9000-9099.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                }
                // EVERY OTHER OPTION THE SETUP TAKES. Asked for: "Everything
                // should be in app". Folded away, because the defaults are
                // what most nodes want; each says what it changes.
                DisclosureGroup(isExpanded: $optionsOpen) {
                    Toggle("Turn on the datacenter firewall", isOn: $options.firewall)
                    Text(ProxmoxWords.firewallHint).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    Picker("Machine images", selection: $options.image) {
                        Text("Keep what is there").tag("keep")
                        Text("Build them again").tag("rebuild")
                        Text("Do not build one").tag("none")
                    }
                    if options.image != "none" {
                        ForEach(ProxmoxOptions.systemChoices, id: \.key) { choice in
                            Toggle(choice.name, isOn: Binding(
                                get: { options.builds(choice.key) },
                                set: { options.set(choice.key, builds: $0) }
                            ))
                        }
                        Text(ProxmoxWords.systemsHint).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                    }
                    Picker("Updates for its machines", selection: $options.channel) {
                        Text("Stable").tag("stable")
                        Text("Rolling").tag("rolling")
                    }
                    TextField("Storage (found by itself when empty)", text: $options.storage)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Bridge (vmbr0 when empty)", text: $options.bridge)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Access expires after", selection: $options.expireDays) {
                        ForEach(ProxmoxOptions.lifetimes, id: \.self) { Text("\($0) days").tag($0) }
                    }
                    Stepper("Group networks: \(options.groups)", value: $options.groups, in: 0...4)
                    Stepper("Open labs: \(options.labsOpen)", value: $options.labsOpen, in: 0...4)
                    Stepper("Closed labs: \(options.labsClosed)", value: $options.labsClosed, in: 0...4)
                    if let problem = options.problem {
                        Text(problem).fleetType(.label).foregroundStyle(Design.Palette.bad)
                    }
                } label: {
                    Text("Options").frame(minHeight: 44, alignment: .leading)
                }
                .disabled(since != nil || kept)
                if !coordinatorOk {
                    Text("Can’t set this up from the phone. Use By hand below.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                } else if let waiting = offered {
                    // THE ONE THING TO CHECK, said once and plainly.
                    Text("The node answered with this key. On its console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")
                        .fleetType(.label)
                    Text(waiting).fleetType(.microMono).textSelection(.enabled)
                    Button("It matches") {
                        var k = known
                        k[nodeKey] = waiting
                        if let data = try? JSONEncoder().encode(k), let text = String(data: data, encoding: .utf8) { knownKeys = text }
                        trusted = waiting
                        offered = nil
                        Task { await connectOrStart() }
                    }
                    .frame(minHeight: 44)
                } else if since == nil && !kept && !nodeKey.isEmpty && !password.isEmpty && vmidsOk && options.problem == nil {
                    Button(sshBusy ? "Reaching the node…" : "Set it up") {
                        Task { await connectOrStart() }
                    }
                    .disabled(sshBusy)
                    .frame(minHeight: 44)
                }
                if let progress {
                    ForEach(Array(progress.steps.enumerated()), id: \.offset) { _, step in
                        Text(ProxmoxSSH.stepWords(step)).fleetType(.label)
                    }
                    // HOW FAR INTO THE STEP IT IS ON, when the script says:
                    // the image's download and build are most of the wait.
                    // A bar only for what it measured.
                    if let part = progress.part, progress.running {
                        if let fill = part.fill {
                            ProgressView(value: Double(fill), total: 1000)
                                .tint(Design.Palette.active)
                                .animation(Design.Motion.change, value: fill)
                        }
                        Text(part.text)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .contentTransition(.opacity)
                    }
                    if since != nil {
                        Text("Running on the node. You can close this screen.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                }
                if !sshText.isBlank {
                    Text(sshText)
                        .fleetType(.label)
                        .foregroundStyle(since != nil ? Design.Palette.inkDim : Design.Palette.bad)
                }
            } header: {
                sectionHead("Set it up")
            } footer: {
                // THE RESULT IN ONE SENTENCE. The route (the phone first, a
                // machine when it cannot reach the node) and the password's
                // custody are in the header comment and docs/proxmox.md.
                Text("Needs Proxmox VE 9 or newer. Your password goes only to the node.")
            }

            Section {
                Text(command)
                    .fleetType(.microMono)
                    .textSelection(.enabled)
                Button(copied ? "Copied" : "Copy the command") {
                    UIPasteboard.general.string = command
                    copied = true
                }
                .frame(minHeight: 44)
                TextField("fleetwright-pve:1:…", text: $line, axis: .vertical)
                    .fleetType(.microMono)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(busy || kept)
                if let record = parsed {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(record.address).fleetType(.bodyStrong).monospaced()
                        Text("Pool \(record.pool), \(record.trustWords)")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                } else if !line.isBlank {
                    // SAID AS SOON AS IT IS NOT ONE, so a half-copied line is
                    // found before Add, not after.
                    Text("That is not the whole line the setup printed. It starts with fleetwright-pve:1: and is one long line.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                }
                // DRAWN ONLY WHEN THERE IS A LINE TO KEEP (C-2).
                if let record = parsed, !kept {
                    Button(busy ? "Adding…" : "Add the cluster") { Task { await keep(record) } }
                        .disabled(busy)
                        .frame(minHeight: 44)
                }
            } header: {
                sectionHead("Or by hand, on the node")
            } footer: {
                Text("Run it in Datacenter › node › Shell, then paste what it prints.")
            }

            if !result.isBlank {
                Section {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                        .textSelection(.enabled)
                    if kept { Button("Done") { password = ""; dismiss() }.frame(minHeight: 44) }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Add Proxmox VE")
        // FOLLOWING THE JOB while the screen is open, every three seconds. A
        // poll that fails (the phone slept, the network blinked) is said and
        // retried; the job on the node does not depend on this phone.
        .task(id: since) { await follow() }
        // A RUN THIS PHONE STARTED and has not collected, followed again
        // when the screen is opened.
        .onChange(of: options) { _, now in optionsText = now.saved }
        .task {
            // THE OPTIONS: remembered ones, and over them any this was opened
            // with (the cluster's page asks for the firewall on).
            if options == ProxmoxOptions() {
                options = startOptions ?? ProxmoxOptions.load(optionsText)
                if startOptions != nil { optionsOpen = true }
            }
            // THE ADDRESS ADD A HYPERVISOR FOUND PROXMOX VE AT, filled in.
            if node.isEmpty, !startNode.isEmpty, since == nil { node = startNode }
            guard nodeKey.isEmpty, since == nil, let run = ProxmoxDirectHandoff.pending().first else { return }
            node = run.address
            trusted = run.fingerprint
            since = run.since
        }
        // WHEN THIS PHONE CANNOT REACH THE NODE, one of the person's machines
        // that can does it, with what was typed here already filled in.
        .sheet(isPresented: $through) {
            NavigationStack {
                ProxmoxThroughMachineView(settings: settings, node: nodeKey, password: password, vmids: trimmedVmids, options: options, auto: true) { at in
                    keptThrough(at)
                    through = false
                }
            }
        }
        .onDisappear { password = "" }
    }

    /// PHONE FIRST: the node's key asked for, which is also whether this
    /// phone reaches it at all. A node it cannot reach goes to a machine that
    /// can. A key checked before goes straight on; any other key is shown to
    /// be checked, and nothing is sent until it is.
    @MainActor
    private func connectOrStart() async {
        sshBusy = true
        defer { sshBusy = false }
        sshText = ""
        if trusted == nil {
            let answered: String
            do {
                answered = try await ProxmoxSSH.hostKey(nodeKey)
            } catch {
                guard coordinatorOk else {
                    sshText = "Couldn’t reach \(nodeKey) (\(error.localizedDescription)). Set it up by hand below."
                    return
                }
                through = true
                return
            }
            if known[nodeKey] == answered {
                trusted = answered
            } else {
                if known[nodeKey] != nil { sshText = "The node answered with another key than the one checked before. Check it again before going on." }
                offered = answered
                return
            }
        }
        guard let key = trusted else { return }
        do {
            let (_, clock) = try await ProxmoxSSH.run(nodeKey, fingerprint: key, password: password, command: ProxmoxSSH.now)
            guard let now = Int(clock.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                sshText = "The node did not say what time it is, so its setup could not be followed."
                return
            }
            let (status, out) = try await ProxmoxSSH.run(nodeKey, fingerprint: key, password: password, command: ProxmoxSSH.startCommand(coordinator: settings.coordinatorURL, vmids: trimmedVmids, options: options))
            if status == 0 {
                ProxmoxDirectHandoff.started(address: nodeKey, fingerprint: key, since: now, password: password)
                since = now
            } else {
                sshText = "The node would not start the setup: \(String(out.prefix(300)))"
            }
        } catch {
            sshText = error.localizedDescription
        }
    }

    /// FOLLOWING THE RUN through the same look a launch takes
    /// (ProxmoxDirectHandoff), so the two never both take its line.
    @MainActor
    private func follow() async {
        guard since != nil else { return }
        while since != nil && !kept && !Task.isCancelled {
            do {
                guard let looked = try await ProxmoxDirectHandoff.look(nodeKey, settings: settings) else {
                    // Collected from the front of the app, or no longer followed.
                    if !ProxmoxDirectHandoff.isPending(nodeKey) {
                        since = nil
                        sshText = "No setup running on \(nodeKey)."
                        return
                    }
                    try? await Task.sleep(for: .seconds(3))
                    continue
                }
                let (p, outcome) = looked
                if let p { progress = p }
                sshText = ""
                switch outcome {
                case let .kept(at)?:
                    keptThrough(at)
                    since = nil
                    return
                case let .failed(text)?:
                    sshText = text
                    since = nil
                    return
                case nil:
                    break
                }
            } catch {
                sshText = "Reconnecting…"
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    @MainActor
    private func keep(_ record: ProxmoxLine.Record) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await PhoneVault(settings: settings).keepHypervisor(Fleet(settings: settings), address: record.address, record: record.json)
            // KEPT HERE TOO, for the console in the app (ProxmoxKept).
            ProxmoxKept.keep(record)
            kept = true
            failed = false
            line = ""
            // WHAT HAPPENS NEXT, AND WHEN: saved, not "added", which would be
            // a claim about the cluster nobody has checked yet (C-5).
            result = "Saved. Within 10 minutes it appears under New session › Where, as Proxmox at \(record.address)."
        } catch {
            failed = true
            result = error.localizedDescription
        }
    }

    /// A line a run set up and this phone kept in the vault
    /// (ProxmoxDirectHandoff, ProxmoxThroughHandoff), said here as a line
    /// kept by hand is.
    private func keptThrough(_ address: String) {
        kept = true
        failed = false
        line = ""
        result = "Saved. Within 10 minutes it appears under New session › Where, as Proxmox at \(address)."
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// EVERY OPTION THE SETUP TAKES, as this phone sets them. Asked for:
/// "Everything should be in app". The script's defaults are the defaults
/// here, and only what differs from them is passed, so a run with nothing
/// changed is the run it always was. The bounds and the flags are
/// pve-setup.js's (pveOptionsOf, optionArgs); test/pvesetup-in-apps.test.js
/// holds the three apps' words and flags equal.
/// The options' words, the same on Android (ProxmoxSheet.kt).
enum ProxmoxWords {
    static let systemsHint = "Each system chosen becomes an image a session's machine can be made from. One already on the cluster is kept, and built again only when asked."
    static let firewallHint = "Blocks traffic into the nodes except the web interface, SSH and cluster traffic."
}

struct ProxmoxOptions: Codable, Equatable {
    var firewall = false
    /// "keep" the image there, "rebuild" it, or "none" built at all.
    var image = "keep"
    var channel = "stable"
    var storage = ""
    var bridge = ""
    var expireDays = 365
    var groups = 2
    var labsOpen = 1
    var labsClosed = 1
    /// Which systems the setup builds an image of, by the script's keys
    /// (`--images`, its `pinned` table). Nil is Debian 13 alone, as every
    /// run was before there was a choice, and as options saved then read.
    var systems: [String]? = nil

    /// Every system the setup can build, in its own order: the catalogue
    /// Xen Orchestra pools build from too (src/fleet/host/vm-image.js, IMAGES).
    static let systemChoices: [(key: String, name: String)] = [
        ("debian-13", "Debian 13"),
        ("ubuntu-24.04", "Ubuntu 24.04 LTS"),
        ("ubuntu-26.04", "Ubuntu 26.04 LTS"),
    ]

    var chosenSystems: [String] { systems ?? ["debian-13"] }

    func builds(_ key: String) -> Bool { chosenSystems.contains(key) }

    /// One system on or off, the list kept in the catalogue's order.
    mutating func set(_ key: String, builds on: Bool) {
        let now = Set(chosenSystems).union(on ? [key] : []).subtracting(on ? [] : [key])
        systems = Self.systemChoices.map(\.key).filter(now.contains)
    }

    /// Passed only when it is not Debian 13 alone, and never with no image.
    private var imagesArg: [String]? {
        image == "none" || chosenSystems == ["debian-13"] ? nil : chosenSystems
    }

    static let storagePattern = "^[A-Za-z][A-Za-z0-9_.-]{0,63}$"
    static let bridgePattern = "^[A-Za-z0-9_.-]{1,15}$"
    static let lifetimes = [30, 90, 180, 365, 730]

    private var trimmedStorage: String { storage.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedBridge: String { bridge.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// What is wrong with them, in the script's own words, or nil.
    var problem: String? {
        if !trimmedStorage.isEmpty && trimmedStorage.range(of: Self.storagePattern, options: .regularExpression) == nil {
            return "The storage is not a Proxmox VE storage id, such as local-lvm."
        }
        if !trimmedBridge.isEmpty && trimmedBridge.range(of: Self.bridgePattern, options: .regularExpression) == nil {
            return "The bridge is not a bridge's name, such as vmbr0."
        }
        if labsOpen + labsClosed > 4 { return "Four labs at most, open and closed together." }
        if image != "none" && chosenSystems.isEmpty { return "Choose at least one system to build, or Do not build one." }
        return nil
    }

    /// The flags for the script, each only when it differs from its default.
    var args: String {
        guard problem == nil else { return "" }
        var a = ""
        if firewall { a += " --enable-firewall" }
        if image == "rebuild" { a += " --rebuild-image" }
        if image == "none" { a += " --no-image" }
        if let images = imagesArg { a += " --images \(images.joined(separator: ","))" }
        if channel == "rolling" { a += " --channel rolling" }
        if !trimmedStorage.isEmpty { a += " --storage \(trimmedStorage)" }
        if !trimmedBridge.isEmpty { a += " --bridge \(trimmedBridge)" }
        if expireDays != 365 { a += " --expire-days \(expireDays)" }
        if groups != 2 { a += " --groups \(groups)" }
        if labsOpen != 1 { a += " --labs-open \(labsOpen)" }
        if labsClosed != 1 { a += " --labs-closed \(labsClosed)" }
        return a
    }

    /// The same for the route through a machine, sealed with the password.
    var payload: [String: Any] {
        guard problem == nil else { return [:] }
        var p: [String: Any] = [:]
        if firewall { p["firewall"] = true }
        if image == "rebuild" { p["rebuildImage"] = true }
        if image == "none" { p["noImage"] = true }
        if let images = imagesArg { p["images"] = images }
        if channel == "rolling" { p["channel"] = "rolling" }
        if !trimmedStorage.isEmpty { p["storage"] = trimmedStorage }
        if !trimmedBridge.isEmpty { p["bridge"] = trimmedBridge }
        if expireDays != 365 { p["expireDays"] = expireDays }
        if groups != 2 { p["groups"] = groups }
        if labsOpen != 1 { p["labsOpen"] = labsOpen }
        if labsClosed != 1 { p["labsClosed"] = labsClosed }
        return p
    }

    /// Remembered for the next run, as the machine numbers are.
    static func load(_ text: String) -> ProxmoxOptions {
        (try? JSONDecoder().decode(ProxmoxOptions.self, from: Data(text.utf8))) ?? ProxmoxOptions()
    }

    var saved: String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

/// The line `fleetwright-pve-setup` prints, read the way the boxes read it
/// (src/fleet/host/pve-pools.js, `parseConnection` and `recordOf`), so a line
/// this phone keeps is one they take. test/pve-pools.test.js holds the
/// prefix, the command and the shapes to the JavaScript.
enum ProxmoxLine {
    static let prefix = "fleetwright-pve:1:"
    static let scriptURL = "https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup"
    /// The command for the node, naming this phone's fleet, which a closed
    /// lab answers names for and lets HTTPS reach (docs/proxmox.md, "Labs").
    static func setupCommand(coordinator: String) -> String {
        "curl -fsSLo /root/fleetwright-pve-setup \(scriptURL) && bash /root/fleetwright-pve-setup --coordinator \(coordinator)"
    }

    /// The same, with the range of machine numbers the person gave, when it
    /// is one (`--vmids`, pve-setup.js VMIDS_RE), and every other option.
    static func setupCommand(coordinator: String, vmids: String, options: ProxmoxOptions = ProxmoxOptions()) -> String {
        setupCommand(coordinator: coordinator) + (isVmids(vmids) ? " --vmids \(vmids)" : "") + options.args
    }

    /// FROM-TO, two numbers Proxmox numbers machines with, the first no larger.
    static func isVmids(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, let from = Int(parts[0]), let to = Int(parts[1]),
              parts.allSatisfy({ $0.count >= 3 && $0.count <= 9 && $0.allSatisfy(\.isASCII) && $0.first != "0" })
        else { return false }
        return from >= 100 && from <= to
    }

    struct Record {
        let address: String
        let pool: String
        let trust: String
        /// The record as the line carried it, which is what the vault keeps.
        let json: String

        var trustWords: String {
            trust == "public" ? "trusted by its public certificate" : "trusted by its own CA"
        }
    }

    private static let token = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private static let pool = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,40}$")
    private static let address = try! NSRegularExpression(pattern: "^(?:\\[[0-9A-Fa-f:.]{2,45}\\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\\d{1,5})?$")

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func parse(_ raw: String) -> Record? {
        // A LINE PASTED FROM A TERMINAL may carry spaces or a break where it
        // wrapped; none belongs in it, so none is kept.
        let s = raw.components(separatedBy: .whitespacesAndNewlines).joined()
        guard s.hasPrefix(prefix) else { return nil }
        var b64 = String(s.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["kind"] as? String == "proxmox",
              let address = object["address"] as? String, matches(Self.address, address),
              let token = object["token"] as? String, matches(Self.token, token),
              let pool = object["pool"] as? String, matches(Self.pool, pool),
              let json = String(data: data, encoding: .utf8)
        else { return nil }
        // HOW TO TRUST THE CLUSTER, or no record: a CA, or a public certificate.
        let ca = (object["ca"] as? String) ?? ""
        let trust: String
        if ca.hasPrefix("-----BEGIN CERTIFICATE-----") { trust = "ca" }
        else if object["trust"] as? String == "public" { trust = "public" }
        else { return nil }
        return Record(address: address, pool: pool, trust: trust, json: json)
    }
}
