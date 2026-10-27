import CryptoKit
import XCTest

@testable import Fleetwright

/// `PushCrypto.swift` against the envelope the coordinator's own code sealed.
///
/// `test/fixtures/parity/push-envelope.json` is one notification sealed by
/// `src/fleet/push-crypto.js`. `test/push-envelope-parity.test.js` opens it
/// with that code. This opens the same bytes, which is the only way to know a
/// phone will read what a fleet sends. `PushCryptoTest.kt` does the same.
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

    func testOpensWhatTheCoordinatorSealed() throws {
        let f = try fixture()
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: try scalar(f.recipient.d))
        XCTAssertEqual(PushCrypto.b64url(key.publicKey.x963Representation), f.recipient.pushKey)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        XCTAssertEqual(opened.title, f.plaintext.title)
        XCTAssertEqual(opened.body, f.plaintext.body)
        XCTAssertEqual(opened.data, f.plaintext.data)
    }

    func testAFlippedBitDoesNotOpen() throws {
        let f = try fixture()
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: try scalar(f.recipient.d))
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        var bytes = try XCTUnwrap(PushCrypto.unb64(f.envelope))
        bytes[bytes.count - 1] ^= 0x01
        XCTAssertThrowsError(try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: PushCrypto.b64url(bytes)))
    }

    func testTheButtonFieldsReplaceTheCiphertext() throws {
        let f = try fixture()
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: try scalar(f.recipient.d))
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        let merged = PushCrypto.merged(
            userInfo: ["e": f.envelope, "category": "fleet.prompt.allow"],
            opened: opened
        )
        XCTAssertNil(merged["e"])
        XCTAssertEqual(merged["category"] as? String, "fleet.prompt.allow")
        XCTAssertEqual(merged["promptId"] as? String, f.plaintext.data["promptId"])
        XCTAssertEqual(merged["answers"] as? String, f.plaintext.data["answers"])
        XCTAssertEqual(merged["sentAt"] as? String, f.plaintext.data["sentAt"])
        XCTAssertEqual(merged["name"] as? String, f.plaintext.data["name"])
    }
}
