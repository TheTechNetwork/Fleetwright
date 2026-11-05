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
    private var command: String { ProxmoxLine.setupCommand(coordinator: settings.coordinatorURL, vmids: trimmedVmids) }
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
                TextField("Machine numbers, such as 9000-9099 (optional)", text: $vmids)
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(since != nil || kept)
                if !vmidsOk {
                    Text("Two numbers from 100 up with a dash between, the first no larger, such as 9000-9099.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                }
                if !coordinatorOk {
                    Text("This phone's fleet address is not one the setup can be told, so set it up by hand below.")
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
                } else if since == nil && !kept && !nodeKey.isEmpty && !password.isEmpty && vmidsOk {
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
                        Text("Running on the node, and you need not watch: it carries on if this screen closes, and this phone keeps its line in your vault when Fleetwright is next open.")
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
                Text("Proxmox VE 9 or newer. This phone tries the node itself first, and the password goes to the node and nowhere else; it is kept on this phone only while the setup runs. When this phone cannot reach the node, one of your machines that can sets it up, with the password sealed to it alone. Machine numbers are the VM IDs the fleet's image and machines take; left empty, they take the cluster's next free ones.")
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
                Text("In Proxmox's web interface: Datacenter › the node › Shell. It makes a pool, a user with no password, its token, a firewall group, the lab and group networks and the machine image, which takes a few minutes, and prints one line. The line is the cluster's token, kept in your vault and handed only to the machines you approved.")
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
        .task {
            guard nodeKey.isEmpty, since == nil, let run = ProxmoxDirectHandoff.pending().first else { return }
            node = run.address
            trusted = run.fingerprint
            since = run.since
        }
        // WHEN THIS PHONE CANNOT REACH THE NODE, one of the person's machines
        // that can does it, with what was typed here already filled in.
        .sheet(isPresented: $through) {
            NavigationStack {
                ProxmoxThroughMachineView(settings: settings, node: nodeKey, password: password, vmids: trimmedVmids, auto: true) { at in
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
                    sshText = "This phone could not reach \(nodeKey) (\(error.localizedDescription)), and its fleet address is not one a machine can be told. Set it up by hand below."
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
            let (status, out) = try await ProxmoxSSH.run(nodeKey, fingerprint: key, password: password, command: ProxmoxSSH.startCommand(coordinator: settings.coordinatorURL, vmids: trimmedVmids))
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
                        sshText = "This phone follows no setup on \(nodeKey) now. If it finished, its line is in your vault."
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
                sshText = "Lost the node for a moment (\(error.localizedDescription)); asking again."
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
            kept = true
            failed = false
            line = ""
            // WHAT HAPPENS NEXT, AND WHEN: not "added", which would be a claim
            // about the cluster nobody has checked yet (C-5).
            result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; it then shows under New session › Where, as Proxmox at \(record.address)."
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
        result = "Kept in your vault. Your machines pick it up within ten minutes and check it against the cluster; it then shows under New session › Where, as Proxmox at \(address)."
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
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
    /// is one (`--vmids`, pve-setup.js VMIDS_RE).
    static func setupCommand(coordinator: String, vmids: String) -> String {
        setupCommand(coordinator: coordinator) + (isVmids(vmids) ? " --vmids \(vmids)" : "")
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
