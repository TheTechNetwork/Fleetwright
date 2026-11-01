import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// A pool's own machine asking to join, from this phone: the secret the
/// phone gives the policy job that makes it, the proof the machine asks with,
/// and the one approval that lets it in and lets it hold its pool. HolderJoin.kt
/// is the same on Android; src/fleet/protocol/holder-join.js is the machine's
/// half and the coordinator's, and test/fixtures/parity/holder-join.json holds
/// all three to one proof.
///
/// ASKED FOR: "Should it ask us for a pin we request it from the app it gets
/// Face ID". The pin a holder was booted with lasted ten minutes, and a first
/// boot that took longer left it outside the fleet for good.
///
/// THE PHONE CHECKS THE PROOF, NOT THE COORDINATOR. The coordinator relays the
/// request and never has the secret, so a coordinator that offered a key of
/// its own under the holder's name has no proof to offer with it. That is the
/// comparison docs/vault.md asks a person to make by eye for an ordinary box,
/// made here, because nobody can run a command on this machine to compare.
///
/// THE SECRETS ARE KEPT ON THIS PHONE ONLY, a few per Xen Orchestra, because
/// one address can have a pool's own machine on each of its pools, and the
/// phone that made a machine LETS IT IN BY ITSELF: the proof is the
/// authorisation, carried from Apply to the request. Asked for: "If I
/// authorize the creation of a holder why do I need to let it in? We can
/// carry the authorization from the creation: if it's the same VM, allow it
/// in." So a secret is kept as the fleet credential and the push key are
/// (after the first unlock, this device only), readable by this app with
/// nobody present, and a request it proves is let in the moment this phone
/// sees it: on Machines, or when the asks-to-join push reaches it.
///
/// WHAT THE OWNER'S FACE GUARDED, and why it is not needed here. It stood
/// between a process running as this app and the approval. That process
/// already holds the fleet credential and the signing key that approve any
/// box's key in the vault with no face (PhoneVault.approve, DeviceSigning),
/// so the face on this one item guarded nothing the rest of the phone did
/// not already give away; what it cost was a second tap for a machine the
/// person had just asked for. The proof is what carries the security: only
/// the machine that read this phone's secret off its own cloud-init drive
/// can make it, the coordinator never has the secret, and the grant it
/// earns is one item, the pool's.
///
/// A SECRET FROM BEFORE is still behind the face (`.userPresence`, the old
/// service), and is read only from a tap, never quietly.
enum HolderJoin {
    /// Secrets this phone reads by itself.
    private static let service = "network.thetech.fleetwright.holder-join.2"
    /// Secrets from before, behind the owner's face: read from a tap only.
    private static let faceService = "network.thetech.fleetwright.holder-join"
    /// How many secrets are kept for one address, newest first.
    static let keptPerAddress = 4

    /// One name the fleet holds for a pool's own machine, and the requests
    /// made under it: GET /api/holders.
    struct Waiting: Decodable, Equatable, Identifiable {
        let hostId: String
        let address: String
        let madeAt: Double
        let until: Double
        let requests: [Request]
        var id: String { hostId }
    }

    struct Request: Decodable, Equatable {
        /// The whole SHA-256 of the key, hex: what the fleet names it by.
        let key: String
        let publicJwk: Fleet.Host.PublicKey
        let proof: String
        let at: Double
    }

    // MARK: The proof

    /// What the proof is a MAC over, exactly as holder-join.js writes it.
    static func message(hostId: String, address: String, keyHash: String) -> String {
        "fleetwright-holder-join/1\n\(hostId)\n\(address)\n\(keyHash)"
    }

    /// The whole SHA-256 of a key over `{"crv","kty","x","y"}` in that order,
    /// hex, the sixteen-character fingerprint's long form (PhoneVault).
    static func keyHash(_ key: Fleet.Host.PublicKey) -> String {
        let canonical = "{\"crv\":\"\(key.crv)\",\"kty\":\"\(key.kty)\",\"x\":\"\(key.x)\",\"y\":\"\(key.y)\"}"
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// HMAC-SHA-256 of the message under the secret, hex; nil for a secret
    /// that is not 64 hex characters.
    static func proof(secret: String, hostId: String, address: String, keyHash: String) -> String? {
        guard let raw = hex(secret), raw.count == 32 else { return nil }
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message(hostId: hostId, address: address, keyHash: keyHash).utf8),
                                                  using: SymmetricKey(data: raw))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    /// The request under this name that one of these secrets proves, made by
    /// the machine this phone made with the key it names, and the secret
    /// that proves it. Nil is none.
    static func proven(_ waiting: Waiting, secrets: [String]) -> (request: Request, secret: String)? {
        for request in waiting.requests where request.key == keyHash(request.publicJwk) {
            if let secret = secrets.first(where: { proof(secret: $0, hostId: waiting.hostId, address: waiting.address, keyHash: request.key) == request.proof }) {
                return (request, secret)
            }
        }
        return nil
    }

