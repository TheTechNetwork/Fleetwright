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
/// IT SEALS AS WELL, for one reason: the self-test registration runs before
/// it sends a key (`PushKey.registrationKey`). Nothing else on the phone
/// seals a notification, and nothing should.
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
        let (key, nonce) = try derive(shared, salt: salt, recipientPublic: recipientPublic, ephemeralRaw: ephemeralRaw)
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

    /// Seal one notification to a public key, as `sealTo` in
    /// `src/fleet/push-crypto.js` does: a fresh ephemeral key and a fresh salt
    /// every time. Only the self-test calls this.
    static func seal(to recipientPublic: Data, title: String, body: String) throws -> String {
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: recipientPublic)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let ephemeralRaw = ephemeral.publicKey.x963Representation
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let salt = SymmetricKey(size: SymmetricKeySize(bitCount: 128)).withUnsafeBytes { Data($0) }
        let (key, nonce) = try derive(shared, salt: salt, recipientPublic: recipientPublic, ephemeralRaw: ephemeralRaw)
        let object: [String: Any] = ["title": title, "body": body, "data": [String: String]()]
        let plaintext = try JSONSerialization.data(withJSONObject: object)
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        var out = Data([version])
        out.append(salt)
        out.append(ephemeralRaw)
        out.append(box.ciphertext)
        out.append(box.tag)
        return b64url(out)
    }

    /// Key and nonce from the shared secret.
    ///
    /// ONE EXPAND, then split. Two derivations would not be the scheme the
    /// coordinator uses, and the nonce only has to be unique per key.
    private static func derive(
        _ shared: SharedSecret, salt: Data, recipientPublic: Data, ephemeralRaw: Data
    ) throws -> (SymmetricKey, AES.GCM.Nonce) {
        var info = Data()
        info.append(infoPrefix)
        info.append(recipientPublic)
        info.append(ephemeralRaw)
        let okm = shared
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 44)
            .withUnsafeBytes { Data($0) }
        guard okm.count == 44 else { throw Failure.envelope }
        let nonce = try AES.GCM.Nonce(data: okm.suffix(12))
        return (SymmetricKey(data: okm.prefix(32)), nonce)
    }

    /// What a tap reads, once the envelope is open.
    ///
    /// The ciphertext is dropped. Everything else that arrived in the clear
    /// stays, and the sealed fields are written over it. `sentAt` is one of
    /// those fields, which is what lets an answer older than an hour be
    /// refused by the check that already does that.
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

    /// Which buttons an opened notification gets: a category, or "" for none.
    ///
    /// THE SEALED ONE DECIDES. The category arrives twice: in `aps.category`,
    /// which iOS reads before anything is opened and which Apple or a relay
    /// could have changed, and inside the envelope, which nobody could. The
    /// buttons' words come from the category and the digits they type from
    /// the envelope, so a changed clear one would label one answer as the
    /// other. When the clear one is there and disagrees, there are no buttons;
    /// the notification still opens the app.
    ///
    /// `sealed` IS NIL ONLY FROM A COORDINATOR THAT PREDATES SEALING IT, and
    /// then the clear one is all there is, as it always was. A coordinator
    /// that seals it always writes it, "" when there is nothing to answer
    /// (`envelopeFor` in `src/fleet/push.js`).
    static func category(sealed: String?, clear: String) -> String {
        guard let sealed else { return clear }
        if !clear.isEmpty, clear != sealed { return "" }
        return sealed
    }

    /// Which buttons a notification gets when it was not opened: none if it
    /// was sealed, its own if it never was.
    ///
    /// A SEALED ONE KEEPS NO BUTTONS, whether the key could not open it or
    /// the extension ran out of time. Its clear category would still draw
    /// them, but the prompt id and the digits they type are inside the
    /// envelope, so `NotificationAnswers.decide` has nothing to answer, and
    /// the answer actions do not bring the app forward: a press would do
    /// nothing at all, which is worse than no button. The notification still
    /// opens the app when it is tapped.
    static func categoryUnopened(userInfo: [AnyHashable: Any], clear: String) -> String {
        userInfo["e"] == nil ? clear : ""
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
/// writes this on registration, into its default group: its own id, the group
/// an item lands in when the app names none. The app names none so its
/// entitlements stay the ones the existing distribution profile signs.
///
/// THE EXTENSION READS IT WITHOUT NAMING A GROUP either. A search that names
/// no group covers every group the process is entitled to, and the extension
/// is entitled to the app's (project.yml says why, and what else that lets it
/// read).
enum PushKey {
    private static let service = "network.thetech.fleetwright"
    private static let account = "push-key"

    enum Failure: Error {
        /// The keychain answered with something other than the item or "no
        /// such item". Locked before the first unlock, or busy: a reason to
        /// try again later, never a reason to replace the key.
        case keychain(OSStatus)
        /// The extension found no key. It never makes one.
        case missing
        /// The stored key did not open a probe sealed to its own public half.
        case selfTest
    }

    /// The key registration sends, or nil when this phone has never sent one
    /// and has none it can use now.
    ///
    /// A PHONE THAT HAS SENT A KEY NEVER SENDS NONE AGAIN. The coordinator
    /// keeps a key only when one is sent, so a registration without it puts
    /// this phone back on plaintext. The stored key is read and sealed to in
    /// software, and if it opens its own seal its public half is sent. If the
    /// keychain errors, or the key fails that self-test, the registration
    /// still goes, with the last key a registration sent (`sentKey`): the
    /// APNs token is refreshed, the coordinator keeps sealing, and anything
    /// this phone cannot open shows the fallback sentence, which still wakes
    /// the person.
    /// Only a phone that has never sent one registers without a key, and then
    /// at once, because nothing was ever sealed to it and so nothing is lost.
    /// (A reinstall starts with nothing sent, so a reinstalled app whose
    /// first registration meets a keychain error is that phone too.)
    ///
    /// AN ERROR THAT DOES NOT GO AWAY IS NOT A HICCUP, and the fallback would
    /// leave every notification on the fallback sentence for good. So the
    /// failures are counted, with the time of the first, and after
    /// `PushKeyRule.attempts` of them in a row spread over at least a day the
    /// key is replaced (`startOver`). A replacement that fails falls back to
    /// the last key sent too. Any registration that gets as far as a key
    /// clears the count. The rule is `PushKeyRule.choose`, the same as on
    /// Android.
    ///
    /// ONE AT A TIME. Two registrations at once on a phone with no key yet
    /// would each make one, and the second write would replace the key the
    /// first had just sent.
    static func registrationKey() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let choice = PushKeyRule.choose(
            failures: storedFailures,
            sent: sentKey,
            now: Date().timeIntervalSince1970,
            read: { try readKey() },
            replace: { startOver() }
        )
        if let failure = choice.failure {
            if choice.replaced {
                print("push key: registrations have not been able to use it for a day or more, so it was replaced (\(failure))")
            } else if choice.pushKey == nil {
                print("push key: could not use it, and none was ever sent, so this registration sends none (\(failure))")
            } else {
                print("push key: could not use it this time, so this registration sends the last one sent (\(failure))")
            }
        }
        storedFailures = choice.failures
        // SAVED HERE, BEFORE THE POST, not after its answer: the caller posts
        // what this returns and nothing else. A post the coordinator took
        // whose answer was lost would otherwise leave this phone believing it
        // never sent a key, and free to register without one.
        if let key = choice.pushKey { sentKey = key }
        return choice.pushKey
    }

    /// The stored key's public half, once it has opened its own seal.
    ///
    /// A KEY THAT FAILS ITS SELF-TEST THROWS, and counts like a keychain
    /// error: sending it would only buy the fallback sentence, and a key that
    /// keeps failing is replaced like one the keychain keeps refusing.
    private static func readKey() throws -> String {
        let key = try load()
        guard opensItsOwnSeal(key) else { throw Failure.selfTest }
        return PushCrypto.b64url(key.publicKey.x963Representation)
    }

    /// A new key in place of one that has failed for a day, or nil when this
    /// phone cannot keep one. `write` removes the old item first.
    ///
    /// NIL HERE IS THE PLATFORM SAYING NO, not a hiccup: the old key has
    /// failed for a day, and now a new one cannot be written either. The
    /// registration then sends the last key sent, or none on a phone that
    /// has never sent one, and the next launch tries the keychain again from
    /// the start.
    private static func startOver() -> String? {
        let key = P256.KeyAgreement.PrivateKey()
        guard (try? write(key.rawRepresentation)) != nil, opensItsOwnSeal(key) else { return nil }
        return PushCrypto.b64url(key.publicKey.x963Representation)
    }

    private static let lock = NSLock()
    private static let failuresKey = "pushKeyFailures"
    private static let firstFailureKey = "pushKeyFirstFailure"
    private static let sentKeyKey = "pushKeySent"

    /// The public key the last registration with one sent, in the app's own
    /// defaults. Not a secret: it is the half the coordinator already holds.
    /// The extension never reads it.
    ///
    /// IT GOES WITH THE APP, AND THE KEYCHAIN ITEM DOES NOT. A reinstalled
    /// app starts with none, reads the key the keychain kept, and sends that,
    /// which saves it again.
    private static var sentKey: String? {
        get { UserDefaults.standard.string(forKey: sentKeyKey) }
        set { UserDefaults.standard.set(newValue, forKey: sentKeyKey) }
    }

    /// Registrations in a row that could not use the key, and when the first
    /// was. Not a secret: two numbers.
    private static var storedFailures: PushKeyRule.Failures? {
        get {
            let count = UserDefaults.standard.integer(forKey: failuresKey)
            guard count > 0 else { return nil }
            return PushKeyRule.Failures(count: count, firstAt: UserDefaults.standard.double(forKey: firstFailureKey))
        }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue.count, forKey: failuresKey)
                UserDefaults.standard.set(newValue.firstAt, forKey: firstFailureKey)
            } else {
                UserDefaults.standard.removeObject(forKey: failuresKey)
                UserDefaults.standard.removeObject(forKey: firstFailureKey)
            }
        }
    }

    /// Seal a probe to the key's public half and open it with the key.
    static func opensItsOwnSeal(_ key: P256.KeyAgreement.PrivateKey) -> Bool {
        let probe = "fleetwright-push-self-test"
        let recipient = key.publicKey.x963Representation
        guard
            let envelope = try? PushCrypto.seal(to: recipient, title: probe, body: probe),
            let opened = try? PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: envelope)
        else { return false }
        return opened.title == probe && opened.body == probe
    }

    /// The opened notification, or nil when this process cannot read the key
    /// or the envelope is not ours. The caller leaves the fallback alert.
    static func open(_ envelope: String) -> PushCrypto.Opened? {
        guard let key = try? load() else { return nil }
        return try? PushCrypto.open(privateKey: key, recipientPublic: key.publicKey.x963Representation, envelope: envelope)
    }

    private static var isExtension: Bool {
        Bundle.main.bundleIdentifier?.hasSuffix(".Push") == true
    }

    /// The stored key, or a new one when there is none.
    ///
    /// A NEW ONE ONLY FOR "NO SUCH ITEM". Any other answer from the keychain
    /// is thrown, and the key that may well be there is left alone: replacing
    /// it would orphan every notification already sealed to it. Stored bytes
    /// that are not a key are replaced, because they cannot open anything
    /// and nothing could ever make them.
    private static func load() throws -> P256.KeyAgreement.PrivateKey {
        var item = query()
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            if let data = out as? Data, data.count == 32,
               let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: data) {
                return key
            }
        case errSecItemNotFound:
            break
        default:
            throw Failure.keychain(status)
        }
        // The extension never writes: it would write into its own group.
        guard !isExtension else { throw Failure.missing }
        let key = P256.KeyAgreement.PrivateKey()
        try write(key.rawRepresentation)
        return key
    }

    private static func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func write(_ data: Data) throws {
        let base = query()
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }
}

