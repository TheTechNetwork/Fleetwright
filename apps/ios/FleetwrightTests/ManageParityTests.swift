import XCTest

@testable import Fleetwright

/// Managing a pool from this phone (Manage.swift), run against the table both
/// phones share: test/fixtures/parity/manage.json, read here and by
/// ManageParityTest.kt.
///
/// WHAT IT PROTECTS. The rows a person reads, the buttons they are offered and
/// the way each asks before it acts are decided by rules written twice, once
/// here and once in Kotlin. A Node test reading both sources can prove a
/// sentence is in both files; only running both against the same inputs
/// proves the phones agree on which button a server's method list draws and
/// what a VM with no state is offered (nothing). Every assertion is inside a
/// loop over the table, so the first test fails an empty or unreadable one.
final class ManageParityTests: XCTestCase {

    private func table() throws -> [String: Any] {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "manage", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "manage", withExtension: "json")
        else {
            XCTFail("parity/manage.json is not in the test bundle")
            return [:]
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func list(_ t: [String: Any], _ key: String) -> [[String: Any]] {
        t[key] as? [[String: Any]] ?? []
    }

    private func snapshot(_ t: [String: Any]) -> Manage.Snapshot {
        var s = Manage.Snapshot()
        for o in list(t, "objects") { s.enter(o) }
        return s
    }

    /// "all", a list, or null (cannot tell).
    private func methods(_ value: Any?, _ t: [String: Any]) -> Set<String>? {
        if let name = value as? String, name == "all" {
            return Set((t["methods"] as? [String: Any])?["all"] as? [String] ?? [])
        }
        if let names = value as? [String] { return Set(names) }
        return nil
    }

    private func component(_ s: Manage.Snapshot, _ id: Any?) throws -> Manage.Component {
        try XCTUnwrap(s.components[id as? String ?? ""], "no component \(String(describing: id))")
    }

    private func said(_ c: Manage.Confirmation) -> [String: String] {
        switch c {
        case .none: return ["kind": "none"]
        case let .ask(title, button): return ["kind": "ask", "title": title, "button": button]
        case let .typeName(title, name, button): return ["kind": "type", "title": title, "name": name, "button": button]
        }
    }

    private func same(_ got: [String: Any], _ want: Any?, _ why: String) {
        XCTAssertEqual(NSDictionary(dictionary: got), NSDictionary(dictionary: want as? [String: Any] ?? [:]), why)
    }

    func testTheTableIsNotEmptyBecauseAVacuousPassIsTheFailureThisGuards() throws {
        let t = try table()
        for key in ["objects", "components", "actions", "details", "tuning", "notifications", "records"] {
            XCTAssertFalse(list(t, key).isEmpty, "\(key) is empty")
        }
    }

    func testSizesReadTheSameOnBothPhones() throws {
        let cases = try table()["bytes"] as? [[Any]] ?? []
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let n = try XCTUnwrap((c[0] as? NSNumber)?.int64Value)
            XCTAssertEqual(Manage.bytes(n), c[1] as? String)
        }
    }

    func testThePhoneComputesThePinTheMachineWrote() throws {
        let pin = try XCTUnwrap(try table()["pin"] as? [String: String])
        let der = try XCTUnwrap(Data(base64Encoded: pin["der"] ?? ""))
        XCTAssertEqual(Manage.fingerprint(der: der), pin["sha256"])
    }

    /// A page one of your machines read for this phone opens under the
    /// additional data the machine sealed it with (xolookAad in seal.js).
    func testAPageReadThroughAMachineOpensUnderTheMachinesAAD() throws {
        let row = try XCTUnwrap(try table()["xolookAad"] as? [String])
        XCTAssertEqual(Seal.xolookAAD(address: row[0]), row[1])
    }

