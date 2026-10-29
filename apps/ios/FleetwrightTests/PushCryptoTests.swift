import CryptoKit
import XCTest

@testable import Fleetwright

/// `PushCrypto.swift` against the envelope the coordinator's own code sealed.
///
/// `test/fixtures/parity/push-envelope.json` is one notification sealed by
/// `envelopeFor` in `src/fleet/push.js`. `test/push-envelope-parity.test.js`
/// opens it with that code. This opens the same bytes, which is the only way
/// to know a phone will read what a fleet sends. `PushCryptoTest.kt` does the
/// same.
final class PushCryptoTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Recipient: Decodable { let d: String; let pushKey: String }
        struct Plaintext: Decodable {
            let title: String
            let body: String
            let data: [String: String]
        }
        let recipient: Recipient
        let envelope: String
        let plaintext: Plaintext
    }

    private func fixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "push-envelope", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "push-envelope", withExtension: "json")
        else {
            XCTFail("parity/push-envelope.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func scalar(_ b64: String) throws -> Data {
        var raw = try XCTUnwrap(PushCrypto.unb64(b64))
        if raw.count < 32 {
            raw = Data(repeating: 0, count: 32 - raw.count) + raw
        }
        return raw
    }

    private func recipientKey(_ f: Fixture) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: try scalar(f.recipient.d))
    }

    func testOpensWhatTheCoordinatorSealed() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        XCTAssertEqual(PushCrypto.b64url(key.publicKey.x963Representation), f.recipient.pushKey)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        XCTAssertEqual(opened.title, f.plaintext.title)
        XCTAssertEqual(opened.body, f.plaintext.body)
        XCTAssertEqual(opened.data, f.plaintext.data)
    }

    func testAFlippedBitDoesNotOpen() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        var bytes = try XCTUnwrap(PushCrypto.unb64(f.envelope))
        bytes[bytes.count - 1] ^= 0x01
        XCTAssertThrowsError(try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: PushCrypto.b64url(bytes)))
    }

    func testTheButtonFieldsReplaceTheCiphertext() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        let merged = PushCrypto.merged(userInfo: ["e": f.envelope], opened: opened)
        XCTAssertNil(merged["e"])
        // What a press and a tap read: the answer, its age, and where to go.
        for field in ["promptId", "answers", "sentAt", "name", "hostId", "event"] {
            XCTAssertEqual(merged[field] as? String, f.plaintext.data[field], field)
        }
    }

    /// The buttons come from the sealed category, and a clear one that
    /// disagrees with it leaves none.
    func testTheSealedCategoryDecidesTheButtons() throws {
        let sealed = try XCTUnwrap(try fixture().plaintext.data["category"])
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: sealed), sealed)
        // Changed on the way: no buttons rather than the wrong words.
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: "fleet.prompt.trust"), "")
        // A sealed "nothing to answer" is not overruled by a clear one added on the way.
        XCTAssertEqual(PushCrypto.category(sealed: "", clear: sealed), "")
        // Dropped on the way: the sealed one is still there.
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: ""), sealed)
        // A coordinator from before the category was sealed: the clear one, as always.
        XCTAssertEqual(PushCrypto.category(sealed: nil, clear: sealed), sealed)
    }

    /// The self-test registration runs before it sends a key.
    func testTheSelfTestOpensItsOwnSealAndNoOneElses() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        XCTAssertTrue(PushKey.opensItsOwnSeal(key))

        // The seal is the coordinator's scheme, so the key opens what it seals.
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let envelope = try PushCrypto.seal(to: recipient, title: "a", body: "b")
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: envelope)
        XCTAssertEqual(opened.title, "a")
        XCTAssertEqual(opened.body, "b")

        // And only for the key it was sealed to.
        let other = P256.KeyAgreement.PrivateKey()
        XCTAssertThrowsError(try PushCrypto.open(
            privateKey: other, recipientPublic: other.publicKey.x963Representation, envelope: envelope
        ))
    }
}
