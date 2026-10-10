import CryptoKit
import Foundation

/// Sealing a message to the fleet's minting Worker, and opening one it sealed
/// back: `src/fleet/seal.js`, on the phone.
///
/// WHY THE PHONE NEEDS IT. Two things leave this phone that the coordinator in
/// the middle must not be able to read: a GitHub sign-in on its way to be
/// finished, and a Claude login on its way to be kept. Both are sealed to the
/// minter's key, which the person pinned, and the answer to the first comes
/// back sealed to a key this phone made for that one request.
///
/// THE SAME CONSTRUCTION, BYTE FOR BYTE: ECDH on P-256, HKDF-SHA-256 with the
/// two public keys as salt and "fleetwright-mint/v1" as info, AES-256-GCM with
/// the purpose of the message as additional data. `test/fixtures/parity/seal.json`
/// is one message sealed by the JavaScript with every random value written
/// down; `SealTests.swift` seals the same plaintext with the same values and
/// must get the same ciphertext, as `SealTest.kt` does on Android.
///
/// CryptoKit only. This is encryption used to protect a credential in transit
/// to the person's own fleet, with Apple's standard algorithms.
enum Seal {
    private static let info = Data("fleetwright-mint/v1".utf8)

    /// What a Claude login is sealed under on its way to the minter.
    static let depositAAD = "fleetwright-claude-deposit/v1"
    /// A GitHub sign-in or renewal on its way to the minter.
    static let githubRequestAAD = "fleetwright-github-request/v1"
    /// The GitHub token the minter got for this phone, on its way back.
    static let githubReplyAAD = "fleetwright-github-reply/v1"
    /// A request to the person's vault (PhoneVault), on its way to the minter.
    static let vaultRequestAAD = "fleetwright-vault-request/v1"
    /// The vault's answer, on its way back to the key this phone made for it.
    static let vaultReplyAAD = "fleetwright-vault-reply/v1"
    /// A Claude token one of your machines made with `claude setup-token`, on
    /// its way back to the key this phone made for it.
    static let setupTokenAAD = "fleetwright-setup-token/v1"
    /// A Xen Orchestra admin sign-in on its way to the machine running setup
    /// for it (docs/hypervisors.md). Bound to the job and the address, so a
    /// sealed sign-in cannot be replayed into another job or at another pool:
    /// the machine opens it under the same two values it was given at `begin`.
    static func xosetupAAD(job: String, address: String) -> String { "fleetwright-xosetup/v1:\(job):\(address)" }
    /// What the machine seals the limited user's token under on its way back
    /// to this phone: the same job and address under a name of its own, so a
    /// sealed sign-in and a sealed token can never be taken for each other
    /// (xosetupHandoffAad in src/fleet/seal.js; XOSetupHandoff).
    static func xosetupHandoffAAD(job: String, address: String) -> String { "fleetwright-xosetup-handoff/v1:\(job):\(address)" }
    /// What a policy job read from the pool (its storage, networks, capacity
    /// and what the fleet may use now), on its way back to the key this phone
    /// sent inside the policy sign-in. A network map is not the coordinator's
    /// to read, so it travels sealed like the token does, under a name of its
    /// own (xosetupInventoryAad in src/fleet/seal.js; XOPolicy).
    static func xosetupInventoryAAD(job: String, address: String) -> String { "fleetwright-xosetup-inventory/v1:\(job):\(address)" }
    /// The person's choice for that job, sealed to the job's key from `begin`
    /// (the key the sign-in went to), so the machine can tell it came from
    /// the phone that saw the inventory and not from the coordinator
    /// (xosetupPolicyAad in src/fleet/seal.js).
    static func xosetupPolicyAAD(job: String, address: String) -> String { "fleetwright-xosetup-policy/v1:\(job):\(address)" }

    /// What an install's two passwords are sealed under: the job and the pool
    /// master's address, under a name of its own, so a sealed root password is
    /// never opened as a setup's sign-in (xodeployAad in src/fleet/seal.js).
    static func xodeployAAD(job: String, address: String) -> String { "fleetwright-xodeploy/v1:\(job):\(address)" }

    /// A pool's page read by one of your machines for this phone away from
    /// it, on its way back to the key made here for that one look: bound to
    /// the address, so one pool's page cannot be shown as another's
    /// (xolookAad in src/fleet/seal.js; PoolWatch).
    static func xolookAAD(address: String) -> String { "fleetwright-xolook/v1:\(address)" }

    enum Failure: LocalizedError {
        case notAKey, notSealed
        var errorDescription: String? {
            switch self {
            case .notAKey: return "That is not a minter key. It is 87 letters, digits, - and _."
            case .notSealed: return "The answer did not open with this phone's key, so it was not used."
            }
        }
    }

    /// A key this phone made for one request; the private half never leaves memory.
    struct OneUseKey {
        let privateKey: P256.KeyAgreement.PrivateKey
        var publicKey: String { b64(privateKey.publicKey.x963Representation) }
    }

    static func newKey() -> OneUseKey { OneUseKey(privateKey: P256.KeyAgreement.PrivateKey()) }

    /// An uncompressed P-256 public key, base64url without padding: 87 characters.
    static func isKey(_ s: String) -> Bool {
        s.count == 87 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Seal `payload` so that only the holder of `to`'s private half can read it.
    static func seal(to: String, aad: String, payload: [String: Any]) throws -> [String: String] {
        try seal(to: to, aad: aad, plaintext: JSONSerialization.data(withJSONObject: payload))
    }

    /// The bytes version, with the two random values as parameters so the
    /// fixture can fix them. Every caller in the app leaves them to default.
    static func seal(
        to: String,
        aad: String,
        plaintext: Data,
        ephemeral: P256.KeyAgreement.PrivateKey = P256.KeyAgreement.PrivateKey(),
        nonce: AES.GCM.Nonce = AES.GCM.Nonce()
    ) throws -> [String: String] {
        guard isKey(to), let raw = unb64(to) else { throw Failure.notAKey }
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: raw)
        let epk = ephemeral.publicKey.x963Representation
        let key = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + raw, sharedInfo: info, outputByteCount: 32)
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: Data(aad.utf8))
        return ["epk": b64(epk), "iv": b64(Data(nonce)), "ct": b64(box.ciphertext + box.tag)]
    }

    /// Open what the minter sealed to `key`. Throws on anything that does not open.
    static func open(_ key: OneUseKey, aad: String, sealed: [String: Any]) throws -> [String: Any] {
        guard let epkText = sealed["epk"] as? String, isKey(epkText),
              let epk = unb64(epkText),
              let iv = unb64(sealed["iv"] as? String ?? ""), iv.count == 12,
              let ct = unb64(sealed["ct"] as? String ?? ""), ct.count > 16
        else { throw Failure.notSealed }
        let sender = try P256.KeyAgreement.PublicKey(x963Representation: epk)
        let mine = key.privateKey.publicKey.x963Representation
        let aes = try key.privateKey.sharedSecretFromKeyAgreement(with: sender)
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + mine, sharedInfo: info, outputByteCount: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        let plain = try AES.GCM.open(box, using: aes, authenticating: Data(aad.utf8))
        guard let object = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw Failure.notSealed }
        return object
    }

    static func b64(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func unb64(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}
