import CryptoKit
import XCTest

@testable import Fleetwright

/// `EngineSignin.verified` against an answer a machine's own code sealed and
/// signed.
///
/// `test/fixtures/parity/engine-signin-answer.json` holds one answer to an
/// engine's sign-in as a phone is sent it: sealed to a key whose private half
/// is written there, carrying the machine's key and its signature. A seal
/// and an ECDSA signature come out different every time, so neither can be
/// made again here. What this shows is that the phone opens that answer,
/// accepts it, and refuses it once anything a person would be shown, or
/// anything that ties it to the request, is changed. `EngineSignInTest.kt`
/// does the same on Android.
///
/// WHAT IS PINNED is the order a code is reached by: opened with the
/// request's own key, then the key held to a grant for the whole vault under
/// the machine that was asked, then the signature over the request's own id,
/// member and engine. Each test fails one step and expects the answer for
/// that step and no code.
final class EngineSignInTests: XCTestCase {

    private struct Vector {
        let key: Seal.OneUseKey
        let sealed: [String: String]
        let opened: [String: Any]
        let keyId: String
        let signingInput: String
        let changed: [[String: Any]]
        var id: String { opened["id"] as? String ?? "" }
        var member: String { opened["member"] as? String ?? "" }
        var engine: String { opened["engine"] as? String ?? "" }
    }

