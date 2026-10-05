import XCTest

@testable import Fleetwright

/// XOPolicy against inventories in the shape `inventoryOf` writes
/// (src/fleet/host/xo-setup.js), and choices held to what `checkPolicy` takes:
/// the screen offers Apply only when this says the machine would take it, so a
/// rule that drifted here would be a button that is refused, or a choice that
/// is never offered. The seal itself is held to seal.js by SealTests; what is
/// pinned here is the binding each half travels under.
final class XOPolicyTests: XCTestCase {

    private let job = "0123456789ab"
    private let address = "xo.lan"
    private let gib = XOPolicy.gib

    /// Two storage repositories (one shared), a VLAN network that is the way
    /// out now and a private one with no VLAN, sixteen cores and 64 GiB, and a
    /// resource set with only a CPU limit set. Sizes are bytes, as JSON numbers.
    private func inventoryJSON(limits: String = #"{"cpus":40,"memory":null,"disk":null}"#,
                               current srs: String = #"["sr-a"]"#,
                               networks: String = #"["net-wan"]"#,
                               address: String = "xo.lan") -> Data {
        Data("""
        {"v":1,"address":"\(address)",
         "pools":[{"id":"pool-1","name":"rack"}],
         "srs":[
           {"id":"sr-a","name":"Local storage","pool":"pool-1","size":\(500 * gib),"free":\(300 * gib),"shared":false},
           {"id":"sr-b","name":"","pool":"pool-1","size":\(2000 * gib),"free":\(1000 * gib),"shared":true}
         ],
         "networks":[
           {"id":"net-wan","name":"WAN","pool":"pool-1","vlan":20,"egress":true},
           {"id":"net-lab","name":"lab","pool":"pool-1","vlan":null,"egress":false}
         ],
         "capacity":{"cpus":16,"memory":\(64 * gib)},
         "current":{"srs":\(srs),"networks":\(networks),"limits":\(limits)}}
        """.utf8)
    }

    private func inventory(_ data: Data? = nil) throws -> XOPolicy.Inventory {
        try XCTUnwrap(XOPolicy.decode(data ?? inventoryJSON(), address: address))
    }

    // MARK: Decoding

    func testAnInventoryDecodesWithNoVLANAndLimitsThatAreNotSet() throws {
        let inv = try inventory()
        XCTAssertEqual(inv.srs.map(\.id), ["sr-a", "sr-b"])
        XCTAssertEqual(inv.srs[1].size, 2000 * gib)
        XCTAssertTrue(inv.srs[1].shared)
        XCTAssertEqual(inv.networks[0].vlan, 20)
        XCTAssertNil(inv.networks[1].vlan, "null is no VLAN, not VLAN 0")
        XCTAssertEqual(XOPolicy.vlan(inv.networks[1]), "no VLAN")
        XCTAssertEqual(inv.current.limits.cpus, 40)
        XCTAssertNil(inv.current.limits.memory, "null is not set, not zero")
        XCTAssertNil(inv.current.limits.disk)
    }

    func testANumberJavaScriptWroteWithAnExponentStillDecodes() throws {
        let text = String(decoding: inventoryJSON(), as: UTF8.self)
            .replacingOccurrences(of: "\"cpus\":16", with: "\"cpus\":1.6e1")
        XCTAssertEqual(try inventory(Data(text.utf8)).capacity.cpus, 16)
    }

    func testAnInventoryForAnotherAddressOrVersionIsRefused() {
        XCTAssertNil(XOPolicy.decode(inventoryJSON(address: "other.lan"), address: address))
        let v2 = String(decoding: inventoryJSON(), as: UTF8.self).replacingOccurrences(of: "\"v\":1", with: "\"v\":2")
        XCTAssertNil(XOPolicy.decode(Data(v2.utf8), address: address))
    }

    // MARK: Where the screen starts

