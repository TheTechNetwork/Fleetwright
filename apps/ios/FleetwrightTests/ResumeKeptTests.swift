import XCTest

@testable import Fleetwright

/// Whether a stopped session is offered Resume, decoded from `/api/hosts` as
/// the coordinator sends it (core.js snapshot: `administers` from hosts.js,
/// `health.sandboxed` from the box), and how a refused start is titled.
///
/// WHAT IS PINNED: the coordinator's rule (hosts.js runsSessionsFor), that a
/// resume runs only where sessions are sandboxed or for someone who
/// administers the machine; that a box which has not said is not taken for
/// sandboxed and is named as not having said (C-5); that a box which says why
/// it does not contain a session is told by that reason and its way on, or
/// by every reason and every way on when it gives more than one, and one
/// too old to say why reads as off; that a coordinator too old
/// to send `administers` offers Resume as before; and that a refusal which is a
/// setting on the machine is titled as one. Where the line and the button sit
/// is read by test/unsandboxed-resume-ios-in-apps.test.js.
final class ResumeKeptTests: XCTestCase {

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

    func testAMemberIsToldWhyOnAMachineWithoutTheSandbox() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false}}"#)
        XCTAssertEqual(
            h.resumeKept,
            "deb132 runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there."
        )
    }

    func testAMachineWithItsSandboxOnIsToldForWhatItSaid() throws {
        // Run as root, a box has its sandbox on and root in a session is root
        // on the machine; "without the sandbox" sent its operator to a switch
        // that was already on. Each reason with its way on, as the coordinator
        // words the same refusal.
        XCTAssertEqual(
            try said("userns_root"),
            "deb132 runs fleetwright as root, and root in a session is root on the machine, so only this fleet’s admin, or the one person it works for, can resume one there until fleetwright runs as its own user."
        )
        XCTAssertEqual(
            try said("userns_docker"),
            "deb132 runs its sandbox with docker, which does not keep root in a session apart from the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until its sessions run under podman."
        )
        XCTAssertEqual(
            try said("userns_host"),
            "deb132 has FLEETWRIGHT_SANDBOX_USERNS=host, which makes root in a session the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until that is set back to nomap."
        )
        XCTAssertEqual(
            try said("unsafe_args"),
            "deb132 lets an option in FLEETWRIGHT_SANDBOX_ARGS end its sandbox, so only this fleet’s admin, or the one person it works for, can resume one there until that option is taken out."
        )
        XCTAssertEqual(
            try said("off"),
            "deb132 runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there."
        )
        XCTAssertEqual(
            try said("a_reason_from_later"),
            "deb132 says its sessions are not contained, so only this fleet’s admin, or the one person it works for, can resume one there."
        )
    }

    func testAMachineWithMoreThanOneReasonIsToldEveryOne() throws {
        // Run as root with its sandbox off, "until its sandbox is on" was
        // half of it: with the sandbox on, root still kept the session out.
        // Every reason the machine gives, and everything that has to change.
        let two = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"off","sandboxedAlso":["userns_root"]}}"#)
        XCTAssertEqual(
            two.resumeKept,
            "deb132 runs sessions without the sandbox and runs fleetwright as root, so only this fleet’s admin, or the one person it works for, can resume one there until its sandbox is on and fleetwright runs as its own user."
        )
        let three = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"unsafe_args","sandboxedAlso":["userns_host","userns_root"]}}"#)
        XCTAssertEqual(
            three.resumeKept,
            "deb132 lets FLEETWRIGHT_SANDBOX_ARGS end its sandbox, has FLEETWRIGHT_SANDBOX_USERNS=host, and runs fleetwright as root, so only this fleet’s admin, or the one person it works for, can resume one there until the option in FLEETWRIGHT_SANDBOX_ARGS that ends its sandbox is taken out, FLEETWRIGHT_SANDBOX_USERNS is set back to nomap, and fleetwright runs as its own user."
        )
        // One it does not know makes the rest a partial list: no way on named.
        let later = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"userns_root","sandboxedAlso":["a_reason_from_later"]}}"#)
        XCTAssertEqual(
            later.resumeKept,
            "deb132 says its sessions are not contained, so only this fleet’s admin, or the one person it works for, can resume one there."
        )
        // An empty list is one reason, in its own sentence.
        let one = try host(#"{"hostId":"deb132","state":"healthy","administers":false,"health":{"sandboxed":false,"sandboxedWhy":"userns_root","sandboxedAlso":[]}}"#)
        XCTAssertEqual(one.resumeKept, try said("userns_root"))
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
