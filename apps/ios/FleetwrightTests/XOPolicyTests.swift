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
                               address: String = "xo.lan",
                               edges: String? = nil,
                               images: String? = nil,
                               imageKinds: String? = nil) -> Data {
        let tail = (edges.map { ",\"edges\":" + $0 } ?? "") + (images.map { ",\"images\":" + $0 } ?? "")
            + (imageKinds.map { ",\"imageKinds\":" + $0 } ?? "")
        return Data("""
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
         "current":{"srs":\(srs),"networks":\(networks),"limits":\(limits)}\(tail)}
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

    // MARK: The edge router

    func testAnOlderMachineSaysNothingAboutEdgeRoutersAndThatIsNotNone() throws {
        let inv = try inventory()
        XCTAssertNil(inv.edges, "an inventory without edges is cannot tell, not none")
        XCTAssertFalse(XOPolicy.Choice.initial(for: inv).edge)
    }

    func testTheSwitchStartsOnWhenThePoolHasOneSoApplyKeepsIt() throws {
        let inv = try inventory(inventoryJSON(edges: #"[{"pool":"pool-1","running":false}]"#))
        XCTAssertEqual(inv.edge(on: "net-wan")?.running, false)
        XCTAssertTrue(XOPolicy.Choice.initial(for: inv).edge)
        let none = try inventory(inventoryJSON(edges: "[]"))
        XCTAssertFalse(XOPolicy.Choice.initial(for: none).edge)
    }

    func testTheEdgeRouterGoesWithItsWayOut() throws {
        let inv = try inventory(inventoryJSON(edges: "[]"))
        var c = XOPolicy.Choice.initial(for: inv)
        c.edge = true
        XCTAssertNil(c.problem(in: inv))
        c.setNetwork("net-wan", on: false)
        XCTAssertNil(c.egress)
        XCTAssertFalse(c.edge, "a router with no way out was left asked for")
        c.edge = true
        XCTAssertEqual(c.problem(in: inv), "The edge router needs a way out: choose the network its WAN goes on.")
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

    /// Asked for: a way out that is not one of the fleet's networks. A
    /// machine that takes that keeps the way out when its network goes off,
    /// starts with it where Xen Orchestra's tag is, and sends it.
    func testOnAMachineThatTakesAnyNetworkTheWayOutNeedNotBeTheFleets() throws {
        let inv = try inventory(inventoryJSON(networks: #"["net-lab"]"#))
        XCTAssertNil(XOPolicy.Choice.initial(for: inv).egress, "an older machine would refuse the WAN, so it is not chosen")
        var c = XOPolicy.Choice.initial(for: inv, anyWayOut: true)
        XCTAssertEqual(c.egress, "net-wan", "the tagged network, though the fleet may not use it")
        c.setNetwork("net-lab", on: false)
        c.setNetwork("net-lab", on: true)
        XCTAssertEqual(c.egress, "net-wan")
        XCTAssertNil(c.problem(in: inv))
        XCTAssertEqual(c.payload(in: inv)["egress"] as? String, "net-wan")
        XCTAssertEqual(c.payload(in: inv)["networks"] as? [String], ["net-lab"])
        c.egress = "net-elsewhere"
        XCTAssertEqual(c.problem(in: inv), "The way out has to be a network this pool listed.")
    }

    /// Asked for: "which disk did it put it on?" The router's disk goes on
    /// the storage picked, any in the way out's pool with room; unpicked, the
    /// fleet's there with the most room; and it is sent only to a machine
    /// that reads it.
    func testTheRoutersDiskGoesWhereItIsPickedAndIsSentOnlyToAMachineThatReadsIt() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.edge = true
        XCTAssertEqual(inv.edgeDisks(for: "net-wan").map(\.id), ["sr-a", "sr-b"])
        XCTAssertEqual(c.edgeDisk(in: inv), "sr-a", "the fleet's storage first, though sr-b has more room")
        XCTAssertNil(c.payload(in: inv)["edgeSr"], "an older machine is not sent it")
        c.edgeDiskChoice = true
        XCTAssertEqual(c.payload(in: inv)["edgeSr"] as? String, "sr-a")
        c.edgeSr = "sr-b"
        XCTAssertEqual(c.payload(in: inv)["edgeSr"] as? String, "sr-b", "the pick, though the fleet may not use it")
        c.edgeSr = "sr-gone"
        XCTAssertEqual(c.edgeDisk(in: inv), "sr-a", "a pick that no longer fits falls back")
        XCTAssertNil(c.problem(in: inv))
    }

    /// Asked for: "Still can't run sessions on it". The machine image is
    /// offered by a machine that builds one, is built behind the edge router
    /// (asked for with it, or there already), needs 20 GiB for its disk, and
    /// is sent only to a machine that reads it.
    func testTheMachineImageNeedsTheRouterAndRoomAndIsSentOnlyWhenItCanBeBuilt() throws {
        let inv = try inventory()
        var c = XOPolicy.Choice.initial(for: inv)
        c.edgeDiskChoice = true
        c.image = true
        XCTAssertNil(c.payload(in: inv)["image"], "an older machine is not sent it")
        c.imageChoice = true
        XCTAssertEqual(c.problem(in: inv), "The machine image is built behind the edge router, and that pool has none yet. Build the router with it.")
        c.edge = true
        XCTAssertNil(c.problem(in: inv))
        XCTAssertEqual(c.payload(in: inv)["image"] as? Bool, true)
        XCTAssertEqual(c.diskNeed(in: inv), XOPolicy.imageDiskBytes)
        XCTAssertEqual(c.payload(in: inv)["edgeSr"] as? String, "sr-a")

        // A pool with its router already: the image alone, and its disk still asked.
        let routed = try inventory(inventoryJSON(edges: #"[{"pool":"pool-1","running":true}]"#))
        var r = XOPolicy.Choice.initial(for: routed)
        r.edge = false
        r.imageChoice = true
        r.edgeDiskChoice = true
        r.image = true
        XCTAssertNil(r.problem(in: routed))
        XCTAssertEqual(r.building(in: routed).image, true)
        XCTAssertEqual(r.building(in: routed).edge, false)

        // One already there is not built again, and says so.
        let imaged = try inventory(inventoryJSON(edges: #"[{"pool":"pool-1","running":true}]"#, images: #"[{"pool":"pool-1","name":"Fleetwright Debian 13"}]"#))
        XCTAssertEqual(imaged.image(on: "net-wan")?.name, "Fleetwright Debian 13")
        var i = XOPolicy.Choice.initial(for: imaged)
        i.imageChoice = true
        i.image = true
        XCTAssertEqual(i.building(in: imaged).image, false)
        XCTAssertNil(try inventory().images, "an older machine says nothing about images, which is not none")
    }

    /// Asked for: "os selection not just Debian". A machine that builds its
    /// whole catalogue is sent the images chosen, in its own order, and only
    /// the ones its pool does not have are built; an older one is sent
    /// `image` alone, as before.
    func testImagesAreChosenByOperatingSystemAndOnlyTheMissingOnesAreBuilt() throws {
        let kinds = #"[{"key":"debian-13","os":"Debian 13"},{"key":"ubuntu-24.04","os":"Ubuntu 24.04 LTS"},{"key":"ubuntu-26.04","os":"Ubuntu 26.04 LTS"}]"#
        let inv = try inventory(inventoryJSON(edges: #"[{"pool":"pool-1","running":true}]"#,
                                              images: #"[{"pool":"pool-1","name":"Fleetwright Debian 13"}]"#,
                                              imageKinds: kinds))
        XCTAssertEqual(inv.imageKinds?.map(\.os), ["Debian 13", "Ubuntu 24.04 LTS", "Ubuntu 26.04 LTS"])
        XCTAssertEqual(inv.imageKeys(on: "net-wan"), ["debian-13"], "an image that predates saying is Debian")
        var c = XOPolicy.Choice.initial(for: inv)
        c.edge = false
        c.imageChoice = true
        c.imagesChoice = true
        c.images = ["ubuntu-26.04", "debian-13"]
        XCTAssertNil(c.problem(in: inv))
        XCTAssertEqual(c.payload(in: inv)["images"] as? [String], ["debian-13", "ubuntu-26.04"])
        XCTAssertNil(c.payload(in: inv)["image"])
        XCTAssertEqual(c.imagesToBuild(in: inv), ["ubuntu-26.04"])
        XCTAssertEqual(c.building(in: inv).image, true)
        c.images = ["debian-13"]
        XCTAssertEqual(c.building(in: inv).image, false, "the one there is not built again")
        c.images = []
        XCTAssertNil(c.payload(in: inv)["images"], "none asked is nothing sent")
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
        XCTAssertEqual(Set(object.keys), ["v", "srs", "networks", "egress", "edge", "limits"])
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
        // The Lock Screen says the same as the screen for a policy job, and
        // onboarding's words for one that adds a pool.
        XCTAssertEqual(XOSetupWords.headline(done, purpose: "policy"), "What the fleet may use is changed")
        XCTAssertEqual(XOSetupWords.headline(applying, purpose: "policy"), "Applying what you chose")
        XCTAssertEqual(XOSetupWords.headline(done), "Hypervisor added")
        // The bar is the build's own while it says how far it has got.
        var building = applying
        building.fill = 420
        XCTAssertEqual(XOSetupWords.bar(building).0 / XOSetupWords.bar(building).1, 0.42, accuracy: 0.001)
        XCTAssertEqual(XOSetupWords.ordinal(building), "42%")
        XCTAssertEqual(XOSetupWords.bar(applying).0, 4, "the steps done, without it")
    }
}
