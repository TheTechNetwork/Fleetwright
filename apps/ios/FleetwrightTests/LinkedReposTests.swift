import XCTest

@testable import Fleetwright

/// A linked-repository check and a session's archive, decoded as the
/// coordinator and the host send them and read back as the words a person
/// sees (#346). Same words as Android's `LinkedReposTest.kt`, case for case.
///
/// WHAT IS PINNED: that an archive reads its visibility as "Private" and the
/// others as "Public", that an answer nobody could give reads "can't tell"
/// and never "no", and that a session with an archive and no push yet says
/// nothing has been pushed rather than implying it was.
final class LinkedReposTests: XCTestCase {

    private func check(_ json: String) throws -> Fleet.LinkedRepoCheck {
        try JSONDecoder().decode(Fleet.LinkedRepoCheck.self, from: Data(json.utf8))
    }

    func testAnArchiveSaysPrivateAndWhoCanPush() throws {
        let c = try check(#"{"role":"archive","repo":"Eli/Work","public":false,"installed":true,"contents":"write","push":null,"carries":null,"ok":true,"message":"fine"}"#)
        XCTAssertEqual(describeLinkedCheck(c), "Private: yes · GitHub app: yes · Can write: yes · You can push: can't tell")
    }

    func testTemplatesSayWhatTheyCarry() throws {
        let c = try check(#"{"role":"templates","repo":"eli/presets","public":true,"installed":null,"contents":"read","push":null,"carries":[".claude","default.json"],"ok":true,"message":"fine"}"#)
        XCTAssertEqual(describeLinkedCheck(c), "Public: yes · GitHub app: can't tell · Can read: yes · Carries: .claude, default.json")
    }

    func testNothingLinkedIsSaidPerRole() {
        XCTAssertEqual(describeLinkedRole("archive", linked: nil, fleetRunners: nil), "Nothing linked. Session work is not saved. Start a private one from github.com/TheTechNetwork/Fleetwright-Archive.")
        XCTAssertEqual(describeLinkedRole("templates", linked: "eli/presets", fleetRunners: nil), "Linked: eli/presets.")
        XCTAssertEqual(describeLinkedRole("templates", linked: nil, fleetRunners: nil), "Nothing linked. Start one from github.com/TheTechNetwork/Fleetwright-Templates.")
        XCTAssertEqual(describeLinkedRole("runners", linked: nil, fleetRunners: "fleet/runners"),
                       "Using the fleet's: fleet/runners")
        XCTAssertEqual(describeLinkedRepos(0), "none linked")
        XCTAssertEqual(describeLinkedRepos(2), "2 of 3 linked")
    }

    func testEachRoleOpensItsStarterWithTheVisibilityItNeeds() {
        XCTAssertEqual(linkedRoleStarter("archive")?.absoluteString, "https://github.com/new?template_owner=TheTechNetwork&template_name=Fleetwright-Archive&name=fleetwright-archive&visibility=private")
        XCTAssertEqual(linkedRoleStarter("runners")?.absoluteString, "https://github.com/new?template_owner=TheTechNetwork&template_name=Fleetwright-Runners-Template&name=fleetwright-runners&visibility=public")
        XCTAssertEqual(linkedRoleStarter("templates")?.absoluteString, "https://github.com/new?template_owner=TheTechNetwork&template_name=Fleetwright-Templates&name=fleetwright-templates&visibility=private")
        XCTAssertNil(linkedRoleStarter("scratch"))
    }

    func testASessionSaysWhetherItsArchiveLanded() throws {
        func session(_ extra: String) throws -> Fleet.Session {
            try JSONDecoder().decode(Fleet.Session.self, from: Data(#"{"name":"job","status":"running"\#(extra)}"#.utf8))
        }
        XCTAssertNil(try session("").archiveLine)
        XCTAssertEqual(try session(#","archive":"Eli/Work""#).archiveLine, "Saves to Eli/Work when it stops. Not saved yet.")
        XCTAssertEqual(
            try session(#","archive":"Eli/Work","archiveAt":1,"archiveOk":true,"archiveText":"Archived to Eli/Work on fleetwright/deb14/job-x.""#).archiveLine,
            "Archived to Eli/Work on fleetwright/deb14/job-x."
        )
    }
}
