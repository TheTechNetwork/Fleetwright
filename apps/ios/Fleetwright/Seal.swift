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
