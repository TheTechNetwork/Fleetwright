import CryptoKit
import Foundation

/// Where a Proxmox VE setup run through a machine hands its line back: to
/// this phone, which keeps it in the person's vault, whether or not the
/// screen that started it is still open.
///
/// ASKED FOR, from a phone held on "Step 7 of 8" for ten minutes: "Why no
/// background processing why do I need to wait there". The first version
/// held the key the line comes back sealed to in the screen's memory, so
/// closing the screen left the node set up with a line nobody could open.
/// Now the key's private half is in the Keychain under the job, as a
/// hypervisor setup's is (XOSetupHandoff), and the line is collected and kept
/// in the vault by whichever comes first: the screen seeing the job end, the
/// app coming to the front, or a launch. The machine holds the sealed copy
/// for six hours (FINISHED_TTL_MS in xo-setup.js), after which the key goes
/// too, because there is nothing left for it to open.
///
/// A KEEP THE VAULT REFUSED IS TRIED AGAIN at the next of those, for as long
/// as the machine holds the copy: the line is the cluster's token, and a
/// network that blinked is no reason to lose it.
enum ProxmoxThroughHandoff {
    static let keepFor = XOSetupHandoff.keepFor

    private static let pendingKey = "pvesetup.pending"
    private static func replyAccount(_ job: String) -> String { "pvesetup-reply.\(job)" }

    /// A job whose line has not been kept yet. Nothing secret: the key itself
    /// is in the Keychain.
    struct Pending: Codable, Equatable {
        let job: String
        let address: String
        let at: Date
    }

    /// What collecting came to, for the screen to say.
    enum Outcome: Equatable {
        /// Kept in the vault, under the cluster's address.
        case kept(String)
        /// Not kept, and why. `again` when it is tried again later.
        case failed(String, again: Bool)
    }

    /// Jobs being collected now, so the screen and a launch do not both keep one.
    @MainActor private static var collecting: Set<String> = []

    /// A key for one job's line to come back to, kept until the line is in.
    static func newKey(job: String, address: String) -> Seal.OneUseKey {
        let key = Seal.newKey()
        Keychain.set(key.privateKey.rawRepresentation.base64EncodedString(), for: replyAccount(job))
        var all = pending().filter { $0.job != job }
        all.append(Pending(job: job, address: address, at: Date()))
        save(all)
        return key
    }

    /// The job ended without a line, or the line is kept: the key goes.
    static func forget(job: String) {
        Keychain.set("", for: replyAccount(job))
        save(pending().filter { $0.job != job })
    }

    /// Open the line a finished job handed back and keep it in the vault.
    /// Nil when there is nothing to collect: not this phone's job, not done
    /// yet, or already being collected.
    @MainActor
    static func collect(job: String, state: Fleet.SetupState, settings: Settings) async -> Outcome? {
        guard state.state == "done", let entry = pending().first(where: { $0.job == job }), !collecting.contains(job) else { return nil }
        collecting.insert(job)
        defer { collecting.remove(job) }
        guard let handoff = state.handoff,
              let raw = Keychain.get(replyAccount(job)).flatMap({ Data(base64Encoded: $0) }),
              let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw),
              let record = ProxmoxThroughWords.open(handoff, job: job, address: entry.address, key: Seal.OneUseKey(privateKey: privateKey))
        else {
            forget(job: job)
            return .failed("The node is set up, and what the machine handed back is not a line this phone can open. Run the setup again; it finds what it made.", again: false)
        }
        do {
            _ = try await PhoneVault(settings: settings).keepHypervisor(Fleet(settings: settings), address: record.address, record: record.json)
            forget(job: job)
            return .kept(record.address)
        } catch {
            return .failed("The node is set up, and its line was not kept yet: \(error.localizedDescription) This phone tries again when Fleetwright is next open.", again: true)
        }
    }

    /// When the app comes to the front, and at launch: every job this phone
    /// is still owed a line for is asked about once. Done is collected, over
    /// is dropped, still running is left for next time or the screen.
    @MainActor
    static func collectPending(fleet: Fleet) async {
        for entry in pending() {
            if Date().timeIntervalSince(entry.at) > keepFor {
                forget(job: entry.job)
                continue
            }
            guard let reply = try? await fleet.setupStatus(job: entry.job) else { continue }
            guard let state = reply.xosetup else {
                // The fleet no longer knows the job, so nothing will come.
                if reply.ok == false { forget(job: entry.job) }
                continue
            }
            if state.state == "done" {
                _ = await collect(job: entry.job, state: state, settings: fleet.settings)
            } else if state.state == "failed" || state.state == "cancelled" {
                forget(job: entry.job)
            }
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
