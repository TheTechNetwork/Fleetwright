import CryptoKit
import XCTest

@testable import Fleetwright

/// `Seal.swift` against the message the minter's own code sealed.
///
/// `test/fixtures/parity/seal.json` is one message sealed by `src/fleet/seal.js`
/// with its random values written down; `test/seal-parity.test.js` opens it with
/// seal.js. Here the phone seals the same plaintext with the same values and
/// must produce the same ciphertext, which is the only way to know the minter
/// will open what this phone sends. And the phone opens the fixture as the
/// recipient, the direction the minter's answers travel. `SealTest.kt` does the
/// same on Android.
final class SealTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Key: Decodable { let d: String; let x: String; let y: String; let publicKey: String? }
        let recipient: Key
        let ephemeral: Key
        let aad: String
        let plaintext: String
        let sealed: [String: String]
    }

    private func fixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "seal", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "seal", withExtension: "json")
        else {
            XCTFail("parity/seal.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testSealsTheSameBytesAsTheMinter() throws {
        let f = try fixture()
        let ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: XCTUnwrap(Seal.unb64(f.ephemeral.d)))
        let nonce = try AES.GCM.Nonce(data: XCTUnwrap(Seal.unb64(XCTUnwrap(f.sealed["iv"]))))
        let ours = try Seal.seal(
            to: XCTUnwrap(f.recipient.publicKey),
            aad: f.aad,
            plaintext: Data(f.plaintext.utf8),
            ephemeral: ephemeral,
            nonce: nonce
        )
        XCTAssertEqual(ours["epk"], f.sealed["epk"])
        XCTAssertEqual(ours["iv"], f.sealed["iv"])
        XCTAssertEqual(ours["ct"], f.sealed["ct"])
    }

    func testOpensWhatTheMinterSealed() throws {
        let f = try fixture()
        let key = Seal.OneUseKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: XCTUnwrap(Seal.unb64(f.recipient.d))))
        XCTAssertEqual(key.publicKey, f.recipient.publicKey)
        let opened = try Seal.open(key, aad: f.aad, sealed: f.sealed)
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(f.plaintext.utf8)) as? NSDictionary)
        XCTAssertEqual(opened as NSDictionary, expected)
        // Bound to its purpose: the same bytes under another additional data do not open.
        XCTAssertThrowsError(try Seal.open(key, aad: "something else", sealed: f.sealed))
    }

    func testAKeyItMakesOpensWhatIsSealedToIt() throws {
        let key = Seal.newKey()
        let sealed = try Seal.seal(to: key.publicKey, aad: Seal.githubReplyAAD, payload: ["accessToken": "ghu_x"])
        XCTAssertEqual(try Seal.open(key, aad: Seal.githubReplyAAD, sealed: sealed)["accessToken"] as? String, "ghu_x")
    }
}