    /// A page as the machine sends it (a flat list of objects) is read into
    /// the same rows as the socket's keyed answer.
    func testAPageReadThroughAMachineBecomesTheSameRows() throws {
        let objects = try XCTUnwrap(try table()["objects"] as? [[String: Any]])
        var keyed = Manage.Snapshot()
        keyed.take(Dictionary(uniqueKeysWithValues: objects.compactMap { o in (o["id"] as? String).map { ($0, o as Any) } }))
        var listed = Manage.Snapshot()
        listed.take(objects as [Any])
        XCTAssertFalse(listed.isEmpty)
        XCTAssertEqual(listed, keyed)
    }

    func testEveryObjectBecomesTheRowTheTableSays() throws {
        let t = try table()
        let s = snapshot(t)
        for want in list(t, "components") {
            let c = try component(s, want["id"])
            XCTAssertEqual(c.kind.rawValue, want["kind"] as? String, "\(c.id) kind")
            XCTAssertEqual(c.name, want["name"] as? String, "\(c.id) name")
            XCTAssertEqual(Manage.stateWords(c), want["state"] as? String, "\(c.id) state")
            XCTAssertEqual(Manage.what(c, in: s), want["what"] as? String, "\(c.id) what it is")
            XCTAssertEqual(Manage.numbers(c, in: s), want["numbers"] as? String, "\(c.id) numbers")
        }
        // Nothing that is not a component became one: a VBD, a VDI and a
        // message are read, and none of them is a row.
        XCTAssertEqual(s.components.count, list(t, "components").count)
    }

    func testEachKindIsListedByName() throws {
        let t = try table()
        let s = snapshot(t)
        let lists = try XCTUnwrap(t["lists"] as? [String: [String]])
        for kind in Manage.Kind.allCases {
            XCTAssertEqual(s.list(kind).map(\.id), lists[kind.rawValue], "\(kind) order")
        }
    }

    func testAVMsDisksAreItsAttachedOnesWithoutTheCDDrive() throws {
        let t = try table()
        let s = snapshot(t)
        for want in list(t, "disks") {
            let got = s.attachedDisks(want["vm"] as? String ?? "")
            let disks = want["disks"] as? [[String: String]] ?? []
            XCTAssertEqual(got.map(\.id), disks.map { $0["id"] ?? "" })
            for (d, w) in zip(got, disks) {
                XCTAssertEqual(d.name, w["name"])
                XCTAssertEqual(d.size.map { Manage.bytes($0) }, w["size"])
                XCTAssertEqual(Manage.diskLine(d, in: s), w["line"])
            }
        }
    }

    func testAnActionIsOfferedOnlyWhenItsMethodIsListedAndTheStateAllowsIt() throws {
        let t = try table()
        let s = snapshot(t)
        for want in list(t, "actions") {
            let c = try component(s, want["component"])
            let got = Manage.offered(c, methods: methods(want["methods"], t)).map(\.id)
            XCTAssertEqual(got, want["offered"] as? [String], want["why"] as? String ?? "")
        }
    }

    func testEachActionSaysCallsAndAsksWhatTheTableSays() throws {
        let t = try table()
        let s = snapshot(t)
        let now = Date(timeIntervalSince1970: ((t["now"] as? NSNumber)?.doubleValue ?? 0) / 1000)
        for want in list(t, "details") {
            let c = try component(s, want["component"])
            let offered = Manage.offered(c, methods: methods(want["methods"], t))
            let a = try XCTUnwrap(offered.first { $0.id == want["action"] as? String }, "\(c.id) is not offered \(want["action"] ?? "")")
            XCTAssertEqual(a.label, want["label"] as? String)
            XCTAssertEqual(a.method, want["method"] as? String, "\(c.id) \(a.id) method")
            XCTAssertEqual(a.cost.rawValue, want["cost"] as? String, "\(c.id) \(a.id) cost")
            same(Manage.params(a, for: c, now: now), want["params"], "\(c.id) \(a.id) params")
            XCTAssertEqual(said(Manage.confirmation(a, for: c, in: s)), want["confirm"] as? [String: String], "\(c.id) \(a.id) asks")
            XCTAssertEqual(Manage.done(a, for: c), want["done"] as? String)
        }
    }

