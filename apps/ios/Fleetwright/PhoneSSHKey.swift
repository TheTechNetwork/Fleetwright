import CryptoKit
import Foundation
import NIOSSH

/// This phone's own SSH key, for the terminal in the app (SSHTerminalView).
/// docs/hypervisors.md, "SSH in the app".
///
/// MADE HERE, KEPT HERE: an Ed25519 key made on this phone the first time it
/// is asked for, in the Keychain, this device only, never in a backup, gone at
/// sign-out. Only its public half leaves, as its own item in your vault
/// (`SSH_KEY_PHONE.<id>`) beside the keys you pasted, because the vault gives
/// nothing back to a phone and adding to the pasted list would mean replacing
/// it. A machine made after that takes it with the rest (xo-pools.js,
/// `isSshKeysItem`).
///
/// A MACHINE'S HOST KEY IS HELD TO THE FIRST ONE IT SHOWED, by its name: each
/// machine is made fresh with a name nobody had, so the first answer is the
/// machine's own, and any other later is refused with nothing sent.
enum PhoneSSHKey {
    private static let account = "ssh-phone-key"
    private static let addedKey = "ssh-phone-key-added"
    private static let hostKeysKey = "ssh-host-keys"

    /// The key, made the first time.
    static func key() -> Curve25519.Signing.PrivateKey {
        if let raw = Keychain.get(account).flatMap({ Data(base64Encoded: $0) }),
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) {
            return key
        }
        let key = Curve25519.Signing.PrivateKey()
        Keychain.set(key.rawRepresentation.base64EncodedString(), for: account)
        UserDefaults.standard.removeObject(forKey: addedKey)
        return key
    }

    /// The line a machine's authorized_keys takes.
    static func publicLine() -> String {
        String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: key()).publicKey) + " fleetwright-phone"
    }

    /// The vault item it is kept under, named by the key, so a new key is a new item.
    static func itemName() -> String {
        let digest = SHA256.hash(data: key().publicKey.rawRepresentation)
        return "SSH_KEY_PHONE." + digest.prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    /// Whether this phone put its key in the vault, as far as it knows.
    static var added: Bool {
        get { UserDefaults.standard.bool(forKey: addedKey) }
        set { UserDefaults.standard.set(newValue, forKey: addedKey) }
    }

    /// Put the public half in the vault.
    static func add(_ settings: Settings) async throws -> String {
        let said = try await PhoneVault(settings: settings).keepSecret(Fleet(settings: settings), name: itemName(), value: publicLine())
        added = true
        return said
    }

    /// The host key a machine showed first, by its name, or nil.
    static func hostKey(of machine: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: hostKeysKey) as? [String: String])?[machine]
    }

    static func hold(_ fingerprint: String, for machine: String) {
        var all = (UserDefaults.standard.dictionary(forKey: hostKeysKey) as? [String: String]) ?? [:]
        // A machine lives hours: the list keeps the newest few hundred.
        if all.count > 300 { all = [:] }
        all[machine] = fingerprint
        UserDefaults.standard.set(all, forKey: hostKeysKey)
    }

    /// Gone at sign-out (Settings.signOut).
    static func forgetAll() {
        Keychain.set("", for: account)
        UserDefaults.standard.removeObject(forKey: addedKey)
        UserDefaults.standard.removeObject(forKey: hostKeysKey)
    }
}
