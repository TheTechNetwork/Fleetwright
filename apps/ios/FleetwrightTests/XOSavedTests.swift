import XCTest

@testable import Fleetwright

/// XOSaved.Entry: what a kept acceptance stands for. The screen skips the
/// certificate question when `accepts` says yes, so a rule that drifted here
/// would be a certificate nobody looked at, sent a password. The Keychain
/// item itself needs a device with biometrics and is held by
/// test/xo-saved-in-apps.test.js.
final class XOSavedTests: XCTestCase {

    private let pin = String(repeating: "ab", count: 32)

    private func probe(cert: String?, tls: Bool?) -> Fleet.Probe {
        Fleet.Probe(hostId: "box", reachable: true, xo: true, tls: tls, cert: cert, certificate: nil, version: nil)
    }

    private func entry(pin: String?, plain: Bool) -> XOSaved.Entry {
        XOSaved.Entry(login: nil, accepted: .init(pin: pin, plain: plain), savedAt: Date())
    }

    func testAcceptsTheSameCertificateOnly() {
        let kept = entry(pin: pin, plain: false)
        XCTAssertTrue(kept.accepts(probe(cert: pin, tls: true)))
        XCTAssertFalse(kept.accepts(probe(cert: String(repeating: "cd", count: 32), tls: true)))
        // An address that now answers without HTTPS is a different answer.
        XCTAssertFalse(kept.accepts(probe(cert: nil, tls: false)))
    }

    func testPlainHTTPIsAcceptedOnlyForPlainHTTP() {
        let kept = entry(pin: nil, plain: true)
        XCTAssertTrue(kept.accepts(probe(cert: nil, tls: false)))
        XCTAssertFalse(kept.accepts(probe(cert: pin, tls: true)))
        // A machine that did not say which it reached is neither.
        XCTAssertFalse(kept.accepts(probe(cert: nil, tls: nil)))
    }

    func testNoAcceptanceAcceptsNothing() {
        let kept = XOSaved.Entry(login: .init(email: "a@b", password: "p"), accepted: nil, savedAt: Date())
        XCTAssertFalse(kept.accepts(probe(cert: pin, tls: true)))
        XCTAssertFalse(kept.accepts(probe(cert: nil, tls: false)))
    }

    func testRoundTripsThroughJSON() throws {
        let kept = XOSaved.Entry(login: .init(email: "a@b", password: "p"), accepted: .init(pin: pin, plain: false),
                                 savedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let back = try JSONDecoder().decode(XOSaved.Entry.self, from: JSONEncoder().encode(kept))
        XCTAssertEqual(back, kept)
    }
}
