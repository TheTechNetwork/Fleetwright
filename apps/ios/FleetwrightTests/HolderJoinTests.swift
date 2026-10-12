import XCTest

@testable import Fleetwright

/// HolderJoin against the proof src/fleet/protocol/holder-join.js makes.
/// `test/fixtures/parity/holder-join.json` is one request proved with its
/// secret written down; test/holder-join.test.js checks it with holder-join.js
/// itself, and HolderJoinTest.kt with Android's. The phone that checks a
/// request is the only party that can, so a proof this file computes
/// differently is a machine that can never be let in.
final class HolderJoinTests: XCTestCase {

    private struct Fixture: Decodable {
        let secret: String
        let hostId: String
        let address: String
        let publicJwk: Fleet.Host.PublicKey
        let keyHash: String
        let message: String
        let proof: String
    }

    private func fixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "holder-join", withExtension: "json", subdirectory: "parity") else {
            XCTFail("parity/holder-join.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testTheProofIsTheOneTheMachineMakes() throws {
        let f = try fixture()
        XCTAssertEqual(HolderJoin.keyHash(f.publicJwk), f.keyHash)
        XCTAssertEqual(HolderJoin.message(hostId: f.hostId, address: f.address, keyHash: f.keyHash), f.message)
        XCTAssertEqual(HolderJoin.proof(secret: f.secret, hostId: f.hostId, address: f.address, keyHash: f.keyHash), f.proof)
        XCTAssertNil(HolderJoin.proof(secret: "short", hostId: f.hostId, address: f.address, keyHash: f.keyHash))
    }

    func testOnlyARequestThisPhonesSecretProvesIsLetIn() throws {
        let f = try fixture()
        let real = HolderJoin.Request(key: f.keyHash, publicJwk: f.publicJwk, proof: f.proof, at: 1)
        // A request whose key is not the one it names, and one proved with another secret.
        let lying = HolderJoin.Request(key: String(repeating: "e", count: 64), publicJwk: f.publicJwk, proof: f.proof, at: 2)
        let stranger = HolderJoin.Request(key: f.keyHash, publicJwk: f.publicJwk, proof: String(repeating: "0", count: 64), at: 3)
        let waiting = HolderJoin.Waiting(hostId: f.hostId, address: f.address, madeAt: 0, until: 1, requests: [lying, stranger, real])
        let match = HolderJoin.proven(waiting, secrets: [String(repeating: "cd", count: 32), f.secret])
        XCTAssertEqual(match?.request, real)
        XCTAssertEqual(match?.secret, f.secret)
        XCTAssertNil(HolderJoin.proven(waiting, secrets: [String(repeating: "cd", count: 32)]), "another phone's secret proves nothing")
        let elsewhere = HolderJoin.Waiting(hostId: f.hostId, address: "10.10.10.231", madeAt: 0, until: 1, requests: [real])
        XCTAssertNil(HolderJoin.proven(elsewhere, secrets: [f.secret]), "a proof for one pool is not one for another")
    }
}
