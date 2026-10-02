import XCTest

@testable import Fleetwright

/// A runner repository check, decoded as the coordinator sends it and read
/// back as the words a person sees. Same words as Android's
/// `RunnerRepoTest.kt`, case for case.
///
/// WHAT IS PINNED: that `public` — a Swift keyword — decodes; that an answer
/// nobody could give reads "can't tell" and never "no"; and that the sentence
/// under the field says which repository is in effect.
final class RunnerRepoTests: XCTestCase {

    private func check(_ json: String) throws -> Fleet.RunnerRepoCheck {
        try JSONDecoder().decode(Fleet.RunnerRepoCheck.self, from: Data(json.utf8))
    }

    func testEveryAnswerIsNamed() throws {
        let c = try check(#"{"repo":"Eli/Runners","public":true,"installed":true,"actionsWrite":true,"platforms":["linux","macos"],"missing":["windows","android"],"ok":true,"message":"fine"}"#)
        XCTAssertEqual(describeRunnerCheck(c), "Public: yes · GitHub app: yes · Actions write: yes · Machines: linux, macos")
    }

    func testCannotTellIsNotNo() throws {
        // A personal token cannot see installations. That is not "not installed".
        let c = try check(#"{"repo":"eli/runners","public":false,"installed":null,"actionsWrite":null,"platforms":[],"missing":["linux","macos","windows","android"],"ok":false,"message":"private"}"#)
        XCTAssertEqual(describeRunnerCheck(c), "Public: no · GitHub app: can't tell · Actions write: can't tell · Machines: none")
    }

    func testTheSentenceSaysWhichRepositoryIsInEffect() {
        XCTAssertEqual(describeRunnerRepoSetting(saved: "Eli/Runners", fleet: "fleet/runners"), "Your machines come from Eli/Runners.")
        XCTAssertEqual(
            describeRunnerRepoSetting(saved: nil, fleet: "fleet/runners"),
            "Your machines come from the fleet's repository, fleet/runners. Set your own to use your free Actions minutes."
        )
        XCTAssertTrue(describeRunnerRepoSetting(saved: nil, fleet: nil).hasPrefix("Make a public repository from github.com/TheTechNetwork/Fleetwright-Runners-Template"))
    }
}
