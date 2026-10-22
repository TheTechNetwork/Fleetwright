import CryptoKit
import Foundation

/// What this phone signs when it asks a box for something, so the box obeys the
/// person and not whoever relayed the request. DeviceSigning.kt is the same on
/// Android. docs/signed-intents.md has the design; this is phase 2: the phone
/// signs, and boxes still only count what they find.
///
/// WHERE THE BOX GETS THIS PHONE'S KEY. Not from the coordinator. The phone
/// lists its key with the fleet's minter, in a vault request sealed to the
/// minter and carrying this phone's GitHub sign-in (PhoneVault `devicekey`),
/// and boxes are given the list signed by the minter's own key, which they
/// take from the fleet's address and keep. So the phone signs only once the
/// minter has its key under the account it is signed in as: before that, a
/// signature would reach the box as a key it has never heard of.
///
/// WHAT IS SIGNED: the verb, the parameters exactly as sent, the box it is for,
/// the person, the request's id and the time, in the bytes
/// src/fleet/protocol/intent-signature.js builds. Only an intent that names its
/// box is signed, because the signature is for one box; one the coordinator
/// places is sent unsigned, and so is one it changes on the way (it drops the
/// signature rather than send one that no longer holds).
///
/// THE KEY lives in the Secure Enclave where there is one, and cannot leave it.
/// Where there is not (the simulator), it is a software key kept in this
/// phone's keychain, this device only, and the minter's list says which.
/// Signing asks for nothing: a prompt on every tap is how a safety feature
/// gets switched off.
enum IntentSigning {
    /// The bytes signed for one intent to one box, as `intentSigningInput`.
    static func input(actor: String, id: String, issuedAt: Int, params: [String: Any], verb: String, host: String) -> String {
        signingInput("intent", ["actor": actor, "host": host, "id": id, "issuedAt": issuedAt, "params": params, "verb": verb])
    }

    /// `agent-fleet/v1/<context>\n<canonical JSON>`, as src/fleet/crypto.js `signingInput`.
    static func signingInput(_ context: String, _ payload: Any) -> String {
        "agent-fleet/v1/\(context)\n\(canonical(payload))"
    }

    /// JSON as JavaScript's `JSON.stringify` writes it, with every object's keys
    /// sorted by UTF-16 code unit: crypto.js `canonical`. Not JSONSerialization,
    /// which neither sorts keys nor escapes the way JavaScript does (it writes
    /// `\/`), and a single byte of difference is a signature that does not hold.
    /// test/fixtures/parity/intent-signing.json holds the cases where encoders
    /// differ, and IntentSigningTests checks this against every one.
    static func canonical(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        switch value {
        case let s as String:
            return quote(s)
        case let i as Int:
            return String(i)
        case let b as Bool:
            return b ? "true" : "false"
        case let d as [String: Any]:
            let keys = d.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + keys.map { "\(quote($0)):\(canonical(d[$0]))" }.joined(separator: ",") + "}"
        case let a as [Any]:
            return "[" + a.map { canonical($0) }.joined(separator: ",") + "]"
        default:
            return "null"
        }
    }

    /// A string as `JSON.stringify` quotes it: a quote and a backslash escaped,
    /// \b \f \n \r \t by name, every other control character as \u00XX in lower
    /// case, and everything else (a slash, DEL, U+2028, anything outside ASCII)
    /// as itself.
    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let c where c.value < 0x20: out += String(format: "\\u%04x", c.value)
            default: out.unicodeScalars.append(u)
            }
        }
        return out + "\""
    }
}

/// This phone's signing key, made once and kept.
struct DeviceKey {
    let x: String
    let y: String
    /// In the Secure Enclave, rather than a software key in the keychain.
    let hardware: Bool
    private let signer: (Data) throws -> Data

    var jwk: [String: Any] { ["kty": "EC", "crv": "P-256", "x": x, "y": y] }

    /// The key's id: the whole SHA-256 of its JWK in canonical form, as the
    /// minter files it and a box looks it up (`keyId`).
    var kid: String { Self.kid(x: x, y: y) }