    private static func hex(_ s: String) -> Data? {
        guard s.count.isMultiple(of: 2), s.allSatisfy({ $0.isHexDigit }) else { return nil }
        var out = Data()
        var at = s.startIndex
        while at < s.endIndex {
            let next = s.index(at, offsetBy: 2)
            guard let byte = UInt8(s[at..<next], radix: 16) else { return nil }
            out.append(byte)
            at = next
        }
        return out
    }

    // MARK: The secrets

    /// ONE ITEM PER SECRET, named `<address>#<when>`: the names can be listed
    /// without reading, so a new one is added beside the others and the
    /// oldest dropped.
    private static func account(_ address: String, _ at: Int64) -> String { "\(address)#\(at)" }

    private static func accounts(for address: String, in service: String) -> [String] {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess, let rows = out as? [[String: Any]] else { return [] }
        return rows.compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { $0.hasPrefix("\(address)#") }
            .sorted(by: >)
    }

    private static func remove(_ account: String, from service: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }

    /// Whether this phone keeps a secret for `address`: whether it made a
    /// machine there it would let in by itself. Needs no reading.
    static func made(_ address: String) -> Bool {
        !accounts(for: address, in: service).isEmpty || !accounts(for: address, in: faceService).isEmpty
    }

    /// A new secret for a machine about to be made for `address`, kept here
    /// before it is sent, or nil when the Keychain would not keep it, in
    /// which case nothing is sent and the machine joins with its pin.
    ///
    /// AFTER THE FIRST UNLOCK, THIS DEVICE ONLY, and nothing else in front of
    /// it: the push that says the machine asks arrives with the phone in a
    /// pocket, and this is read then (see the top of this file). Not in a
    /// backup, so a restored phone does not let in what another made.
    static func newSecret(for address: String) -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let secret = bytes.map { String(format: "%02x", $0) }.joined()
        for old in accounts(for: address, in: service).dropFirst(keptPerAddress - 1) { remove(old, from: service) }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(address, Int64(Date().timeIntervalSince1970 * 1000)),
            kSecValueData as String: Data(secret.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? secret : nil
    }

    /// One kept secret, the name it is kept under, and where.
    struct Secret: Equatable, Sendable {
        let account: String
        let value: String
        /// Kept behind the owner's face, from before this phone read them by itself.
        var face = false
    }

    /// The secrets this phone reads by itself for `address`: the ones kept
    /// since it let machines in by itself. Empty when it keeps none such.
    static func secrets(for address: String) async -> [Secret] {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        return await read(item as CFDictionary, prefix: "\(address)#", face: false) ?? []
    }

