import XCTest

@testable import Fleetwright

/// Whether a machine's page draws its releases, image, labels, update,
/// upgrade and reboot, decoded from `/api/hosts` as the coordinator sends it
/// (core.js snapshot, `administers` from hosts.js).
///
/// WHAT IS PINNED: that the key decodes under the coordinator's name; that
/// false hides the controls the coordinator would refuse (C-2); and that a
/// coordinator too old to send it is cannot tell, which draws them as before
/// and never hides them on a guess (C-5). Which controls sit behind it is
/// read by test/host-administers-in-apps.test.js.
final class HostAdministersTests: XCTestCase {

    private func host(_ json: String) throws -> Fleet.FleetHost {
        try JSONDecoder().decode(Fleet.FleetHost.self, from: Data(json.utf8))
    }

    func testAMachineThisPersonAdministersDrawsItsControls() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":true}"#)
        XCTAssertEqual(h.administers, true)
        XCTAssertTrue(h.mayAdminister)
    }

    func testAMachineThatRunsOtherPeoplesWorkDoesNot() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy","administers":false}"#)
        XCTAssertEqual(h.administers, false)
        XCTAssertFalse(h.mayAdminister)
    }

    func testAnOlderCoordinatorIsCannotTellNotNo() throws {
        let h = try host(#"{"hostId":"deb132","state":"healthy"}"#)
        XCTAssertNil(h.administers)
        XCTAssertTrue(h.mayAdminister)
    }
}
