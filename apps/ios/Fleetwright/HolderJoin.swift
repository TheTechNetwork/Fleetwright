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
/// THE SECRETS ARE KEPT behind the phone's owner (`.userPresence`: Face ID,
/// Touch ID, or the passcode), on this phone only, a few per Xen Orchestra,
/// because one address can have a pool's own machine on each of its pools.
/// Reading them is the Face ID of the approval: the proof cannot be checked
/// until the person has shown it is them.
enum HolderJoin {
    private static let service = "network.thetech.fleetwright.holder-join"
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
    /// without the face, so a new one is added beside the others and the
    /// oldest dropped, and one Face ID reads all of an address's at once.
    private static func account(_ address: String, _ at: Int64) -> String { "\(address)#\(at)" }

    private static func accounts(for address: String) -> [String] {
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

    private static func remove(_ account: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }

    /// A new secret for a machine about to be made for `address`, kept here
    /// before it is sent, or nil when the Keychain would not keep it, in
    /// which case nothing is sent and the machine joins with its pin.
    /// Writing needs no face; reading does.
    static func newSecret(for address: String) -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess,
              let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, nil)
        else { return nil }
        let secret = bytes.map { String(format: "%02x", $0) }.joined()
        for old in accounts(for: address).dropFirst(keptPerAddress - 1) { remove(old) }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(address, Int64(Date().timeIntervalSince1970 * 1000)),
            kSecValueData as String: Data(secret.utf8),
            kSecAttrAccessControl as String: access,
        ]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? secret : nil
    }

    /// One kept secret and the name it is kept under.
    struct Secret: Equatable, Sendable {
        let account: String
        let value: String
    }

    /// The secrets kept for `address`, which puts Face ID up once with
    /// `reason` under it. Nil when the person cancels or the face does not
    /// match; empty when this phone keeps none for it.
    static func unlock(_ address: String, reason: String) async -> [Secret]? {
        guard !accounts(for: address).isEmpty else { return [] }
        let context = LAContext()
        context.localizedReason = reason
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationContext as String: context,
        ]
        let asked = item as CFDictionary
        let prefix = "\(address)#"
        // SecItemCopyMatching waits for the face, so not on the main actor;
        // what comes back is unpacked there, into plain strings.
        let (status, found): (OSStatus, [Secret]) = await Task.detached {
            var out: CFTypeRef?
            let status = SecItemCopyMatching(asked, &out)
            let rows = (out as? [[String: Any]]) ?? []
            let found = rows.compactMap { row -> Secret? in
                guard let account = row[kSecAttrAccount as String] as? String, account.hasPrefix(prefix),
                      let data = row[kSecValueData as String] as? Data, let value = String(data: data, encoding: .utf8) else { return nil }
                return Secret(account: account, value: value)
            }
            return (status, found)
        }.value
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { return nil }
        return found
    }

    /// The one that let a machine in, gone: it proves nothing it should.
    /// By its name, which needs no face.
    static func spent(_ secret: Secret) {
        remove(secret.account)
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
}
