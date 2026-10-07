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

    /// AN INSTALL'S RECORD names the Xen Orchestra it made, with the pool
    /// master the job began with beside it, and opens under the pool master.
    /// Naming some other pool master is not this job's.
    func testAnInstallsRecordNamesItsXenOrchestraAndThePoolMaster() throws {
        let key = Seal.newKey()
        let aad = Seal.xosetupHandoffAAD(job: job, address: "xcp1.lan")
        var installed = record
        installed["address"] = "192.168.1.50"
        installed["poolMaster"] = "xcp1.lan"
        let kept = try XCTUnwrap(XOSetupHandoff.open(try sealed(installed, to: key, aad: aad), job: job, address: "xcp1.lan", key: key))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(kept.utf8)) as? [String: Any])
        XCTAssertEqual(object["address"] as? String, "192.168.1.50")
        installed["poolMaster"] = "xcp2.lan"
        XCTAssertNil(XOSetupHandoff.open(try sealed(installed, to: key, aad: aad), job: job, address: "xcp1.lan", key: key))
    }

    /// What Machines lists under Hypervisors: the names the record carries,
    /// and nil, never an empty list, for a record that does not say.
    func testTheRecordsPoolNamesAreReadAndAMissingListIsNotNone() {
        let record = #"{"v":1,"address":"xo.lan","token":"t","pools":[{"id":"p1","name":"rack"},{"id":"0123456789","name":" "}]}"#
        XCTAssertEqual(XOSetupHandoff.poolNames(record), ["rack", "Unnamed pool 01234567"])
        XCTAssertNil(XOSetupHandoff.poolNames(#"{"v":1,"address":"xo.lan","token":"t"}"#))
        XCTAssertEqual(XOSetupHandoff.poolNames(#"{"pools":[]}"#), [])
    }
}
