import XCTest

@testable import Fleetwright

/// The two additive facts the host sends about sessions and accounts, decoded
/// from the frame as the sidecar writes it and read back as the words a person
/// sees. Same words as Android's `ContextAndUsageTest.kt`, case for case.
///
/// WHAT IS PINNED: that an older host's frame — no `context`, no `usage` —
/// decodes and draws nothing; that a count is drawn as a count and never as a
/// percentage; and that a row with no answer says why in the host's words
/// rather than reading as 0%.
final class ContextAndUsageTests: XCTestCase {

    private func session(_ json: String) throws -> Fleet.Session {
        try JSONDecoder().decode(Fleet.Session.self, from: Data(json.utf8))
    }

    private func health(_ json: String) throws -> Fleet.HostHealth {
        try JSONDecoder().decode(Fleet.HostHealth.self, from: Data(json.utf8))
    }

    func testAnOlderHostDecodesAndDrawsNothing() throws {
        let s = try session(#"{"name":"job","status":"running"}"#)
        XCTAssertNil(s.context)
        XCTAssertNil(s.contextLine)
        let h = try health(#"{"hostId":"box"}"#)
        XCTAssertNil(h.usage)
    }

    func testContextIsACountInCoarseUnits() throws {
        XCTAssertEqual(try session(#"{"name":"j","status":"running","context":{"tokens":248717,"model":"claude-fable-5-1"}}"#).contextLine, "248k in context")
        XCTAssertEqual(try session(#"{"name":"j","status":"running","context":{"tokens":412,"model":null}}"#).contextLine, "412 tokens in context")
        XCTAssertEqual(try session(#"{"name":"j","status":"running","context":{"tokens":1200000}}"#).contextLine, "1.2M in context")
        // Not running: whatever was recorded, it is not in a window now.
        XCTAssertNil(try session(#"{"name":"j","status":"stopped","context":{"tokens":248717}}"#).contextLine)
        // The host said null — cannot tell — and nothing is drawn.
        XCTAssertNil(try session(#"{"name":"j","status":"running","context":null}"#).contextLine)
    }

    func testUsageIsTheEndpointsFiguresWithTheResetOnThePhonesClock() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let h = try health(#"""
        {"hostId":"box","usage":{"checkedAt":1700000000000,"accounts":[
          {"account":"a@example.com","usage":{"fiveHour":{"used":42.4,"resetsAt":1700007200000},"sevenDay":{"used":12,"resetsAt":null},"sevenDayOpus":null,"sevenDaySonnet":null},"why":null},
          {"account":"b@example.com","usage":null,"why":"the credential has expired and has not renewed yet"},
          {"account":"c@example.com","usage":{"fiveHour":{"used":95,"resetsAt":1700000060000},"sevenDay":null,"sevenDayOpus":{"used":50,"resetsAt":null},"sevenDaySonnet":null},"why":null}
        ]}}
        """#)
        let rows = h.usage?.accounts ?? []
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(describeUsage(rows[0], now: now), "a@example.com · 5h 42% · resets in 2h · 7d 12%")
        XCTAssertFalse(rows[0].isNearLimit)
        XCTAssertEqual(describeUsage(rows[1], now: now), "b@example.com · usage not reported — the credential has expired and has not renewed yet")
        XCTAssertFalse(rows[1].isNearLimit, "no figure is not a spent one")
        XCTAssertEqual(describeUsage(rows[2], now: now), "c@example.com · 5h 95% · resets in 1m · Opus 7d 50%")
        XCTAssertTrue(rows[2].isNearLimit)
    }

    func testAWindowWithNoFigureIsNotReported() throws {
        let h = try health(#"{"hostId":"box","usage":{"checkedAt":1,"accounts":[{"account":"a@example.com","usage":{"fiveHour":{"used":null,"resetsAt":null}},"why":null}]}}"#)
        XCTAssertEqual(describeUsage(h.usage!.accounts![0]), "a@example.com · usage not reported")
    }

    func testUntilIsCoarse() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(describeUntil(1_000_000 - 1, now: now), "now")
        XCTAssertEqual(describeUntil(1_000_000 + 30_000, now: now), "1m")
        XCTAssertEqual(describeUntil(1_000_000 + 5_400_000, now: now), "1h")
        XCTAssertEqual(describeUntil(1_000_000 + 200_000_000, now: now), "2d")
    }
}
