import CryptoKit
import XCTest

@testable import Fleetwright

/// `XOSetupHandoff.open` against a token record sealed the way the machine
/// seals it: to the key this phone sent inside the sign-in, under
/// `fleetwright-xosetup-handoff/v1:<job>:<address>` (xosetupHandoffAad in
/// src/fleet/seal.js). The seal itself is held to seal.js by SealTests; what
/// is pinned here is the binding, and what the phone refuses to keep.
final class XOSetupHandoffTests: XCTestCase {

    private let job = "0123456789ab"
    private let address = "xo.lan"

    private func sealed(_ record: [String: Any], to key: Seal.OneUseKey, aad: String) throws -> String {
        let box = try Seal.seal(to: key.publicKey, aad: aad, payload: record)
        return "\(box["epk"] ?? "").\(box["iv"] ?? "").\(box["ct"] ?? "")"
    }

    private var record: [String: Any] {
        ["v": 1, "address": address, "pin": NSNull(), "plain": true, "user": "fleetwright", "token": "tok-limited-123"]
    }

    func testTheTokenOpensUnderItsOwnJobAndAddress() throws {
        let key = Seal.newKey()
        let handoff = try sealed(record, to: key, aad: Seal.xosetupHandoffAAD(job: job, address: address))
        let kept = try XCTUnwrap(XOSetupHandoff.open(handoff, job: job, address: address, key: key))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(kept.utf8)) as? [String: Any])
        XCTAssertEqual(object["token"] as? String, "tok-limited-123")
        XCTAssertEqual(object["address"] as? String, address)
    }

    func testASealedSignInIsNotATokenAndAnotherJobIsNotThisOne() throws {
        let key = Seal.newKey()
        let asSignIn = try sealed(record, to: key, aad: Seal.xosetupAAD(job: job, address: address))
        XCTAssertNil(XOSetupHandoff.open(asSignIn, job: job, address: address, key: key))
        let otherJob = try sealed(record, to: key, aad: Seal.xosetupHandoffAAD(job: "ba9876543210", address: address))
        XCTAssertNil(XOSetupHandoff.open(otherJob, job: job, address: address, key: key))
    }

    func testAnotherPhonesKeyOpensNothing() throws {
        let handoff = try sealed(record, to: Seal.newKey(), aad: Seal.xosetupHandoffAAD(job: job, address: address))
        XCTAssertNil(XOSetupHandoff.open(handoff, job: job, address: address, key: Seal.newKey()))
    }

    func testARecordForAnotherPoolOrWithNoTokenIsNotKept() throws {
        let key = Seal.newKey()
        let aad = Seal.xosetupHandoffAAD(job: job, address: address)
        var elsewhere = record
        elsewhere["address"] = "other.lan"
        XCTAssertNil(XOSetupHandoff.open(try sealed(elsewhere, to: key, aad: aad), job: job, address: address, key: key))
        var empty = record
        empty["token"] = ""
        XCTAssertNil(XOSetupHandoff.open(try sealed(empty, to: key, aad: aad), job: job, address: address, key: key))
    }
}
