import CryptoKit
import Foundation

/// Where a hypervisor's token goes once setup has made it: to this phone,
/// and nowhere in the fleet.
///
/// WHY HERE. The machine that ran the setup is only the one that could reach
/// Xen Orchestra when somebody wanted to add it. The first version left the
/// token in a file on that machine, which made it the one thing holding the
/// pool's key: retire or rebuild it and the pool could no longer be managed.
/// Now the phone makes a key for the token to come back to, sends it inside
/// the sealed sign-in (so the coordinator, which relays everything, cannot
/// put a key of its own there), and the machine seals the token to it and
/// keeps nothing (src/fleet/host/xo-setup.js, hand-off). This is the
/// phone-direct model docs/manage.md sets out for managing the pool itself.
///
/// THE KEY OUTLIVES THE SCREEN. A setup takes minutes and the person can
/// close the app for all of them; the Live Activity is how they watch it. So
/// the key's private half is kept in the Keychain under the job until the
/// token has been collected, and every launch collects what is waiting. The
/// machine holds the sealed copy for six hours, after which the key is
/// dropped too, because there is nothing left for it to open.
///
/// THE TOKEN IS KEPT in the Keychain, this device only, under the address,
/// as the record the machine sealed: the address, the pinned certificate (or
/// plain HTTP), the limited user, its resource set and the token.
enum XOSetupHandoff {
    /// How long a job's key is worth keeping: the machine forgets a finished
    /// job after six hours (FINISHED_TTL_MS in xo-setup.js).
    static let keepFor: TimeInterval = 6 * 60 * 60

    private static let pendingKey = "xosetup.pending"
    private static func replyAccount(_ job: String) -> String { "xosetup-reply.\(job)" }
    static func tokenAccount(_ address: String) -> String { "hypervisor.\(address)" }

    /// A job whose token has not been collected yet. Nothing secret: the key
    /// itself is in the Keychain.
    struct Pending: Codable, Equatable {
        let job: String
        let address: String
        let at: Date
    }

    /// What collecting came to, for the screen to say.
    enum Outcome: Equatable {
        case kept
        case failed(String)
    }

    /// A key for one job's token to come back to, kept until it has been used.
    static func newKey(job: String, address: String) -> Seal.OneUseKey {
        let key = Seal.newKey()
        Keychain.set(key.privateKey.rawRepresentation.base64EncodedString(), for: replyAccount(job))
        var all = pending().filter { $0.job != job }
        all.append(Pending(job: job, address: address, at: Date()))
        save(all)
        return key
    }

    /// The job ended without a token, or the token is in: the key goes.
    static func forget(job: String) {
        Keychain.set("", for: replyAccount(job))
        save(pending().filter { $0.job != job })
    }

    /// Open the token a finished job handed back and keep it. Nil when there
    /// is nothing to collect: not this phone's job, or not done yet.
    static func collect(job: String, state: Fleet.SetupState) -> Outcome? {
        guard state.state == "done", let entry = pending().first(where: { $0.job == job }) else { return nil }
        guard let handoff = state.handoff else {
            // DONE AND NOTHING HANDED BACK is a machine older than the
            // hand-off, which kept the token where the first version did.
            forget(job: job)
            return .failed("The machine finished but handed no token back; it is older than this app and kept the token itself. Update it and run the setup again.")
        }
        guard let raw = Keychain.get(replyAccount(job)).flatMap({ Data(base64Encoded: $0) }),
              let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw),
              let text = open(handoff, job: job, address: entry.address, key: Seal.OneUseKey(privateKey: privateKey))
        else {
            forget(job: job)
            return .failed("The token the machine handed back did not open with this phone's key, so it was not kept. Run the setup again to make a new one.")
        }
        Keychain.set(text, for: tokenAccount(entry.address))
        forget(job: job)
        return .kept
    }

    /// The record a machine sealed, as the JSON kept in the Keychain, or nil
    /// for anything that does not open under this job and address with this
    /// key, or opens to something with no token for that address in it.
    static func open(_ handoff: String, job: String, address: String, key: Seal.OneUseKey) -> String? {
        let parts = handoff.split(separator: ".").map(String.init)
        guard parts.count == 3,
              let record = try? Seal.open(key, aad: Seal.xosetupHandoffAAD(job: job, address: address),
                                          sealed: ["epk": parts[0], "iv": parts[1], "ct": parts[2]]),
              (record["token"] as? String)?.isEmpty == false,
              record["address"] as? String == address,
              let json = try? JSONSerialization.data(withJSONObject: record)
        else { return nil }
        return String(data: json, encoding: .utf8)
    }

    /// At launch: every job this phone is still owed a token for is asked
    /// about once. Done is collected, over is dropped, still running is left
    /// for the next launch or the screen.
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
                _ = collect(job: entry.job, state: state)
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
