import XCTest

@testable import Fleetwright

/// Whether a stopped session is offered Resume, decoded from `/api/hosts` as
/// the coordinator sends it (core.js snapshot: `administers` from hosts.js,
/// `health.sandboxed` from the box), and how a refused start is titled.
///
/// WHAT IS PINNED: the coordinator's rule (hosts.js runsSessionsFor), that a
/// resume runs only where sessions are sandboxed or for someone who
/// administers the machine; that a box which has not said is not taken for
/// sandboxed and is named as not having said (C-5); that a coordinator too old
/// to send `administers` offers Resume as before; and that a refusal which is a
/// setting on the machine is titled as one. Where the line and the button sit
/// is read by test/unsandboxed-resume-ios-in-apps.test.js.
final class ResumeKeptTests: XCTestCase {

    private func host(_ json: String) throws -> Fleet.FleetHost {
        try JSONDecoder().decode(Fleet.FleetHost.self, from: Data(json.utf8))
    }

    private func reply(_ json: String) throws -> Fleet.Reply {
        try JSONDecoder().decode(Fleet.Reply.self, from: Data(json.utf8))
    }

    func testAnAdminKeepsResumeOnAMachineWithoutTheSandbox() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":true,"health":{"sandboxed":false}}"#)
        XCTAssertNil(h.resumeKept)
    }

    func testASandboxedMachineResumesForAMember() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":true}}"#)
        XCTAssertNil(h.resumeKept)
    }

    func testAMemberIsToldWhyOnAMachineWithoutTheSandbox() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false}}"#)
        XCTAssertEqual(
            h.resumeKept,
            "deb132 runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there."
        )
    }

    func testAMachineThatHasNotSaidIsNotTakenForSandboxed() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{}}"#)
        XCTAssertEqual(
            h.resumeKept,
            "deb132 has not said whether its sessions are sandboxed, so only this fleet’s admin, or the one person it works for, can resume one there until it is updated."
        )
    }

    func testAnOlderCoordinatorOffersResumeAsBefore() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","health":{"sandboxed":false}}"#)
        XCTAssertNil(h.resumeKept)
    }

    func testARefusalThatIsAMachineSettingIsTitledAsOne() throws {
        XCTAssertEqual(
            try reply(#"{"ok":false,"error":{"code":"unsandboxed"},"text":"deb132 runs sessions without the sandbox."}"#).refusedStartTitle,
            "Not started: only admins run sessions there"
        )
        XCTAssertEqual(
            try reply(#"{"ok":false,"error":{"code":"host_outdated"},"text":"deb132 is too old."}"#).refusedStartTitle,
            "Not started: the machine needs an update"
        )
        XCTAssertEqual(
            try reply(#"{"ok":false,"error":{"code":"no_hosts"},"text":"No hosts."}"#).refusedStartTitle,
            "Could not start a session"
        )
    }

    func testAnErrorThatIsASentenceStillDecodes() throws {
        let r = try reply(#"{"ok":false,"error":"a push token is required"}"#)
        XCTAssertNil(r.error?.code)
        XCTAssertEqual(r.refusedStartTitle, "Could not start a session")
    }
}
