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

    func testAnOlderHostDecodesAndDrawsNothing() throws {
        let s = try session(#"{"name":"job","status":"running"}"#)
        XCTAssertNil(s.context)
        XCTAssertNil(s.contextLine)
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

    private func connections(_ json: String) throws -> Fleet.Connections {
        try JSONDecoder().decode(Fleet.Connections.self, from: Data(json.utf8))
    }

    func testUsageIsTheEndpointsFiguresWithTheResetOnThePhonesClock() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let c = try connections(#"""
        {"catalogue":[],"connected":[
          {"provider":"claude","account":"a@example.com","usage":{"checkedAt":1700000000000,"windows":{"fiveHour":{"used":42.4,"resetsAt":1700007200000},"sevenDay":{"used":12,"resetsAt":null},"sevenDayOpus":null,"sevenDaySonnet":null},"why":null}},
          {"provider":"github","account":"octocat"}
        ]}
        """#)
        let claude = c.linked("claude")!
        XCTAssertEqual(describeUsage(claude.usage!, now: now), "5h 42% · resets in 2h · 7d 12%")
        XCTAssertFalse(claude.usage!.isNearLimit)
        XCTAssertNil(c.linked("github")!.usage, "a token provider has no windows, and draws nothing")

        let why = try connections(#"{"catalogue":[],"connected":[{"provider":"claude","account":"b@example.com","usage":{"checkedAt":1,"windows":null,"why":"the credential has expired and has not renewed yet"}}]}"#)
        XCTAssertEqual(describeUsage(why.linked("claude")!.usage!, now: now), "usage not reported — the credential has expired and has not renewed yet")
        XCTAssertFalse(why.linked("claude")!.usage!.isNearLimit, "no figure is not a spent one")

        let near = try connections(#"{"catalogue":[],"connected":[{"provider":"claude","account":"c@example.com","usage":{"checkedAt":1,"windows":{"fiveHour":{"used":95,"resetsAt":1700000060000},"sevenDay":null,"sevenDayOpus":{"used":50,"resetsAt":null},"sevenDaySonnet":null},"why":null}}]}"#)
        XCTAssertEqual(describeUsage(near.linked("claude")!.usage!, now: now), "5h 95% · resets in 1m · Opus 7d 50%")
        XCTAssertTrue(near.linked("claude")!.usage!.isNearLimit)
    }

    func testAWindowWithNoFigureIsNotReported() throws {
        let c = try connections(#"{"catalogue":[],"connected":[{"provider":"claude","account":"a@example.com","usage":{"checkedAt":1,"windows":{"fiveHour":{"used":null,"resetsAt":null}},"why":null}}]}"#)
        XCTAssertEqual(describeUsage(c.linked("claude")!.usage!), "usage not reported")
    }

    func testAnOlderHostsRowDrawsNothing() throws {
        let c = try connections(#"{"catalogue":[],"connected":[{"provider":"claude","account":"a@example.com"}]}"#)
        XCTAssertNil(c.linked("claude")!.usage)
    }

    func testUntilIsCoarse() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(describeUntil(1_000_000 - 1, now: now), "now")
        XCTAssertEqual(describeUntil(1_000_000 + 30_000, now: now), "1m")
        XCTAssertEqual(describeUntil(1_000_000 + 5_400_000, now: now), "1h")
        XCTAssertEqual(describeUntil(1_000_000 + 200_000_000, now: now), "2d")
    }
}
