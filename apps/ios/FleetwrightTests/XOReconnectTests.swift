import XCTest

@testable import Fleetwright

/// Reconnecting a pool's servers (XOReconnect), run rather than read: what
/// the machine seals back opens only under its own binding, what each server
/// went through reads as what happened to it, and the pool's page offers the
/// reconnect only when what it loaded calls for one. The seal itself is held
/// to seal.js by SealTests; the binding's text by
/// test/xoreconnect-ios-in-apps.test.js.
final class XOReconnectTests: XCTestCase {

    private let job = "0123456789ab"
    private let address = "xo.lan"

    private func sealed(_ payload: [String: Any], to key: Seal.OneUseKey, aad: String) throws -> String {
        let box = try Seal.seal(to: key.publicKey, aad: aad, payload: payload)
        return "\(box["epk"] ?? "").\(box["iv"] ?? "").\(box["ct"] ?? "")"
    }

    private var payload: [String: Any] {
        [
            "v": 1,
            "servers": [
                ["label": "xcp1", "host": "192.168.1.10", "before": "connected", "enabled": true, "after": "connected", "action": "left"],
                ["label": "xcp2", "host": "192.168.1.11", "before": "disconnected", "enabled": true, "after": "connected", "action": "enabled"],
                ["label": "", "host": "192.168.1.12", "before": "disconnected", "enabled": false, "after": "disconnected", "action": "skipped-disabled"],
            ],
            "pools": [["id": "pool-1", "name": "Home"]],
        ]
    }

    // MARK: - what comes back

    func testTheOutcomeOpensUnderItsOwnJobAndAddress() throws {
        let key = Seal.newKey()
        let result = try sealed(payload, to: key, aad: Seal.xosetupReconnectAAD(job: job, address: address))
        let outcome = try XCTUnwrap(XOReconnect.open(result, job: job, address: address, key: key))
        XCTAssertEqual(outcome.servers.map(\.action), ["left", "enabled", "skipped-disabled"])
        XCTAssertEqual(outcome.pools?.map(XOReconnect.poolName), ["Home"])
    }

    func testASignInAnInventoryOrAnotherJobIsNotAnOutcome() throws {
        let key = Seal.newKey()
        for aad in [Seal.xosetupAAD(job: job, address: address),
                    Seal.xosetupInventoryAAD(job: job, address: address),
                    Seal.xosetupReconnectAAD(job: "ba9876543210", address: address),
                    Seal.xosetupReconnectAAD(job: job, address: "other.lan")] {
            XCTAssertNil(XOReconnect.open(try sealed(payload, to: key, aad: aad), job: job, address: address, key: key), aad)
        }
        // And another phone's key opens nothing.
        let elsewhere = try sealed(payload, to: Seal.newKey(), aad: Seal.xosetupReconnectAAD(job: job, address: address))
        XCTAssertNil(XOReconnect.open(elsewhere, job: job, address: address, key: key))
    }

    func testAVersionThisBuildDoesNotKnowIsNotRead() throws {
        var newer = payload
        newer["v"] = 2
        XCTAssertNil(XOReconnect.decode(try JSONSerialization.data(withJSONObject: newer)))
    }

    func testPoolsTheMachineDidNotMentionAreNotNoPools() throws {
        // Unsaid is cannot tell, and is said as that (C-5); an empty list is
        // a Xen Orchestra that shows none.
        var unsaid = payload
        unsaid["pools"] = nil
        let quiet = try XCTUnwrap(XOReconnect.decode(try JSONSerialization.data(withJSONObject: unsaid)))
        XCTAssertNil(quiet.pools)
        XCTAssertEqual(XOReconnect.noPools(quiet.pools), "The machine did not say which pools Xen Orchestra shows now.")
        XCTAssertEqual(XOReconnect.noPools([]), "Xen Orchestra shows no pools yet.")
        XCTAssertNil(XOReconnect.noPools([.init(id: "pool-1", name: "Home")]))
    }

    // MARK: - what happened to each server

    private func server(_ action: String, before: String? = nil, after: String? = nil, error: String? = nil,
                        label: String? = "xcp1", host: String? = "192.168.1.10") -> XOReconnect.Outcome.Server {
        .init(label: label, host: host, before: before, enabled: true, after: after, action: action, error: error)
    }

