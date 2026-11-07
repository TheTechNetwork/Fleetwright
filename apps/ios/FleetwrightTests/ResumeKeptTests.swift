import XCTest

@testable import Fleetwright

/// Whether a stopped session is offered Resume, decoded from `/api/hosts` as
/// the coordinator sends it (core.js snapshot: `administers` from hosts.js,
/// `health.sandboxed` from the box), and how a refused start is titled.
///
/// WHAT IS PINNED: the coordinator's rule (hosts.js runsSessionsFor), that a
/// resume runs only where sessions are sandboxed or for someone who
/// administers the machine; that a box which has not said is not taken for
/// sandboxed and is named as not having said (C-5); that whichever reason a
/// box gives for not containing a session, and however many, the session's
/// page says the same one sentence, who can resume it, because the reason
/// and its way on are the machine page's (docs/reviews/copy-2026-11-06.md,
/// 1); that the card says less still; that a coordinator too old to send
/// `administers` offers Resume as before; and that a refusal which is a
/// setting on the machine is titled as one. Where the line and the button sit
/// is read by test/unsandboxed-resume-ios-in-apps.test.js.
final class ResumeKeptTests: XCTestCase {

    private static let without = "deb132 runs sessions without full isolation. Your admin can resume it."
    private static let notSaid = "deb132 has not said whether it isolates sessions. Your admin can resume it."

    private func host(_ json: String) throws -> Fleet.FleetHost {
        try JSONDecoder().decode(Fleet.FleetHost.self, from: Data(json.utf8))
    }

    /// What a member is told about a machine that says why it does not
    /// contain a session.
    private func said(_ why: String) throws -> String? {
        try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"\#(why)"}}"#).resumeKept
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

    func testAMemberIsToldWhoCanOnAMachineWithoutTheSandbox() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false}}"#)
        XCTAssertEqual(h.resumeKept, Self.without)
    }

    func testAMachineThatSaysWhyIsToldTheSameSentence() throws {
        // Root, docker, an environment variable: each is the machine's
        // business and its admin's, said on the machine's page. A member
        // reading the session is told the same thing whichever it is, and
        // nothing a later box might say changes that.
        for why in ["userns_root", "userns_docker", "userns_host", "unsafe_args", "off", "a_reason_from_later"] {
            XCTAssertEqual(try said(why), Self.without, why)
        }
    }

    func testAMachineWithMoreThanOneReasonIsToldTheSameSentence() throws {
        let two = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"off","sandboxedAlso":["userns_root"]}}"#)
        XCTAssertEqual(two.resumeKept, Self.without)
        let three = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"unsafe_args","sandboxedAlso":["userns_host","userns_root"]}}"#)
        XCTAssertEqual(three.resumeKept, Self.without)
        let later = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"userns_root","sandboxedAlso":["a_reason_from_later"]}}"#)
        XCTAssertEqual(later.resumeKept, Self.without)
    }

    func testAMachineThatHasNotSaidIsNotTakenForSandboxed() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{}}"#)
        XCTAssertEqual(h.resumeKept, Self.notSaid)
    }

    func testTheCardSaysOnlyWhoCan() {
        XCTAssertEqual(Fleet.FleetHost.resumeKeptRow, "Only an admin can resume this")
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
