import XCTest

@testable import Fleetwright

/// A probe's certificate, decoded as the coordinator sends it
/// (`narrowCertificate`) and read back as the lines a person is shown before
/// accepting it. The same words as Android's `XoSetupTest.kt`, case for case.
///
/// WHAT IS PINNED: that every problem is said and none is invented; that a
/// certificate the machine could not read is asked about, never passed; and
/// that the coordinator's ISO dates, milliseconds included, become dates.
final class CertificateWordsTests: XCTestCase {

    private func probe(_ json: String) throws -> Fleet.Probe {
        try JSONDecoder().decode(Fleet.Probe.self, from: Data(json.utf8))
    }

    func testASelfSignedCertificateForAnotherNameSaysBoth() throws {
        let p = try probe(#"{"hostId":"deb14","reachable":true,"xo":true,"tls":true,"cert":"c5fb","certificate":{"trusted":false,"problems":["self-signed","name-mismatch"],"subject":"CN=xo.lan","issuer":"CN=xo.lan","notBefore":"2026-10-04T23:10:21.000Z","notAfter":"2027-09-29T23:10:21.000Z","names":[]},"version":null}"#)
        XCTAssertFalse(p.certificateTrusted)
        XCTAssertEqual(CertificateWords.problems(p.certificate, address: "10.0.0.5"), [
            "Self-signed: nothing but the server itself vouches for it.",
            "Issued for a different name than 10.0.0.5.",
        ])
        XCTAssertNotNil(CertificateWords.date(p.certificate?.notAfter))
        XCTAssertNotNil(p.certificate.flatMap(CertificateWords.validity))
    }

    func testACertificateNobodyReadIsAskedAbout() throws {
        let p = try probe(#"{"hostId":"deb14","reachable":true,"xo":true,"tls":true,"cert":"c5fb","version":null}"#)
        XCTAssertFalse(p.certificateTrusted)
        XCTAssertEqual(CertificateWords.problems(nil, address: "xo.lan"), ["This machine could not read the certificate’s details."])
    }

    func testTrustedOnlyWhenTheMachineSaidSo() throws {
        let p = try probe(#"{"hostId":"deb14","reachable":true,"xo":true,"tls":true,"cert":"c5fb","certificate":{"trusted":true,"problems":[],"subject":"CN=xo.example.com","issuer":"CN=R11","notBefore":null,"notAfter":"2027-01-01T00:00:00Z","names":["xo.example.com"]},"version":null}"#)
        XCTAssertTrue(p.certificateTrusted)
        XCTAssertNotNil(CertificateWords.date("2027-01-01T00:00:00Z"), "without milliseconds too")
        XCTAssertNil(CertificateWords.date("tomorrow"))
    }
}
