import XCTest

@testable import Fleetwright

/// The reassurance line, run against the table both phones share.
///
/// WHAT THIS REPLACES. `test/reassurance.test.js` asserted parity between the
/// two apps by matching words in their source — which passes whether this
/// file's rule and the Kotlin one agree or not, because both sources contain
/// the word either way. A grep can prove a rule is *mentioned* in two places;
/// only running both against the same inputs proves they agree.
///
/// The expected answers live in `test/fixtures/parity/reassurance.json`, read
/// here and by `ReassuranceParityTest.kt`. Change the rule and the table has to
/// change, which fails both apps until both are updated.
final class ReassuranceParityTests: XCTestCase {

    private struct Case: Decodable {
        struct Input: Decodable {
            let waiting: Int
            let running: Int
            let quiet: Int
            let unwell: [String]
            let blind: Bool
            let healthy: Int
        }
        let why: String
        let `in`: Input
        let headline: String
        let basis: String
    }

    private struct Table: Decodable { let cases: [Case] }

    /// The shared table, out of the test bundle. `parity/` is a folder
    /// reference in project.yml, so the directory arrives whole and a second
    /// table needs no build change.
    private func cases() throws -> [Case] {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "reassurance", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "reassurance", withExtension: "json")
        else {
            XCTFail("parity/reassurance.json is not in the test bundle")
            return []
        }
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url)).cases
    }

    private func reassurance(_ input: Case.Input) -> Reassurance {
        Reassurance(
            waiting: input.waiting,
            running: input.running,
            quiet: input.quiet,
            unwell: input.unwell,
            blind: input.blind,
            healthy: input.healthy
        )
    }

    /// Every assertion below is inside a loop, so an empty or unreadable table
    /// would make all of them pass while checking nothing — the exact shape of
    /// green this whole mechanism exists to remove.
    func testTableIsNotEmpty() throws {
        XCTAssertGreaterThanOrEqual(try cases().count, 10, "no cases were read from the fixture")
    }

    func testHeadlineMatchesTheSharedTable() throws {
        for c in try cases() {
            XCTAssertEqual(reassurance(c.in).headline, c.headline, c.why)
        }
    }

    func testBasisMatchesTheSharedTable() throws {
        for c in try cases() {
            XCTAssertEqual(reassurance(c.in).basis, c.basis, c.why)
        }
    }
}
