import XCTest

@testable import Fleetwright

/// What a session cost, how its run spent its time, and how long it has been
/// waiting on a person, decoded from a list reply as the sidecar writes it and
/// read back as the words a person sees. Same words as Android's
/// `TelemetryTest.kt`, case for case, so "both phones agree" is a thing
/// somebody can check by reading two files side by side.
///
/// WHAT IS PINNED: that an older host's reply decodes and draws nothing; that
/// the open stretch is added on the phone's clock; that the cost is Claude
/// Code's figure said as one ("at API prices", "at least" when it was not
/// sure); and that nothing is drawn as zero when it is really unknown.
final class TelemetryTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let nowMs = 1_700_000_000_000.0
    private let min = 60_000.0

    private func session(_ json: String) throws -> Fleet.Session {
        try JSONDecoder().decode(Fleet.Session.self, from: Data(json.utf8))
    }

    func testAnOlderHostDecodesAndDrawsNothing() throws {
        let s = try session(#"{"name":"job","status":"running"}"#)
        XCTAssertNil(s.timeLine(now: now))
        XCTAssertNil(s.spentLine(now: now))
        XCTAssertNil(s.waitedFor(now: now))
        XCTAssertEqual(s.stateSentence, "Working")
    }

    func testWaitingOnYouSaysForHowLongOnceItIsAMinute() throws {
        let long = try session(#"{"name":"j","status":"running","awaitingSince":\#(nowMs - 12 * min)}"#)
        XCTAssertTrue(long.isWaitingOnYou, "the host said so, even with no question it could read")
        XCTAssertEqual(long.waitedFor(now: now), "12m")
        let fresh = try session(#"{"name":"j","status":"running","awaitingSince":\#(nowMs - 20_000)}"#)
        XCTAssertNil(fresh.waitedFor(now: now), "under a minute is just waiting")
    }

    func testTheRunIsCountedApartWithTheOpenStretchOnThePhonesClock() throws {
        // Closed: 42m working, 3m on a dialog. Open: 70m at its prompt.
        let s = try session(#"""
        {"name":"j","status":"running","startedAt":\#(nowMs - 115 * min),
         "phases":{"since":\#(nowMs - 115 * min),"current":"ready","currentSince":\#(nowMs - 70 * min),
                   "workingMs":\#(42 * min),"awaitingMs":\#(3 * min),"readyMs":0}}
        """#)
        XCTAssertEqual(s.timeLine(now: now), "Worked 42m · waited on you 3m · at its prompt 1h 10m")

        let started = try session(#"{"name":"j","status":"running","phases":{"since":\#(nowMs - 20_000),"current":"working","currentSince":\#(nowMs - 20_000),"workingMs":0,"awaitingMs":0,"readyMs":0}}"#)
        XCTAssertEqual(started.timeLine(now: now), "Worked under 1m")

        // A hub restart lost the first three hours, and the line says so.
        let late = try session(#"{"name":"j","status":"running","startedAt":\#(nowMs - 300 * min),"phases":{"since":\#(nowMs - 120 * min),"current":"working","currentSince":\#(nowMs - 120 * min),"workingMs":0,"awaitingMs":0,"readyMs":0}}"#)
        XCTAssertEqual(late.timeLine(now: now), "Worked 2h · counted for the last 2h")

        let stopped = try session(#"{"name":"j","status":"stopped","phases":{"since":1,"current":"ready","currentSince":1,"workingMs":1,"awaitingMs":0,"readyMs":0}}"#)
        XCTAssertNil(stopped.timeLine(now: now))
    }

    func testTheCostIsClaudeCodesFigureSaidAsOne() throws {
        let s = try session(#"{"name":"j","status":"running","spent":{"usd":12.4,"complete":true,"outputTokens":48211,"asOf":\#(nowMs - 60_000)}}"#)
        XCTAssertEqual(s.spentLine(now: now), "$12.40 at API prices · 48k tokens out")

        let floor = try session(#"{"name":"j","status":"stopped","spent":{"usd":0.4653,"complete":false,"outputTokens":84,"asOf":1}}"#)
        XCTAssertEqual(floor.spentLine(now: now), "at least $0.47 at API prices · 84 tokens out")

        // Mid-turn, the figure is from its last pause, and the line says when.
        let stale = try session(#"{"name":"j","status":"running","spent":{"usd":835.96,"complete":true,"outputTokens":4558295,"asOf":\#(nowMs - 12 * min)}}"#)
        XCTAssertEqual(stale.spentLine(now: now), "$835.96 at API prices · 4.6M tokens out · as of 12m ago")

        XCTAssertNil(try session(#"{"name":"j","status":"running","spent":null}"#).spentLine(now: now))
        XCTAssertNil(try session(#"{"name":"j","status":"running","spent":{"usd":null,"complete":false}}"#).spentLine(now: now), "nothing known is not $0.00")
    }
}
