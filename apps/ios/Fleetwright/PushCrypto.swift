import CryptoKit
import Foundation
import Security

/// The other half of `src/fleet/push-crypto.js`.
///
/// A notification is sealed on the coordinator to a key this phone holds, so
/// Apple and Google forward bytes they cannot read. This opens one. The
/// construction is the one in `docs/push-encryption.md`: ECDH on P-256, one
/// HKDF-SHA-256 expand of 44 bytes split into an AES-256 key and a 12-byte
/// nonce, AES-GCM with no additional data. `test/fixtures/parity/push-envelope.json`
/// is one envelope the JavaScript sealed; `PushCryptoTests` opens it, and so
/// does `PushCryptoTest.kt`.
///
/// THE PRIVATE KEY STAYS IN THE KEYCHAIN. It is not in the Secure Enclave,
/// because an enclave key cannot be agreed with from an extension that has to
/// run while the phone is locked, and the design's store for it is the
/// keychain (`docs/push-encryption.md`, "the key belongs to the install").
/// `AfterFirstUnlockThisDeviceOnly` is the same choice the credential store
/// makes: a notification can be opened on the lock screen, and a backup does
/// not carry the key.
enum PushCrypto {
    static let version: UInt8 = 1
    private static let infoPrefix = Data("fleetwright-push-v1".utf8)

    struct Opened {
        let title: String
        let body: String
        let data: [String: String]
    }

    enum Failure: Error {
        case envelope
        case version(UInt8)
    }

    /// Open one envelope.
    ///
    /// `recipientPublic` is the uncompressed point this phone registered. It
    /// goes into the KDF info with the ephemeral point, which is what binds
    /// the ciphertext to the pair it was made for.
    static func open(privateKey: P256.KeyAgreement.PrivateKey, recipientPublic: Data, envelope: String) throws -> Opened {
        guard let bytes = unb64(envelope), bytes.count >= 1 + 16 + 65 + 16 else { throw Failure.envelope }
        guard bytes[0] == version else { throw Failure.version(bytes[0]) }
        let salt = bytes.subdata(in: 1 ..< 17)
        let ephemeralRaw = bytes.subdata(in: 17 ..< 82)
        let sealed = bytes.subdata(in: 82 ..< bytes.count)
        guard ephemeralRaw.first == 0x04, sealed.count > 16 else { throw Failure.envelope }

        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
        var info = Data()
        info.append(infoPrefix)
        info.append(recipientPublic)
        info.append(ephemeralRaw)
        // ONE EXPAND, then split. Two derivations would not be the scheme the
        // coordinator uses, and the nonce only has to be unique per key.
        let okm = shared
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 44)
            .withUnsafeBytes { Data($0) }
        guard okm.count == 44 else { throw Failure.envelope }
        let key = SymmetricKey(data: okm.prefix(32))
        let nonce = try AES.GCM.Nonce(data: okm.suffix(12))
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        let clear = try AES.GCM.open(box, using: key)
        guard
            let obj = try JSONSerialization.jsonObject(with: clear) as? [String: Any],
            let title = obj["title"] as? String,
            let body = obj["body"] as? String
        else { throw Failure.envelope }

        var data: [String: String] = [:]
        if let raw = obj["data"] as? [String: Any] {
            for (key, value) in raw {
                if let text = value as? String {
                    data[key] = text
                } else if let number = value as? NSNumber {
                    data[key] = number.stringValue
                }
            }
        }
        return Opened(title: title, body: body, data: data)
    }

    /// What a tap reads, once the envelope is open.
    ///
    /// The ciphertext is dropped. Everything else that arrived in the clear
    /// stays — the category is how iOS knows which buttons to draw, and it is
    /// not inside the envelope — and the sealed fields are written over it.
    /// `sentAt` is one of those fields, which is what lets an answer older
    /// than an hour be refused by the check that already does that.
    static func merged(userInfo: [AnyHashable: Any], opened: Opened) -> [String: Any] {
        var info: [String: Any] = [:]
        for (key, value) in userInfo {
            guard let key = key as? String, key != "e" else { continue }
            info[key] = value
        }
        for (key, value) in opened.data {
            info[key] = value
        }
        return info
    }

    static func unb64(_ value: String) -> Data? {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = (4 - (text.count % 4)) % 4
        text += String(repeating: "=", count: pad)
        return Data(base64Encoded: text)
    }

    static func b64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// The install's push key, and the one place that reads it back.
///
/// THE EXTENSION DOES NOT MINT ONE. A key it made would live in its own
/// keychain group, and the app would register a different public key. The app
/// writes this on registration. The extension reads it from the app's default
/// group, which is the app's id prefixed by the team — the group an item lands
/// in when the app names no group, and the app names no group so its
/// entitlements stay the ones the existing distribution profile signs.
enum PushKey {
    private static let service = "network.thetech.fleetwright"
    private static let account = "push-key"
    private static let appBundle = "network.thetech.fleetwright"

    /// base64url of the uncompressed public point, or nil when the keychain
    /// will not keep one. Registration then sends no `pushKey`, and the
    /// notification stays in the clear rather than being sealed to a key
    /// nobody stored.
    static func publicKey() -> String? {
        guard let key = load() else { return nil }
        return PushCrypto.b64url(key.publicKey.x963Representation)
    }

    /// The opened notification, or nil when this process cannot read the key
    /// or the envelope is not ours. The caller leaves the fallback alert.
    static func open(_ envelope: String) -> PushCrypto.Opened? {
        guard let key = load() else { return nil }
        return try? PushCrypto.open(privateKey: key, recipientPublic: key.publicKey.x963Representation, envelope: envelope)
    }

    private static var isExtension: Bool {
        Bundle.main.bundleIdentifier?.hasSuffix(".Push") == true
    }

    private static func load() -> P256.KeyAgreement.PrivateKey? {
        if let data = read(), let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: data), data.count == 32 {
            return key
        }
        // A key that does not parse is replaced, so the next registration
        // publishes the key we can actually open. The extension never does
        // that replacement: it would write into its own group.
        guard !isExtension else { return nil }
        let key = P256.KeyAgreement.PrivateKey()
        guard write(key.rawRepresentation) else { return nil }
        return key
    }

    private static func query(group: String?) -> [String: Any] {
        var item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group {
            item[kSecAttrAccessGroup as String] = group
        }
        return item
    }

    private static func write(_ data: Data) -> Bool {
        let base = query(group: nil)
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private static func read() -> Data? {
        var item = query(group: isExtension ? appAccessGroup() : nil)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    /// The app's default keychain group, derived from this process's own.
    ///
    /// The team prefix is not a constant: it is whatever signed the build.
    /// This process's own group is that prefix plus its bundle id, read back
    /// off a throwaway item, and the app's group is the same prefix plus the
    /// app's bundle id.
    private static func appAccessGroup() -> String? {
        guard let own = ownAccessGroup(), let bundle = Bundle.main.bundleIdentifier, own.hasSuffix(bundle) else { return nil }
        return String(own.dropLast(bundle.count)) + appBundle
    }

    private static let ownGroupAccount = "push-group-probe"

    private static func ownAccessGroup() -> String? {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ownGroupAccount,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data("probe".utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        var read = base
        read[kSecReturnAttributes as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &out)
        SecItemDelete(base as CFDictionary)
        guard status == errSecSuccess, let attrs = out as? [String: Any] else { return nil }
        return attrs[kSecAttrAccessGroup as String] as? String
    }
}