    /// The secrets kept for `address`, for a tap: the ones this phone reads
    /// by itself, and, when it keeps none such, the ones from before behind
    /// the owner's face, which puts Face ID up once with `reason` under it.
    /// Nil when the person cancels or the face does not match; empty when
    /// this phone keeps none for it.
    static func unlock(_ address: String, reason: String) async -> [Secret]? {
        let quiet = await secrets(for: address)
        if !quiet.isEmpty { return quiet }
        guard !accounts(for: address, in: faceService).isEmpty else { return [] }
        let context = LAContext()
        context.localizedReason = reason
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: faceService,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationContext as String: context,
        ]
        return await read(item as CFDictionary, prefix: "\(address)#", face: true)
    }

    /// SecItemCopyMatching may wait for the face, so not on the main actor;
    /// what comes back is unpacked there, into plain strings. Nil is a read
    /// that failed (cancelled, or no match); not found is none.
    private static func read(_ asked: CFDictionary, prefix: String, face: Bool) async -> [Secret]? {
        let (status, found): (OSStatus, [Secret]) = await Task.detached {
            var out: CFTypeRef?
            let status = SecItemCopyMatching(asked, &out)
            let rows = (out as? [[String: Any]]) ?? []
            let found = rows.compactMap { row -> Secret? in
                guard let account = row[kSecAttrAccount as String] as? String, account.hasPrefix(prefix),
                      let data = row[kSecValueData as String] as? Data, let value = String(data: data, encoding: .utf8) else { return nil }
                return Secret(account: account, value: value, face: face)
            }
            return (status, found)
        }.value
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { return nil }
        return found
    }

    /// The one that let a machine in, gone: it proves nothing it should.
    /// By its name, which needs no reading.
    static func spent(_ secret: Secret) {
        remove(secret.account, from: secret.face ? faceService : service)
    }

    // MARK: Letting it in

    /// How letting a machine in ended, in the words the card and a
    /// notification say.
    enum Outcome: Equatable {
        /// In, and holding its pool.
        case joined(String)
        /// In, and the vault would not let it hold the pool: said, with what to do.
        case joinedNotHolding(String)
        /// Said and not let in: this phone did not make it, no request is
        /// proved, or the fleet refused.
        case refused(String)
        /// Nothing to say: the person cancelled the face, or, quietly, the
        /// only secrets are from before and need a tap.
        case nothing

        var said: String? {
            switch self {
            case let .joined(s), let .joinedNotHolding(s), let .refused(s): s
            case .nothing: nil
            }
        }

        var isIn: Bool {
            switch self {
            case .joined, .joinedNotHolding: true
            case .refused, .nothing: false
            }
        }
    }

    /// THE ONE APPROVAL, from a tap or by itself (`quietly`). The request one
    /// of this phone's secrets proves is the one let in: the fleet enrols
    /// that key, and the vault lets the same key hold that pool and nothing
    /// else of this person's. A request none of them proves is said as such
    /// and nothing is let in. Quietly, only the secrets this phone reads by
    /// itself are looked at, so nothing puts a face up from a background.
    static func admit(_ w: Waiting, fleet: Fleet, settings: Settings, quietly: Bool) async -> Outcome {
        guard !w.requests.isEmpty else { return .nothing }
        let found: [Secret]?
        if quietly {
            let quiet = await secrets(for: w.address)
            // Only secrets from before: a tap reads them, this does not.
            if quiet.isEmpty && made(w.address) { return .nothing }
            found = quiet
        } else {
            found = await unlock(w.address, reason: reason(w.hostId, w.address))
        }
        guard let secrets = found else { return .nothing }
        if secrets.isEmpty { return .refused(notThisPhone(w.hostId)) }
        guard let match = proven(w, secrets: secrets.map(\.value)) else { return .refused(notProven(w.hostId)) }
        do {
            let answer = try await fleet.approveHolder(w.hostId, key: match.request.key)
            guard answer.ok == true else { return .refused(answer.text ?? "The fleet did not let \(w.hostId) in.") }
            if let secret = secrets.first(where: { $0.value == match.secret }) { spent(secret) }
            do {
                _ = try await PhoneVault(settings: settings).approveHolder(fleet, hostId: w.hostId, key: match.request.publicJwk, address: w.address)
                return .joined(joined(w.hostId, w.address))
            } catch {
                return .joinedNotHolding(joinedNotHolding(w.hostId, error.localizedDescription))
            }
        } catch {
            return .refused(error.localizedDescription)
        }
    }

    /// By itself, from the push that says a machine asks (FleetwrightApp):
    /// the one waited on under that name, let in when this phone's secret
    /// proves its request. Nil when there is no such name, or nothing to say.
    static func admit(named hostId: String, settings: Settings) async -> Outcome? {
        let fleet = Fleet(settings: settings)
        guard let w = (try? await fleet.holders())?.first(where: { $0.hostId == hostId }) else { return nil }
        let outcome = await admit(w, fleet: fleet, settings: settings, quietly: true)
        return outcome == .nothing ? nil : outcome
    }

    // MARK: What both phones say

    static func asks(_ hostId: String) -> String { "\(hostId) asks to join" }
    static func toHold(_ address: String) -> String {
        "To hold \(address). This phone checks it is the machine you made before it lets it in."
    }
    static func notYet(_ hostId: String) -> String {
        "\(hostId) has not asked to join yet. If it never does, make it again from the pool’s policy."
    }
    static func reason(_ hostId: String, _ address: String) -> String { "Let \(hostId) join and hold \(address)" }
    static func notProven(_ hostId: String) -> String {
        "None of the requests under \(hostId) was made by the machine this phone made, so nothing was let in. "
            + "Decline it, and make the pool’s own machine again if it never asks."
    }
    static func notThisPhone(_ hostId: String) -> String {
        "This phone did not make \(hostId), so it cannot check it. Let it in from the phone that applied the policy, or make it again from this one."
    }
    static func joined(_ hostId: String, _ address: String) -> String { "\(hostId) has joined and holds \(address)." }
    static func joinedNotHolding(_ hostId: String, _ why: String) -> String {
        "\(hostId) has joined, and could not be approved to hold its pool: \(why) Approve it under its page."
    }
    /// Under a name nothing has asked under yet, on the phone that made it.
    static func byItself(_ hostId: String) -> String {
        "This phone made \(hostId), so it lets it in by itself once it asks. Nothing to tap."
    }
    /// The notification, once it is in: the title, and `joined` under it.
    static func joinedTitle(_ hostId: String) -> String { "\(hostId) joined" }
    /// The one action on the asks-to-join notification.
    static let letInWord = "Let it in"
}
