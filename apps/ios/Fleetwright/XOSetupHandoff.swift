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
///
/// WHICH POOLS THIS PHONE HOLDS is a list of addresses beside it, in
/// UserDefaults, because the Keychain cannot be asked "what is under
/// hypervisor.*" without a query of its own and an address is not a secret.
/// It is what Machines lists under Hypervisors. An address counts only while
/// its record is still in the Keychain: a backup restored to another phone
/// brings the list and not the record (this device only), and a list that
/// claimed a pool the phone cannot act on would be a claim with nothing
/// behind it (C-5). Pools added before the list existed are not on it until
/// they are set up again.
enum XOSetupHandoff {
    /// How long a job's key is worth keeping: the machine forgets a finished
    /// job after six hours (FINISHED_TTL_MS in xo-setup.js).
    static let keepFor: TimeInterval = 6 * 60 * 60

    private static let pendingKey = "xosetup.pending"
    private static let heldKey = "hypervisors.held"
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
        collectRecord(job: job, state: state).0
    }

    /// What collecting came to, and the address the record was kept under:
    /// the job's own for a setup, and for an install the address of the Xen
    /// Orchestra the machine installed, which the record names.
    private static func collectRecord(job: String, state: Fleet.SetupState) -> (Outcome?, String?) {
        guard state.state == "done", let entry = pending().first(where: { $0.job == job }) else { return (nil, nil) }
        guard let handoff = state.handoff else {
            // DONE AND NOTHING HANDED BACK is a machine older than the
            // hand-off, which kept the token where the first version did.
            forget(job: job)
            return (.failed("The machine finished but handed no token back; it is older than this app and kept the token itself. Update it and run the setup again."), nil)
        }
        guard let raw = Keychain.get(replyAccount(job)).flatMap({ Data(base64Encoded: $0) }),
              let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw),
              let text = open(handoff, job: job, address: entry.address, key: Seal.OneUseKey(privateKey: privateKey))
        else {
            forget(job: job)
            return (.failed("The token the machine handed back did not open with this phone's key, so it was not kept. Run the setup again to make a new one."), nil)
        }
        let at = recordAddress(text) ?? entry.address
        Keychain.set(text, for: tokenAccount(at))
        remember(at)
        forget(job: job)
        return (.kept, at)
    }

    /// The address a kept record names: where its Xen Orchestra answers.
    private static func recordAddress(_ record: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any],
              let address = object["address"] as? String, XOSetupKey.isAddress(address)
        else { return nil }
        return address
    }

    /// Where the Xen Orchestra an install put on this pool master's pool
    /// answers, from the record this phone keeps for it, or nil when it keeps
    /// none: the screen says where only once the record says so.
    static func installedFrom(_ poolMaster: String) -> String? {
        for address in held() {
            guard let record = Keychain.get(tokenAccount(address)),
                  let object = try? JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any],
                  object["poolMaster"] as? String == poolMaster
            else { continue }
            return address
        }
        return nil
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
              let at = record["address"] as? String,
              // A setup's record names the address the job began with. An
              // install's names the Xen Orchestra it made, and the pool
              // master the job began with beside it.
              at == address || (record["poolMaster"] as? String == address && XOSetupKey.isAddress(at)),
              let json = try? JSONSerialization.data(withJSONObject: record)
        else { return nil }
        return String(data: json, encoding: .utf8)
    }

    /// Collect a finished job's token and, once it is kept, keep it in the
    /// fleet as well, so the boxes this person approved can make machines on
    /// the pool. Answers what collecting came to, and what the fleet said,
    /// or nil for the second when there was nothing to keep.
    static func collectAndKeep(job: String, state: Fleet.SetupState, settings: Settings) async -> (Outcome?, String?) {
        let (outcome, address) = collectRecord(job: job, state: state)
        guard outcome == .kept, let address else { return (outcome, nil) }
        return (outcome, await keepInFleet(settings: settings, address: address))
    }

    /// KEEP IT IN THE FLEET: this phone's record for a pool, put in the
    /// person's vault as `hypervisor:<address>` (PhoneVault.keepHypervisor).
    /// Asked for: "Why not the coordinator hold the token". The fleet holds
    /// it, sealed, and the boxes the person approved are handed it, in
    /// memory only, to make machines on the pool. Answers the sentence to
    /// show: what the fleet said, or what stood in the way.
    static func keepInFleet(settings: Settings, address: String) async -> String {
        guard let record = Keychain.get(tokenAccount(address)), !record.isEmpty else {
            return "This phone holds no token for \(address) to keep in the fleet."
        }
        guard PhoneGitHub(settings: settings).signedIn else {
            return "Sign in to GitHub under You › Credentials to keep its token in the fleet: your vault is kept under your GitHub account."
        }
        do {
            return try await PhoneVault(settings: settings).keepHypervisor(Fleet(settings: settings), address: address, record: record)
        } catch {
            return "Its token was not kept in the fleet: \(error.localizedDescription)"
        }
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
                _ = await collectAndKeep(job: entry.job, state: state, settings: fleet.settings)
            } else if state.state == "failed" || state.state == "cancelled" {
                forget(job: entry.job)
            }
        }
    }

    /// A pool this phone holds a record for, as Machines lists it.
    struct Held: Identifiable, Equatable {
        let address: String
        /// The pool names the machine put in the record, or nil when the
        /// record did not say: nil is "not recorded", never "no pools".
        let pools: [String]?
        var id: String { address }
    }

    /// The pools this phone holds a record for, oldest first, with what each
    /// record says about its pools. Only those whose record is still in the
    /// Keychain.
    static func heldPools() -> [Held] {
        let listed = UserDefaults.standard.stringArray(forKey: heldKey) ?? []
        return listed.compactMap { (address) -> Held? in
            guard let record = Keychain.get(tokenAccount(address)), !record.isEmpty else { return nil }
            return Held(address: address, pools: poolNames(record))
        }
    }

    /// The same, as addresses.
    static func held() -> [String] { heldPools().map(\.address) }

    /// The certificate the machine pinned when this pool was set up, and
    /// whether it checked out then: what the remembered path starts from
    /// when the certificate needed nobody's word (XOSaved). Nil for a pool
    /// with no record here, or one set up over plain HTTP.
    static func pinnedCertificate(_ address: String) -> (pin: String, trusted: Bool)? {
        guard let record = Keychain.get(tokenAccount(address)),
              let object = try? JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any],
              let pin = object["pin"] as? String, !pin.isEmpty
        else { return nil }
        let certificate = object["certificate"] as? [String: Any]
        return (pin, certificate?["trusted"] as? Bool == true)
    }

    /// The pool names in a kept record: each pool's name, or the start of its
    /// id when Xen Orchestra gave it none. Nil for a record that does not say.
    static func poolNames(_ record: String) -> [String]? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any],
              let pools = object["pools"] as? [[String: Any]]
        else { return nil }
        return pools.map { (pool) -> String in
            let name = (pool["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return name.isEmpty ? "Unnamed pool \(String((pool["id"] as? String ?? "").prefix(8)))" : name
        }
    }

    private static func remember(_ address: String) {
        var all = (UserDefaults.standard.stringArray(forKey: heldKey) ?? []).filter { $0 != address }
        all.append(address)
        UserDefaults.standard.set(all, forKey: heldKey)
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