    func testTheSizeIsChangedOnlyWhereItCanBeAndSaysWhyNotElsewhere() throws {
        let t = try table()
        let s = snapshot(t)
        for want in list(t, "tuning") {
            let c = try component(s, want["component"])
            let m = methods(want["methods"], t)
            let why = want["why"] as? String ?? ""
            XCTAssertEqual(Manage.canResize(c, methods: m), want["resize"] as? Bool, why)
            XCTAssertEqual(Manage.resizeNeedsStopped(c, methods: m), want["needsStopped"] as? Bool, why)
            XCTAssertEqual(Manage.growMethod(c, methods: m), want["grow"] as? String, why)
        }
        for want in list(t, "resize") {
            let c = try component(s, want["component"])
            let cpus = (want["cpus"] as? NSNumber)?.intValue ?? 0
            let gib = (want["memoryGiB"] as? NSNumber)?.intValue ?? 0
            same(Manage.resizeParams(c, cpus: cpus, memoryGiB: gib), want["params"], "resize params")
            XCTAssertEqual(Manage.resized(c, cpus: cpus, memoryGiB: gib), want["done"] as? String)
        }
        for want in list(t, "grow") {
            let c = try component(s, want["component"])
            let d = try XCTUnwrap(s.attachedDisks(c.id).first { $0.id == want["disk"] as? String })
            let gib = (want["toGiB"] as? NSNumber)?.intValue ?? 0
            XCTAssertEqual(Manage.growMethod(c, methods: methods(want["methods"], t)), want["method"] as? String)
            same(Manage.growParams(d, toGiB: gib), want["params"], "grow params")
            XCTAssertEqual(said(Manage.growConfirmation(d, toGiB: gib)), want["confirm"] as? [String: String])
            XCTAssertEqual(Manage.grown(d, toGiB: gib), want["done"] as? String)
        }
    }

    func testANotificationChangesThePictureTheWayXenOrchestraMeantIt() throws {
        let t = try table()
        for want in list(t, "notifications") {
            var s = snapshot(t)
            let why = want["why"] as? String ?? ""
            XCTAssertTrue(s.apply(method: "all", params: want["notice"]), why)
            for (id, word) in want["states"] as? [String: String] ?? [:] {
                XCTAssertEqual(s.components[id].flatMap { Manage.stateWords($0) }, word, why)
            }
            for (id, line) in want["numbers"] as? [String: String] ?? [:] {
                XCTAssertEqual(s.components[id].map { Manage.numbers($0, in: s) }, line, why)
            }
            for id in want["absent"] as? [String] ?? [] {
                XCTAssertNil(s.components[id], why)
            }
        }
        // A method that is not `all` is not a change.
        var s = snapshot(t)
        let notAll: [String: Any] = ["type": "enter", "items": [String: Any]()]
        XCTAssertFalse(s.apply(method: "message", params: notAll))
    }