    private func whole() throws -> [String: Any] {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "engine-signin-answer", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "engine-signin-answer", withExtension: "json")
        else {
            XCTFail("parity/engine-signin-answer.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func vector() throws -> Vector {
        let part = try XCTUnwrap(try whole()["sealed"] as? [String: Any])
        let recipient = try XCTUnwrap(part["recipient"] as? [String: String])
        let secret = try XCTUnwrap(Seal.unb64(try XCTUnwrap(recipient["d"])))
        let key = Seal.OneUseKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: secret))
        XCTAssertEqual(key.publicKey, recipient["publicKey"])
        return Vector(
            key: key,
            sealed: try XCTUnwrap(part["sealed"] as? [String: String]),
            opened: try XCTUnwrap(part["opened"] as? [String: Any]),
            keyId: try XCTUnwrap(part["host"] as? String),
            signingInput: try XCTUnwrap(part["signingInput"] as? String),
            changed: try XCTUnwrap(part["changed"] as? [[String: Any]])
        )
    }

    /// The grant a custodian made for the machine that answered: the whole
    /// vault, under the name it was asked by.
    private func grant(_ v: Vector, label: String = "ops-box", only: [String] = []) -> PhoneVault.Grant {
        PhoneVault.Grant(key: v.keyId, fingerprint: String(v.keyId.prefix(16)), label: label, email: "eli@example.com", only: only)
    }

    private func check(_ v: Vector, sealed: [String: String]?, key: Seal.OneUseKey? = nil, grants: [PhoneVault.Grant]? = nil,
                       host: String = "ops-box", id: String? = nil, member: String? = nil, engine: String? = nil) -> EngineSigninCheck {
        EngineSignin.verified(sealed: sealed, key: key ?? v.key, grants: grants ?? [grant(v)], host: host,
                              id: id ?? v.id, member: member ?? v.member, engine: engine ?? v.engine)
    }

    func testAnAnswerThatPassesEveryCheckGivesTheCodeItsPageAndWhoIsSignedIn() throws {
        let v = try vector()
        let there = try XCTUnwrap(v.opened["signedIn"] as? [String: Any])
        let who = try XCTUnwrap(there["who"] as? [String: Any])
        let expected = EngineSigninSaid(
            code: v.opened["code"] as? String,
            page: v.opened["url"] as? String,
            signedIn: EngineSignedIn(since: try XCTUnwrap((there["since"] as? NSNumber)?.doubleValue),
                                     email: who["email"] as? String, plan: who["plan"] as? String)
        )
        XCTAssertNotNil(expected.code)
        XCTAssertNotNil(expected.page)
        XCTAssertEqual(check(v, sealed: v.sealed), .verified(expected))
    }

    func testAnAnswerWithNothingSealedOrSealedToAnotherKeyIsNotOpened() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: nil), .unopened)
        XCTAssertEqual(check(v, sealed: v.sealed, key: Seal.newKey()), .unopened)
        // Bound to its purpose: a vault's answer is not a machine's.
        XCTAssertThrowsError(try Seal.open(v.key, aad: Seal.vaultReplyAAD, sealed: v.sealed))
        XCTAssertNoThrow(try Seal.open(v.key, aad: Seal.engineSigninAAD, sealed: v.sealed))
    }

    func testOnlyAGrantForTheWholeVaultUnderTheMachineThatWasAskedCounts() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: v.sealed, grants: []), .unapproved)
        XCTAssertEqual(check(v, sealed: v.sealed, grants: [grant(v, only: ["codex"])]), .unapproved)
        XCTAssertEqual(check(v, sealed: v.sealed, grants: [grant(v, label: "other-box")]), .unapproved)
        // The right grant, and another machine was asked.
        XCTAssertEqual(check(v, sealed: v.sealed, host: "other-box"), .unapproved)
    }

    func testTheSignatureIsOverThisPhonesOwnRequest() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: v.sealed, id: v.id + "0"), .unsigned)
        XCTAssertEqual(check(v, sealed: v.sealed, member: "jason"), .unsigned)
        XCTAssertEqual(check(v, sealed: v.sealed, engine: "opencode"), .unsigned)
    }

    /// The bytes the machine signed, built the way `verified` builds them,
    /// and every change the vector lists refused under the machine's key.
    func testTheSignedBytesAreTheMachinesAndEveryChangeBreaksThem() throws {
        let v = try vector()
        let jwk = try XCTUnwrap(v.opened["hostKey"] as? [String: String])
        let hostKey = Fleet.Host.PublicKey(kty: try XCTUnwrap(jwk["kty"]), crv: try XCTUnwrap(jwk["crv"]),
                                           x: try XCTUnwrap(jwk["x"]), y: try XCTUnwrap(jwk["y"]))
        XCTAssertEqual(PhoneVault.keyHash(hostKey), v.keyId)
        let signature = try XCTUnwrap(v.opened["signature"] as? String)
        var signed = v.opened
        signed.removeValue(forKey: "hostKey")
        signed.removeValue(forKey: "signature")
        XCTAssertEqual(IntentSigning.signingInput("engine-signin-answer", signed), v.signingInput)
        XCTAssertTrue(XOSetupKey.holds(v.signingInput, sig: signature, hostKey: hostKey))
        XCTAssertFalse(v.changed.isEmpty)
        for change in v.changed {
            let field = try XCTUnwrap(change["field"] as? String)
            var other = signed
            other[field] = change["value"] ?? NSNull()
            XCTAssertFalse(XOSetupKey.holds(IntentSigning.signingInput("engine-signin-answer", other), sig: signature, hostKey: hostKey),
                           "a changed \(field) still passed")
        }
    }

    /// The answer an MCP client is sent, in the clear, has no `signedIn` key
    /// at all: the same encoder writes its bytes too.
    func testTheClearAnswersBytesAreTheMachinesToo() throws {
        let f = try whole()
        let jwk = try XCTUnwrap(f["hostKey"] as? [String: String])
        let hostKey = Fleet.Host.PublicKey(kty: try XCTUnwrap(jwk["kty"]), crv: try XCTUnwrap(jwk["crv"]),
                                           x: try XCTUnwrap(jwk["x"]), y: try XCTUnwrap(jwk["y"]))
        let context = try XCTUnwrap(f["context"] as? String)
        let input = IntentSigning.signingInput(context, try XCTUnwrap(f["payload"] as? [String: Any]))
        XCTAssertEqual(input, f["signingInput"] as? String)
        XCTAssertTrue(XOSetupKey.holds(input, sig: try XCTUnwrap(f["signature"] as? String), hostKey: hostKey))
    }
}