    static func kid(x: String, y: String) -> String {
        let canonical = IntentSigning.canonical(["crv": "P-256", "kty": "EC", "x": x, "y": y])
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// ECDSA P-256 with SHA-256, r || s, base64url: what crypto.js `verify` takes.
    func sign(_ message: String) throws -> String {
        Seal.b64(try signer(Data(message.utf8)))
    }

    private static let account = "deviceSigningKey"

    /// The kept key, or a new one kept now.
    static func load() throws -> DeviceKey {
        if let kept = Keychain.get(account), let key = restore(kept) { return key }
        let (key, stored) = try make()
        Keychain.set(stored, for: account)
        return key
    }

    private static func make() throws -> (DeviceKey, String) {
        if SecureEnclave.isAvailable {
            let key = try SecureEnclave.P256.Signing.PrivateKey()
            return (enclave(key), "se:" + Seal.b64(key.dataRepresentation))
        }
        let (key, raw) = software()
        return (key, "sw:" + Seal.b64(raw))
    }

    private static func restore(_ stored: String) -> DeviceKey? {
        guard let data = Seal.unb64(String(stored.dropFirst(3))) else { return nil }
        if stored.hasPrefix("se:"), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) {
            return enclave(key)
        }
        if stored.hasPrefix("sw:"), let key = try? P256.Signing.PrivateKey(rawRepresentation: data) {
            return software(key).0
        }
        return nil
    }

    private static func enclave(_ key: SecureEnclave.P256.Signing.PrivateKey) -> DeviceKey {
        let raw = key.publicKey.rawRepresentation
        return DeviceKey(x: Seal.b64(raw.prefix(32)), y: Seal.b64(raw.suffix(32)), hardware: true) {
            try key.signature(for: $0).rawRepresentation
        }
    }

    /// A software key, for a phone with no Secure Enclave. Also what the tests
    /// sign with, since the simulator has none.
    static func software(_ key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) -> (DeviceKey, Data) {
        let raw = key.publicKey.rawRepresentation
        let device = DeviceKey(x: Seal.b64(raw.prefix(32)), y: Seal.b64(raw.suffix(32)), hardware: false) {
            try key.signature(for: $0).rawRepresentation
        }
        return (device, key.rawRepresentation)
    }
}

/// When this phone signs, and listing its key so that it can.
struct DeviceSigning {
    let settings: Settings

    private static let listedKey = "deviceKeyListed"
    private static let triedKey = "deviceKeyListTriedAt"

    private var email: String { settings.signedInAs.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The signature for an intent to `host`, when this phone's key is listed
    /// for the account it is signed in as. Nil otherwise, and the intent goes
    /// as it always has.
    func signature(verb: String, params: [String: Any], id: String, host: String) -> (sig: String, kid: String, issuedAt: Int)? {
        guard !email.isEmpty, !host.isEmpty, let key = try? DeviceKey.load(),
              UserDefaults.standard.string(forKey: Self.listedKey) == "\(key.kid) \(email)"
        else { return nil }
        let issuedAt = Int(Date().timeIntervalSince1970 * 1000)
        let input = IntentSigning.input(actor: email, id: id, issuedAt: issuedAt, params: params, verb: verb, host: host)
        guard let sig = try? key.sign(input) else { return nil }
        return (sig, key.kid, issuedAt)
    }

    /// List this phone's key with the minter for the account it is signed in
    /// as, when it has a GitHub sign-in to do that with and has not already.
    /// At most once in ten minutes, so a minter that is down is not asked on
    /// every tap. Never throws: until it is listed, nothing is signed.
    func listIfNeeded(_ fleet: Fleet) async {
        guard !email.isEmpty, PhoneGitHub(settings: settings).signedIn, let key = try? DeviceKey.load() else { return }
        let listedAs = "\(key.kid) \(email)"
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: Self.listedKey) != listedAs else { return }
        let now = Date().timeIntervalSince1970
        guard now - defaults.double(forKey: Self.triedKey) > 600 else { return }
        defaults.set(now, forKey: Self.triedKey)
        if (try? await PhoneVault(settings: settings).listDeviceKey(fleet, key: key)) != nil {
            defaults.set(listedAs, forKey: Self.listedKey)
        }
    }
}