    func testItStartsWhereThePoolIsAndClampsWhatIsPastIt() throws {
        let inv = try inventory()
        let c = XOPolicy.Choice.initial(for: inv)
        XCTAssertEqual(c.srs, ["sr-a"])
        XCTAssertEqual(c.networks, ["net-wan"])
        XCTAssertEqual(c.egress, "net-wan", "the network tagged as the way out, since it is chosen")
        XCTAssertEqual(c.cpus, 16, "a limit of 40 on a pool of 16 is held to 16")
        XCTAssertEqual(c.memoryGiB, 32, "not set: half the pool")
        XCTAssertEqual(c.diskGiB, 150, "not set: half the free space on the storage chosen")
        XCTAssertNil(c.problem(in: inv))
    }

    func testLimitsThatAreSetAreKeptAndAWayOutNotChosenIsNotPreselected() throws {
        let inv = try inventory(inventoryJSON(limits: #"{"cpus":4,"memory":8589934592,"disk":107374182400}"#,
                                              networks: #"["net-lab"]"#))
        let c = XOPolicy.Choice.initial(for: inv)
        XCTAssertEqual(c.cpus, 4)
        XCTAssertEqual(c.memoryGiB, 8)
        XCTAssertEqual(c.diskGiB, 100)
        XCTAssertNil(c.egress, "the tagged network is not one the fleet may use, so it cannot be the way out")
    }

    func testIdsThePoolNoLongerListsAreDropped() throws {
        let inv = try inventory(inventoryJSON(current: #"["sr-gone","sr-b"]"#))
        XCTAssertEqual(XOPolicy.Choice.initial(for: inv).srs, ["sr-b"])
    }

    // MARK: The machine's rules

    func testNoStorageIsRefusedInTheMachinesWords() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.setStorage("sr-a", on: false, in: inv)
        XCTAssertEqual(c.problem(in: inv), "Choose at least one storage repository: a VM needs somewhere for its disk.")
    }

    func testTurningStorageOffHoldsDiskInsideWhatIsLeft() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.setStorage("sr-b", on: true, in: inv)
        c.diskGiB = 2400
        XCTAssertNil(c.problem(in: inv))
        c.setStorage("sr-b", on: false, in: inv)
        XCTAssertEqual(c.diskGiB, 500, "the size of the storage still chosen")
        XCTAssertEqual(inv.diskRange(for: c.srs), 10...500)
    }

    func testTheWayOutGoesWithItsNetwork() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.setNetwork("net-wan", on: false)
        XCTAssertNil(c.egress)
        XCTAssertNil(c.problem(in: inv))
    }

    func testEachLimitIsHeldToTheMachinesBounds() throws {
        let inv = try inventory()
        XCTAssertEqual(inv.cpuRange, 1...16)
        XCTAssertEqual(inv.memoryRange, 1...64)
        var c = XOPolicy.Choice.initial(for: inv)
        c.cpus = 17
        XCTAssertEqual(c.problem(in: inv), "vCPUs are between 1 and 16, what the pool has.")
        c = XOPolicy.Choice.initial(for: inv)
        c.memoryGiB = 0
        XCTAssertEqual(c.problem(in: inv), "Memory is between 1 GiB and 64 GiB, what the pool has.")
        c = XOPolicy.Choice.initial(for: inv)
        c.diskGiB = 9
        XCTAssertEqual(c.problem(in: inv), "Disk is between 10 GiB and 500 GiB, the size of the storage chosen.")
        c = XOPolicy.Choice.initial(for: inv)
        c.egress = "net-lab"
        XCTAssertEqual(c.problem(in: inv), "The way out has to be one of the networks the fleet may use.")
        c = XOPolicy.Choice.initial(for: inv)
        c.networks.insert("net-elsewhere")
        XCTAssertEqual(c.problem(in: inv), "That names storage or a network this pool did not list.")
    }

    func testAPoolThatReportsNothingStillHasTheSmallestLimits() throws {
        let text = String(decoding: inventoryJSON(), as: UTF8.self)
            .replacingOccurrences(of: "\"capacity\":{\"cpus\":16,\"memory\":\(64 * gib)}", with: "\"capacity\":{\"cpus\":0,\"memory\":0}")
        let inv = try inventory(Data(text.utf8))
        XCTAssertEqual(inv.cpuRange, 1...1)
        XCTAssertEqual(inv.memoryRange, 1...1)
        XCTAssertNil(XOPolicy.Choice.initial(for: inv).problem(in: inv))
    }

    // MARK: What is sealed

    func testThePayloadIsCheckPolicysInputInBytes() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.setStorage("sr-b", on: true, in: inv)
        c.setNetwork("net-lab", on: true)
        let data = try JSONSerialization.data(withJSONObject: c.payload(in: inv))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["srs"] as? [String], ["sr-a", "sr-b"], "in the inventory's order")
        XCTAssertEqual(object["networks"] as? [String], ["net-wan", "net-lab"])
        XCTAssertEqual(object["egress"] as? String, "net-wan")
        let limits = try XCTUnwrap(object["limits"] as? [String: Any])
        XCTAssertEqual(limits["cpus"] as? Int, 16)
        XCTAssertEqual((limits["memory"] as? NSNumber)?.int64Value, 32 * gib)
        XCTAssertEqual((limits["disk"] as? NSNumber)?.int64Value, 150 * gib)
        XCTAssertEqual(Set(object.keys), ["v", "srs", "networks", "egress", "limits"])
    }

    func testNoWayOutIsSentAsNull() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.egress = nil
        let data = try JSONSerialization.data(withJSONObject: c.payload(in: inv))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""egress":null"#))
    }

    // MARK: The bindings

    func testEachHalfTravelsUnderItsOwnName() {
        XCTAssertEqual(Seal.xosetupInventoryAAD(job: "J", address: "A"), "fleetwright-xosetup-inventory/v1:J:A")
        XCTAssertEqual(Seal.xosetupPolicyAAD(job: "J", address: "A"), "fleetwright-xosetup-policy/v1:J:A")
    }

    func testTheInventoryOpensOnlyUnderItsJobItsAddressAndThisKey() throws {
        let key = Seal.newKey()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: inventoryJSON()) as? [String: Any])
        func sealed(_ aad: String, to: Seal.OneUseKey) throws -> String {
            let box = try Seal.seal(to: to.publicKey, aad: aad, payload: object)
            return "\(box["epk"] ?? "").\(box["iv"] ?? "").\(box["ct"] ?? "")"
        }
        let good = try sealed(Seal.xosetupInventoryAAD(job: job, address: address), to: key)
        XCTAssertEqual(XOPolicy.open(good, job: job, address: address, key: key)?.srs.count, 2)
        XCTAssertNil(XOPolicy.open(good, job: "ba9876543210", address: address, key: key))
        XCTAssertNil(XOPolicy.open(good, job: job, address: address, key: Seal.newKey()))
        let asToken = try sealed(Seal.xosetupHandoffAAD(job: job, address: address), to: key)
        XCTAssertNil(XOPolicy.open(asToken, job: job, address: address, key: key), "a sealed token is not an inventory")
    }

    // MARK: Words

    func testSizesAndEndsReadAsTheyShould() throws {
        let inv = try inventory()
        XCTAssertEqual(XOPolicy.room(inv.srs[0]), "300 GiB free of 500 GiB")
        XCTAssertEqual(XOPolicy.title(inv.srs[1].name, id: inv.srs[1].id), "Unnamed, sr-b")
        let done = XOSetupAttributes.ContentState(step: 5, of: 5, phase: "done", state: "done")
        XCTAssertEqual(XOPolicy.statusLine(done), "What the fleet may use is changed", "not \"Hypervisor added\"")
        let applying = XOSetupAttributes.ContentState(step: 4, of: 5, phase: "apply", state: "running")
        XCTAssertEqual(XOPolicy.statusLine(applying), "Applying what you chose")
    }
}