/// What a registration sends when the push key fails, and when a key that
/// keeps failing is replaced, decided without the keychain so a test can
/// hold it to the rule. `PushKey.registrationKey` does the keychain half.
///
/// THREE REGISTRATIONS IN A ROW, THE FIRST A DAY OR MORE BEFORE THE LAST.
/// Either alone is too little: three launches in a minute is one bad
/// moment, and one failure a day ago may have been the only launch since. A
/// key that has failed on both counts is not coming back, and every day it
/// stays is a day every notification is the fallback sentence. A clock that
/// has gone backwards starts the count again rather than waiting for it to
/// catch up.
///
/// `PushKeyRule` in PushCrypto.kt is the same rule on Android, with the same
/// numbers.
enum PushKeyRule {
    static let attempts = 3
    static let span: TimeInterval = 24 * 3600

    struct Failures: Equatable {
        let count: Int
        let firstAt: TimeInterval
    }

    /// The count after one more failure at `now`.
    static func failed(_ before: Failures?, now: TimeInterval) -> Failures {
        guard let before, before.count > 0, now >= before.firstAt else {
            return Failures(count: 1, firstAt: now)
        }
        return Failures(count: before.count + 1, firstAt: before.firstAt)
    }

    /// Whether the key goes and a new one is made.
    static func startOver(_ failures: Failures, now: TimeInterval) -> Bool {
        failures.count >= attempts && now - failures.firstAt >= span
    }