    func testEachServerReadsAsWhatWasDoneToItAndHowItIsNow() {
        XCTAssertEqual(XOReconnect.line(server("left", before: "connected", after: "connected")),
                       "Connected already, so it was left as it was.")
        XCTAssertEqual(XOReconnect.line(server("enabled", before: "disconnected", after: "connected")),
                       "It was disconnected, so it was connected again. It is connected now.")
        XCTAssertEqual(XOReconnect.line(server("cycled", before: "connecting", after: "connecting")),
                       "It was stuck connecting, so it was disconnected and connected again. It is still connecting.")
        XCTAssertEqual(XOReconnect.line(server("cycled", before: "connected", after: "connected")),
                       "It was connected with an error, so it was disconnected and connected again. It is connected now.")
        XCTAssertEqual(XOReconnect.line(server("skipped-disabled", before: "disconnected", after: "disconnected")),
                       "It is turned off in Xen Orchestra, so it was left off. Only a person turns a server back on.")
        XCTAssertEqual(XOReconnect.line(server("failed", error: "PoolAlreadyConnected")),
                       "It did not reconnect: PoolAlreadyConnected.")
        XCTAssertEqual(XOReconnect.line(server("failed", error: " ")), "It did not reconnect: Xen Orchestra did not say why.")
    }

    func testHowItIsNowIsNeverGuessed() {
        XCTAssertEqual(XOReconnect.line(server("enabled", before: "disconnected", after: nil)),
                       "It was disconnected, so it was connected again. Xen Orchestra did not say how it is now.")
        // A word a newer machine knows still says how the server is.
        XCTAssertEqual(XOReconnect.line(server("rebooted", after: "connected")), "It is connected now.")
    }

    func testOnlyAFailureSpendsATone() {
        XCTAssertTrue(XOReconnect.failed(server("failed")))
        for action in ["left", "enabled", "cycled", "skipped-disabled"] {
            XCTAssertFalse(XOReconnect.failed(server(action)), action)
        }
    }

    func testAServerIsNamedByItsLabelThenItsAddress() {
        XCTAssertEqual(XOReconnect.title(server("left")), "xcp1")
        XCTAssertEqual(XOReconnect.address(server("left")), "192.168.1.10")
        let unlabelled = server("left", label: "  ")
        XCTAssertEqual(XOReconnect.title(unlabelled), "192.168.1.10")
        XCTAssertNil(XOReconnect.address(unlabelled), "the address is not said twice")
        XCTAssertEqual(XOReconnect.title(server("left", label: nil, host: nil)), "A server with no name")
    }

    // MARK: - when the pool's page offers it

    private func snapshot(pools: [String]) -> Manage.Snapshot {
        var s = Manage.Snapshot()
        for (i, name) in pools.enumerated() {
            s.enter(["type": "pool", "id": "pool-\(i)", "name_label": name])
        }
        s.enter(["type": "host", "id": "host-1", "name_label": "xcp1", "power_state": "Running", "$pool": "pool-0"])
        return s
    }

    func testNothingIsOfferedBeforeThePageHasLoaded() {
        XCTAssertFalse(Manage.offersReconnect(loaded: false, held: ["Home"], in: Manage.Snapshot()))
    }

    func testOfferedWhenXenOrchestraShowsNoPool() {
        XCTAssertTrue(Manage.offersReconnect(loaded: true, held: ["Home"], in: Manage.Snapshot()))
        // A record that named none, or did not say, still has no pool shown.
        XCTAssertTrue(Manage.offersReconnect(loaded: true, held: nil, in: snapshot(pools: [])))
    }

    func testOfferedWhenAPoolSetupNamedIsMissing() {
        let s = snapshot(pools: ["Home"])
        XCTAssertEqual(Manage.missingPools(held: ["Home", "Lab"], in: s), ["Lab"])
        XCTAssertTrue(Manage.offersReconnect(loaded: true, held: ["Home", "Lab"], in: s))
    }

    func testNotOfferedWhenEverythingSetupNamedIsThere() {
        let s = snapshot(pools: ["Home", "Lab"])
        XCTAssertFalse(Manage.offersReconnect(loaded: true, held: ["Home", "Lab"], in: s))
        // A record that did not say names nothing to miss.
        XCTAssertEqual(Manage.missingPools(held: nil, in: s), [])
        XCTAssertFalse(Manage.offersReconnect(loaded: true, held: nil, in: s))
    }

    func testAnUnnamedPoolMatchesTheWordsItsRecordWasKeptIn() {
        // The kept record names a pool with no name by the start of its id
        // (XOSetupHandoff.poolNames), and the page names it the same way, so
        // it is not taken for missing.
        var s = Manage.Snapshot()
        s.enter(["type": "pool", "id": "0123456789abcdef"])
        let record = #"{"pools":[{"id":"0123456789abcdef","name":""}]}"#
        let held = XOSetupHandoff.poolNames(record)
        XCTAssertEqual(held, ["Unnamed pool 01234567"])
        XCTAssertFalse(Manage.offersReconnect(loaded: true, held: held, in: s))
    }
}
