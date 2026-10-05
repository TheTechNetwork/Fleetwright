import CryptoKit
import XCTest

@testable import Fleetwright

/// `XOSetupKey` against a key signed the way the machine signs it: ECDSA
/// P-256 over `signingInput('xosetup-key', {address, job, key, pin})` in
/// src/fleet/host/xo-setup.js, whose canonical JSON is written out here by
/// hand so the phone and the host cannot drift apart without this failing.
///
/// WHAT IS PINNED is the pin's place in the bytes. Over plain HTTP there is
/// no certificate, and the machine signs over an empty pin: `"pin":""`, the
/// key still present. A phone that left the key out, or that refused the
/// empty string at the door, would refuse every plain setup; a phone that
/// did not put the pin in the bytes would let a key signed for a plain setup
/// pass for a pinned one.
final class XOSetupKeyTests: XCTestCase {

    private let job = "0123456789ab"
    private let address = "xo.lan"
    private let somePin = String(repeating: "ab", count: 32)
    /// A job key as the machine would make it: the x963 point, base64url.
    private let jobKey = Seal.b64(P256.KeyAgreement.PrivateKey().publicKey.x963Representation)

    private struct Machine {
        let signer = P256.Signing.PrivateKey()
        var publicKey: Fleet.Host.PublicKey {
            let raw = signer.publicKey.x963Representation
            return Fleet.Host.PublicKey(kty: "EC", crv: "P-256", x: Seal.b64(Data(raw.dropFirst().prefix(32))), y: Seal.b64(Data(raw.suffix(32))))
        }
        func sign(_ input: String) throws -> String {
            Seal.b64(try signer.signature(for: Data(input.utf8)).rawRepresentation)
        }
    }

    private func input(pin: String) -> String {
        XOSetupKey.signingPrefix + "{\"address\":\"\(address)\",\"job\":\"\(job)\",\"key\":\"\(jobKey)\",\"pin\":\"\(pin)\"}"
    }

    func testAPlainSetupIsSignedOverAnEmptyPin() throws {
        let machine = Machine()
        let sig = try machine.sign(input(pin: ""))
        XCTAssertTrue(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: ""))
        // The same key, claimed for a pinned setup: the pin is in the bytes.
        XCTAssertFalse(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: somePin))
    }

    func testTheEmptyPinIsInTheBytesNotLeftOut() throws {
        let machine = Machine()
        let withoutPin = XOSetupKey.signingPrefix + "{\"address\":\"\(address)\",\"job\":\"\(job)\",\"key\":\"\(jobKey)\"}"
        let sig = try machine.sign(withoutPin)
        XCTAssertFalse(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: ""))
    }

    func testAPinnedSetupStillNeedsItsPin() throws {
        let machine = Machine()
        let sig = try machine.sign(input(pin: somePin))
        XCTAssertTrue(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: somePin))
        XCTAssertFalse(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: ""))
        // Only a fingerprint or nothing: anything else is malformed, and false.
        XCTAssertFalse(XOSetupKey.isSigned(key: jobKey, keySig: sig, hostKey: machine.publicKey, address: address, job: job, pin: "abc"))
    }
}
