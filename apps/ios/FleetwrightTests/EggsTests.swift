import XCTest

@testable import Fleetwright

/// `Eggs.swift` against `test/fixtures/parity/eggs.json`, which `EggsTest.kt`
/// runs on Android too.
final class EggsTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Case: Decodable { let taps: Int; let shows: Bool }
        struct Pulls: Decodable {
            struct Case: Decodable { let at: [Int]; let shows: Bool }
            let count: Int
            let withinSeconds: Int
            let line: String
            let cases: [Case]
        }
        let taps: Int
        let line: String
        let cases: [Case]
        let pulls: Pulls
    }

    private func fixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "eggs", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "eggs", withExtension: "json")
        else {
            XCTFail("parity/eggs.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testTheCountAndTheWordsAreTheTable() throws {
        let f = try fixture()
        XCTAssertEqual(Eggs.taps, f.taps)
        XCTAssertEqual(Eggs.line, f.line)
    }

    func testEveryCase() throws {
        let f = try fixture()
        XCTAssertFalse(f.cases.isEmpty)
        for c in f.cases {
            XCTAssertEqual(Eggs.buildLine(taps: c.taps), c.shows ? f.line : nil, "\(c.taps) taps")
        }
    }

    func testPullingTheListIsTheTableToo() throws {
        let f = try fixture()
        XCTAssertEqual(Eggs.pullCount, f.pulls.count)
        XCTAssertEqual(Eggs.pullWindow, TimeInterval(f.pulls.withinSeconds))
        XCTAssertEqual(Eggs.pullingLine, f.pulls.line)
        XCTAssertFalse(f.pulls.cases.isEmpty)
        for c in f.pulls.cases {
            XCTAssertEqual(Eggs.pullLine(c.at.map(TimeInterval.init)), c.shows ? f.pulls.line : nil, "pulls at \(c.at)")
        }
    }
}