    /// What one registration decided.
    struct Choice {
        /// The key it sends: nil only on a phone that has never sent one.
        let pushKey: String?
        /// The count to store, nil once a registration got as far as a key.
        let failures: Failures?
        /// Why the stored key could not be used, when it could not.
        let failure: String?
        /// Whether the stored key was replaced this time.
        let replaced: Bool
    }

    /// The key a registration sends.
    ///
    /// `read` is the stored key's public half, and throws when it cannot be
    /// used this time; `replace` makes a new one, or nil when it cannot;
    /// `sent` is the last key a registration sent. A KEY ERROR NEVER MEANS NO
    /// KEY once one has been sent: `sent` goes instead, before the threshold,
    /// and after it when the replacement fails too.
    static func choose(
        failures: Failures?,
        sent: String?,
        now: TimeInterval,
        read: () throws -> String?,
        replace: () -> String?
    ) -> Choice {
        do {
            let key = try read()
            return Choice(pushKey: key ?? sent, failures: nil, failure: nil, replaced: false)
        } catch {
            let after = failed(failures, now: now)
            guard startOver(after, now: now) else {
                return Choice(pushKey: sent, failures: after, failure: "\(error)", replaced: false)
            }
            return Choice(pushKey: replace() ?? sent, failures: nil, failure: "\(error)", replaced: true)
        }
    }
}
