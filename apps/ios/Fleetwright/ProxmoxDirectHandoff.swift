import Foundation

/// A Proxmox VE setup this phone started on the node itself, followed after
/// its screen has closed: the direct route's half of "the screen may be
/// closed" (ProxmoxThroughHandoff is the machine route's). docs/proxmox.md,
/// "One way in".
///
/// THE SETUP RUNS ON THE NODE, as a unit of its own, whatever the phone
/// does; what needed the screen was reaching the node again to read the line,
/// which takes the root password. So while a run is going, the password is
/// kept in the Keychain, this device only, under the node's address, beside
/// the host key the person checked and the node's clock at the start. It is
/// wiped the moment the line is in the vault, the run fails, or six hours
/// pass. It never leaves this phone: it goes to the node, as it did when the
/// screen held it, and nowhere else.
///
/// A LINE TAKEN AND NOT YET KEPT is held in the Keychain too: taking it
/// removes it from the node, so a vault that did not answer must not lose it.
/// It is kept at the next look.
enum ProxmoxDirectHandoff {
    static let keepFor = XOSetupHandoff.keepFor

    private static let pendingKey = "pvedirect.pending"
    private static func passwordAccount(_ address: String) -> String { "pvedirect-password.\(address)" }
    private static func lineAccount(_ address: String) -> String { "pvedirect-line.\(address)" }

    /// A run this phone is still owed a line from. Nothing secret.
    struct Pending: Codable, Equatable {
        let address: String
        /// The host key the person checked, which every connection holds the node to.
        let fingerprint: String
        /// The node's clock at the start, so its journal is read from this run alone.
        let since: Int
        let at: Date
    }

    enum Outcome: Equatable {
        /// In the vault, under the cluster's address.
        case kept(String)
        /// Over without a line, and why.
        case failed(String)
    }

    @MainActor private static var collecting: Set<String> = []

    /// A run begun: what reaching the node again needs, kept until it ends.
    static func started(address: String, fingerprint: String, since: Int, password: String) {
        Keychain.set(password, for: passwordAccount(address))
        Keychain.set("", for: lineAccount(address))
        var all = pending().filter { $0.address != address }
        all.append(Pending(address: address, fingerprint: fingerprint, since: since, at: Date()))
        save(all)
    }

    /// The run is over, or given up on: the password goes.
    static func forget(address: String) {
        Keychain.set("", for: passwordAccount(address))
        Keychain.set("", for: lineAccount(address))
        save(pending().filter { $0.address != address })
    }

    static func isPending(_ address: String) -> Bool { pending().contains { $0.address == address } }

    /// Every run this phone followed, with the node password each held:
    /// what signing out does (Settings.signOut).
    static func forgetAll() {
        for entry in pending() { forget(address: entry.address) }
        UserDefaults.standard.removeObject(forKey: pendingKey)
    }

    /// One look at the run: how far it has got, and, once it has ended, what
    /// came of it. Nil when this phone follows no run at that address, or
    /// another look is taking its line this moment. Throws when the node did
    /// not answer, which is said and tried again.
    @MainActor
    static func look(_ address: String, settings: Settings) async throws -> (ProxmoxSSH.Progress?, Outcome?)? {
        guard let entry = pending().first(where: { $0.address == address }), !collecting.contains(address) else { return nil }
        collecting.insert(address)
        defer { collecting.remove(address) }
        if let held = Keychain.get(lineAccount(address)), let record = ProxmoxLine.parse(held) {
            return (nil, await keep(record, address: address, settings: settings))
        }
        guard let password = Keychain.get(passwordAccount(address)), !password.isEmpty else {
            forget(address: address)
            return nil
        }
        let (_, out) = try await ProxmoxSSH.run(address, fingerprint: entry.fingerprint, password: password, command: ProxmoxSSH.pollCommand(since: entry.since))
        let progress = ProxmoxSSH.progress(of: out)
        if progress.lineReady {
            let (_, got) = try await ProxmoxSSH.run(address, fingerprint: entry.fingerprint, password: password, command: ProxmoxSSH.takeLine)
            guard let record = ProxmoxLine.parse(got) else {
                forget(address: address)
                return (progress, .failed("The setup finished, and what it left for this phone is not a line it can keep. Run it again; it finds what it made."))
            }
            Keychain.set(got.trimmingCharacters(in: .whitespacesAndNewlines), for: lineAccount(address))
            return (progress, await keep(record, address: address, settings: settings))
        }
        if !progress.running {
            forget(address: address)
            return (progress, .failed(progress.error ?? "The setup stopped without saying why. On the node: journalctl -u \(ProxmoxSSH.unit)"))
        }
        return (progress, nil)
    }

    /// The line in the vault; held for the next look when the vault did not answer.
    @MainActor
    private static func keep(_ record: ProxmoxLine.Record, address: String, settings: Settings) async -> Outcome? {
        do {
            _ = try await PhoneVault(settings: settings).keepHypervisor(Fleet(settings: settings), address: record.address, record: record.json)
            forget(address: address)
            return .kept(record.address)
        } catch {
            return .failed("The node is set up, and its line was not kept yet: \(error.localizedDescription) This phone tries again when Fleetwright is next open.")
        }
    }

    /// When the app comes to the front, and at launch: every run still owed
    /// a line is looked at once.
    @MainActor
    static func collectPending(settings: Settings) async {
        for entry in pending() {
            if Date().timeIntervalSince(entry.at) > keepFor {
                forget(address: entry.address)
                continue
            }
            _ = try? await look(entry.address, settings: settings)
        }
    }

    static func pending() -> [Pending] {
        guard let data = UserDefaults.standard.data(forKey: pendingKey),
              let all = try? JSONDecoder().decode([Pending].self, from: data)
        else { return [] }
        return all
    }

    private static func save(_ all: [Pending]) {
        if all.isEmpty {
            UserDefaults.standard.removeObject(forKey: pendingKey)
        } else if let data = try? JSONEncoder().encode(all) {
            UserDefaults.standard.set(data, forKey: pendingKey)
        }
    }
}
