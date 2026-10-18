import XCTest

@testable import Fleetwright

/// PhoneVault.approval: which of the vault's grants is the person's word that
/// a key is a machine's, so an admin's sign-in is sealed to it without the
/// comparison card. PhoneVaultTest.kt is the same table on Android.
///
/// WHAT IS PINNED is that a grant scoped by `only`, the one this phone writes
/// when it lets a pool's own machine in to hold its pool's record, is not that
/// word, and that the key is held to the whole hash the minter names the
/// grant by, not to its sixteen-character prefix.
final class PhoneVaultTests: XCTestCase {

    private let key = Fleet.Host.PublicKey(kty: "EC", crv: "P-256",
                                           x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
                                           y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")
    /// boxKeyHash(key) in src/fleet/minter/vault.js, worked out there.
    private let hash = "a0a232c2f194a53553cb1310ddbc0821e414b9d7ebfc290b323084d7d1020fe5"

    private func grant(_ key: String, label: String = "deb132", only: [String] = []) -> PhoneVault.Grant {
        PhoneVault.Grant(key: key, fingerprint: String(key.prefix(16)), label: label, email: "eli@example.com", only: only)
    }

    func testTheKeyHashIsTheMintersAndTheFingerprintItsStart() {
        XCTAssertEqual(PhoneVault.keyHash(key), hash)
        XCTAssertEqual(PhoneVault.fingerprint(key), "a0a232c2f194a535")
    }

    func testAWholeVaultGrantForThatMachineByThatKeyIsApproval() {
        XCTAssertEqual(PhoneVault.approval([grant(hash)], hostId: "deb132", key: key), .approved)
    }

    func testAPoolMachinesScopedGrantIsNotApproval() {
        let holder = grant(hash, only: ["hypervisor:xo.lan"])
        XCTAssertEqual(PhoneVault.approval([holder], hostId: "deb132", key: key), PhoneVault.Approval.none)
    }

    func testTheSixteenCharacterPrefixAloneIsNotApproval() {
        let samePrefix = grant(String(hash.prefix(16)) + String(repeating: "0", count: 48))
        XCTAssertEqual(PhoneVault.approval([samePrefix], hostId: "deb132", key: key), .anotherKey)
    }

    func testAGrantUnderAnotherNameIsNotApproval() {
        XCTAssertEqual(PhoneVault.approval([grant(hash, label: "deb133")], hostId: "deb132", key: key), PhoneVault.Approval.none)
    }

    func testAnotherKeyApprovedForThatMachineIsAHardStopAndAReapprovalIsNot() {
        let old = grant(String(repeating: "1", count: 64))
        XCTAssertEqual(PhoneVault.approval([old], hostId: "deb132", key: key), .anotherKey)
        XCTAssertEqual(PhoneVault.approval([old, grant(hash)], hostId: "deb132", key: key), .approved)
    }
}