    func testTheRecordSetupHandedBackIsReadForThisAddressOnly() throws {
        for want in list(try table(), "records") {
            let r = Manage.record(want["text"] as? String ?? "", address: want["address"] as? String ?? "")
            let why = want["why"] as? String ?? ""
            guard want["ok"] as? Bool == true else {
                XCTAssertNil(r, why)
                continue
            }
            let got = try XCTUnwrap(r, why)
            XCTAssertEqual(got.token, want["token"] as? String, why)
            XCTAssertEqual(got.pin, want["pin"] as? String, why)
            XCTAssertEqual(got.plain, want["plain"] as? Bool, why)
            XCTAssertEqual(got.user, want["user"] as? String, why)
            XCTAssertEqual(got.expires.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) }, (want["expires"] as? NSNumber)?.int64Value, why)
        }
    }

    func testEverySentenceIsTheOneTheTableSays() throws {
        let words = try XCTUnwrap(try table()["words"] as? [String: Any])
        func one(_ key: String) -> [Any] { words[key] as? [Any] ?? [] }
        func str(_ key: String) -> String? { words[key] as? String }
        func arg(_ key: String, _ i: Int) -> String { one(key)[i] as? String ?? "" }
        func int(_ key: String, _ i: Int) -> Int { (one(key)[i] as? NSNumber)?.intValue ?? 0 }

        let fixed: [String: String] = [
            "watching": Manage.Words.watching, "never": Manage.Words.never, "closed": Manage.Words.closed,
            "noObjects": Manage.Words.noObjects, "methodsUnknown": Manage.Words.methodsUnknown,
            "nothingOffered": Manage.Words.nothingOffered, "seesNothing": Manage.Words.seesNothing,
            "tuneNeedsStopped": Manage.Words.tuneNeedsStopped, "growNote": Manage.Words.growNote, "slow": Manage.Words.slow,
            "actionsFooter": Manage.Words.actionsFooter, "gone": Manage.Words.gone, "lookAgain": Manage.Words.lookAgain,
            "changePolicy": Manage.Words.changePolicy, "whatItIs": Manage.Words.whatItIs, "howItIs": Manage.Words.howItIs,
            "whatItCanDo": Manage.Words.whatItCanDo, "oneOfYours": Manage.Words.oneOfYours,
        ]
        for (key, value) in fixed { XCTAssertEqual(value, str(key), key) }

        let single: [String: (String) -> String] = [
            "connecting": Manage.Words.connecting, "plainPool": Manage.Words.plainPool, "noToken": Manage.Words.noToken,
            "wrongCertificate": Manage.Words.wrongCertificate, "limitedUser": Manage.Words.limitedUser,
            "typePrompt": Manage.Words.typePrompt, "refused": Manage.Words.refused, "lost": Manage.Words.lost,
            "askingFleet": Manage.Words.askingFleet,
        ]
        for (key, say) in single { XCTAssertEqual(say(arg(key, 0)), arg(key, 1), key) }

        XCTAssertEqual(Manage.Words.expired(arg("expired", 0), on: arg("expired", 1)), arg("expired", 2))
        XCTAssertEqual(Manage.Words.signInRefused(arg("signInRefused", 0), arg("signInRefused", 1)), arg("signInRefused", 2))
        XCTAssertEqual(Manage.Words.unreachable(arg("unreachable", 0), arg("unreachable", 1)), arg("unreachable", 2))
        XCTAssertEqual(Manage.Words.through(arg("through", 0), at: arg("through", 1)), arg("through", 2))
        XCTAssertEqual(Manage.Words.throughLost(arg("throughLost", 0), arg("throughLost", 1)), arg("throughLost", 2))
        XCTAssertEqual(Manage.Words.unreachableEverywhere(arg("unreachableEverywhere", 0), arg("unreachableEverywhere", 1),
                                                          arg("unreachableEverywhere", 2)), arg("unreachableEverywhere", 3))
        for c in one("resizeButton").compactMap({ $0 as? [Any] }) {
            let cpus = (c[0] as? NSNumber)?.intValue ?? 0
            let gib = (c[1] as? NSNumber)?.intValue ?? 0
            XCTAssertEqual(Manage.Words.resizeButton(cpus: cpus, memoryGiB: gib), c[2] as? String)
        }
        XCTAssertEqual(Manage.Words.growButton(arg("growButton", 0), toGiB: int("growButton", 1)), arg("growButton", 2))
        let heading = words["heading"] as? [String: String] ?? [:]
        let kindTitle = words["kindTitle"] as? [String: String] ?? [:]
        for kind in Manage.Kind.allCases {
            XCTAssertEqual(Manage.Words.heading(kind), heading[kind.rawValue])
            XCTAssertEqual(Manage.Words.kindTitle(kind), kindTitle[kind.rawValue])
        }

        // EVERY KEY IS CHECKED: a sentence added to the table and to neither
        // phone would otherwise sit there proving nothing.
        let checked = Set(fixed.keys).union(single.keys)
            .union(["expired", "signInRefused", "unreachable", "through", "throughLost", "unreachableEverywhere",
                    "resizeButton", "growButton", "heading", "kindTitle"])
        XCTAssertEqual(Set(words.keys), checked)
    }
}
