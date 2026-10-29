import XCTest

@testable import Fleetwright

/// Whether a machine that pins its own admins takes update, upgrade, reboot
/// and a restore from this person, decoded from `/api/hosts` as the
/// coordinator shapes it (core.js adminsSeenBy).
///
/// WHAT IS PINNED: that a machine which cannot pin, or pins nobody, leaves the
/// buttons as they were; that one which pins somebody else takes those verbs
/// from them alone, and a person's own restore from that person; and that a
/// record the machine cannot read takes them from nobody (C-5). Which controls
/// sit behind it is read by test/pinned-admins-in-apps.test.js.
final class HostPinnedAdminsTests: XCTestCase {

    private func health(_ admins: String) throws -> Fleet.HostHealth {
        let json = #"{"hostId":"deb132","state":"healthy","health":{"bin":[{"name":"mine","createdBy":"fleet:bea@example.com"},{"name":"theirs","createdBy":"fleet:ada@example.com"}]"#
            + (admins.isEmpty ? "" : #","admins":"# + admins) + "}}"
        let host = try JSONDecoder().decode(Fleet.FleetHost.self, from: Data(json.utf8))
        return try XCTUnwrap(host.health)
    }

    func testAMachineThatCannotPinOrPinsNobodyIsAsBefore() throws {
        for admins in ["", #"{"count":0,"you":false}"#] {
            let h = try health(admins)
            XCTAssertTrue(h.boxWideAllowed)
            XCTAssertTrue(h.bin!.allSatisfy { h.mayRestore($0, as: "bea@example.com") })
        }
    }

    func testAPinnedAdminMayAndSomebodyElseMayOnlyRestoreTheirOwn() throws {
        let pinned = try health(#"{"count":1,"you":true,"pinned":["bea@example.com"]}"#)
        XCTAssertTrue(pinned.boxWideAllowed)

        let other = try health(#"{"count":1,"you":false}"#)
        XCTAssertFalse(other.boxWideAllowed)
        XCTAssertTrue(other.mayRestore(other.bin![0], as: "Bea@Example.com"))
        XCTAssertFalse(other.mayRestore(other.bin![1], as: "bea@example.com"))
    }

    func testARecordTheMachineCannotReadTakesNothing() throws {
        let h = try health(#"{"count":null,"you":null,"problem":"cannot be read"}"#)
        XCTAssertFalse(h.boxWideAllowed)
        XCTAssertFalse(h.mayRestore(h.bin![0], as: "bea@example.com"))
        XCTAssertEqual(h.admins?.problem, "cannot be read")
    }
}
