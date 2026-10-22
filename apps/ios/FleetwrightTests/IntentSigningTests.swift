import CryptoKit
import XCTest

@testable import Fleetwright

/// `DeviceSigning.swift` against the bytes a box checks.
///
/// `test/fixtures/parity/intent-signing.json` holds intents and the signing
/// input src/fleet/protocol/intent-signature.js builds for each;
/// `test/intent-signing-parity.test.js` keeps the file what that function makes.
/// Here the phone builds the same strings from the same intents, which is the
/// only way to know a box will take what this phone signs: its cases are where
/// a JSON encoder that is not JavaScript's writes different bytes.
/// `IntentSigningTest.kt` does the same on Android.
final class IntentSigningTests: XCTestCase {

    private func fixture() throws -> [String: Any] {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "intent-signing", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "intent-signing", withExtension: "json")
        else {
            XCTFail("parity/intent-signing.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func testBuildsTheBytesTheBoxChecks() throws {
        let cases = try XCTUnwrap(fixture()["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 8, "the fixture lost its cases")
        for c in cases {
            let intent = try XCTUnwrap(c["intent"] as? [String: Any])
            let made = IntentSigning.input(
                actor: try XCTUnwrap(intent["actor"] as? String),
                id: try XCTUnwrap(intent["id"] as? String),
                issuedAt: try XCTUnwrap((intent["issuedAt"] as? NSNumber)?.intValue),
                params: try XCTUnwrap(intent["params"] as? [String: Any]),
                verb: try XCTUnwrap(intent["verb"] as? String),
                host: try XCTUnwrap(c["host"] as? String)
            )
            XCTAssertEqual(made, c["input"] as? String, c["why"] as? String ?? "")
        }
    }

    func testNamesItsKeyAsTheMinterFilesIt() throws {
        let key = try XCTUnwrap(fixture()["key"] as? [String: Any])
        let jwk = try XCTUnwrap(key["jwk"] as? [String: String])
        XCTAssertEqual(DeviceKey.kid(x: try XCTUnwrap(jwk["x"]), y: try XCTUnwrap(jwk["y"])), key["kid"] as? String)
    }

    /// The signature is r || s in base64url, the form crypto.js `verify` takes,
    /// and it verifies under the key's own public half. A DER signature, which
    /// is what most libraries hand back, would be refused by every box.
    func testSignsInTheFormABoxVerifies() throws {
        let (key, raw) = DeviceKey.software()
        let message = IntentSigning.input(actor: "nina@example.test", id: "app-0001", issuedAt: 1, params: ["name": "build"], verb: "start", host: "ops-box")
        let sig = try key.sign(message)
        XCTAssertEqual(sig.count, 86)
        XCTAssertNil(sig.firstIndex(where: { !($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }))
        let publicKey = try P256.Signing.PrivateKey(rawRepresentation: raw).publicKey
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(Seal.unb64(sig)))
        XCTAssertTrue(publicKey.isValidSignature(signature, for: Data(message.utf8)))
        XCTAssertFalse(publicKey.isValidSignature(signature, for: Data((message + " ").utf8)))
        // And the JWK it lists is that key's.
        XCTAssertEqual(Seal.unb64(key.x).map { $0 + (Seal.unb64(key.y) ?? Data()) }, publicKey.rawRepresentation)
    }
}
