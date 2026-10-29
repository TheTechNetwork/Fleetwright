import CryptoKit
import XCTest

@testable import Fleetwright

/// `PushCrypto.swift` against the envelope the coordinator's own code sealed.
///
/// `test/fixtures/parity/push-envelope.json` is one notification sealed by
/// `envelopeFor` in `src/fleet/push.js`. `test/push-envelope-parity.test.js`
/// opens it with that code. This opens the same bytes, which is the only way
/// to know a phone will read what a fleet sends. `PushCryptoTest.kt` does the
/// same.
final class PushCryptoTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Recipient: Decodable { let d: String; let pushKey: String }
        struct Plaintext: Decodable {
            let title: String
            let body: String
            let data: [String: String]
        }
        let recipient: Recipient
        let envelope: String
        let plaintext: Plaintext
    }

    private func fixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "push-envelope", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "push-envelope", withExtension: "json")
        else {
            XCTFail("parity/push-envelope.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func scalar(_ b64: String) throws -> Data {
        var raw = try XCTUnwrap(PushCrypto.unb64(b64))
        if raw.count < 32 {
            raw = Data(repeating: 0, count: 32 - raw.count) + raw
        }
        return raw
    }

    private func recipientKey(_ f: Fixture) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: try scalar(f.recipient.d))
    }

    func testOpensWhatTheCoordinatorSealed() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        XCTAssertEqual(PushCrypto.b64url(key.publicKey.x963Representation), f.recipient.pushKey)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        XCTAssertEqual(opened.title, f.plaintext.title)
        XCTAssertEqual(opened.body, f.plaintext.body)
        XCTAssertEqual(opened.data, f.plaintext.data)
    }

    func testAFlippedBitDoesNotOpen() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        var bytes = try XCTUnwrap(PushCrypto.unb64(f.envelope))
        bytes[bytes.count - 1] ^= 0x01
        XCTAssertThrowsError(try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: PushCrypto.b64url(bytes)))
    }

    func testTheButtonFieldsReplaceTheCiphertext() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: f.envelope)
        let merged = PushCrypto.merged(userInfo: ["e": f.envelope], opened: opened)
        XCTAssertNil(merged["e"])
        // What a press and a tap read: the answer, its age, and where to go.
        for field in ["promptId", "answers", "sentAt", "name", "hostId", "event"] {
            XCTAssertEqual(merged[field] as? String, f.plaintext.data[field], field)
        }
    }

    /// The buttons come from the sealed category, and a clear one that
    /// disagrees with it leaves none.
    func testTheSealedCategoryDecidesTheButtons() throws {
        let sealed = try XCTUnwrap(try fixture().plaintext.data["category"])
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: sealed), sealed)
        // Changed on the way: no buttons rather than the wrong words.
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: "fleet.prompt.trust"), "")
        // A sealed "nothing to answer" is not overruled by a clear one added on the way.
        XCTAssertEqual(PushCrypto.category(sealed: "", clear: sealed), "")
        // Dropped on the way: the sealed one is still there.
        XCTAssertEqual(PushCrypto.category(sealed: sealed, clear: ""), sealed)
        // A coordinator from before the category was sealed: the clear one, as always.
        XCTAssertEqual(PushCrypto.category(sealed: nil, clear: sealed), sealed)
    }

    /// A seal that was not opened keeps no buttons, whether the key could
    /// not open it or the extension ran out of time: what they would answer
    /// is still sealed, and a press would do nothing. One that was never
    /// sealed keeps its own.
    func testASealThatWasNotOpenedDrawsNoButtons() throws {
        let f = try fixture()
        let clear = try XCTUnwrap(f.plaintext.data["category"])
        XCTAssertEqual(PushCrypto.categoryUnopened(userInfo: ["e": f.envelope], clear: clear), "")
        XCTAssertEqual(PushCrypto.categoryUnopened(userInfo: ["promptId": "p-01J8"], clear: clear), clear)
    }

    /// A key the keychain keeps refusing is replaced, so a phone does not
    /// stop registering for good; and only after three failures in a row
    /// with the first a day or more before. The same cases as
    /// `PushCryptoTest.kt`.
    func testAKeyIsReplacedOnlyAfterThreeFailuresOverADay() {
        let t0: TimeInterval = 1_700_000_000
        let day = PushKeyRule.span
        let fail = { (before: PushKeyRule.Failures?, at: TimeInterval) in PushKeyRule.failed(before, now: at) }

        // Three in two minutes is one bad moment.
        let quick = fail(fail(fail(nil, t0), t0 + 60), t0 + 120)
        XCTAssertFalse(PushKeyRule.startOver(quick, now: t0 + 120))
        // The first is kept, so the next one a day on is enough.
        XCTAssertTrue(PushKeyRule.startOver(fail(quick, t0 + day), now: t0 + day))

        // A day apart, but only two.
        XCTAssertFalse(PushKeyRule.startOver(fail(fail(nil, t0), t0 + day), now: t0 + day))
        // Three, the last a day after the first.
        XCTAssertTrue(PushKeyRule.startOver(fail(fail(fail(nil, t0), t0 + 3600), t0 + day), now: t0 + day))

        // A clock that went backwards starts the count again.
        XCTAssertEqual(fail(quick, t0 - 1), PushKeyRule.Failures(count: 1, firstAt: t0 - 1))
    }

    /// A phone that has sent a key never registers without one: a key error
    /// sends the last key sent, before the threshold and when the
    /// replacement after it fails. Only a phone that has never sent one
    /// registers keyless, and at once. A replacement that fails keeps the
    /// count, and no key at all with one sent is a failure like any other:
    /// only a key the phone holds clears the count. The same cases as
    /// `PushCryptoTest.kt`.
    func testAKeyErrorSendsTheLastKeySentAndNeverNone() {
        struct Locked: Error {}
        let t0: TimeInterval = 1_700_000_000
        let day = PushKeyRule.span
        let broken: () throws -> String? = { throw Locked() }
        var replaced = 0
        let replaceFails: () -> String? = { replaced += 1; return nil }

        // An error with a key already sent: that key goes, and the error counts.
        let first = PushKeyRule.choose(failures: nil, sent: "K1", now: t0, read: broken, replace: replaceFails)
        XCTAssertEqual(first.pushKey, "K1")
        XCTAssertEqual(first.failures, PushKeyRule.Failures(count: 1, firstAt: t0))
        XCTAssertFalse(first.replaced)

        // Never sent one: keyless at once, with nothing to lose.
        let fresh = PushKeyRule.choose(failures: nil, sent: nil, now: t0, read: broken, replace: replaceFails)
        XCTAssertNil(fresh.pushKey)
        XCTAssertEqual(fresh.failures?.count, 1)

        // Past the threshold the key is replaced; when that fails too, the
        // last key sent still goes, a key the phone no longer holds, and the
        // count is kept, so the next registration tries again.
        let due = PushKeyRule.Failures(count: 2, firstAt: t0)
        let after = PushKeyRule.choose(failures: due, sent: "K1", now: t0 + day, read: broken, replace: replaceFails)
        XCTAssertEqual(replaced, 1)
        XCTAssertTrue(after.replaced)
        XCTAssertEqual(after.pushKey, "K1")
        XCTAssertFalse(after.holds)
        XCTAssertEqual(after.failures, PushKeyRule.Failures(count: 3, firstAt: t0))

        // A replacement that works sends the new key, and clears the count.
        let renewed = PushKeyRule.choose(failures: due, sent: "K1", now: t0 + day, read: broken, replace: { "K2" })
        XCTAssertEqual(renewed.pushKey, "K2")
        XCTAssertTrue(renewed.holds)
        XCTAssertNil(renewed.failures)

        // No key at all, with one sent: the one sent goes, sealed rather
        // than plaintext, and it counts, since its private half is gone.
        let gone = PushKeyRule.choose(failures: nil, sent: "K1", now: t0, read: { nil }, replace: replaceFails)
        XCTAssertEqual(gone.pushKey, "K1")
        XCTAssertFalse(gone.holds)
        XCTAssertNotNil(gone.failure)
        XCTAssertEqual(gone.failures, PushKeyRule.Failures(count: 1, firstAt: t0))
        // And past the threshold it is a reason to make a new one, which is
        // what heals it.
        let goneDue = PushKeyRule.choose(failures: due, sent: "K1", now: t0 + day, read: { nil }, replace: replaceFails)
        XCTAssertEqual(replaced, 2)
        XCTAssertEqual(goneDue.pushKey, "K1")
        XCTAssertEqual(goneDue.failures, PushKeyRule.Failures(count: 3, firstAt: t0))
        // None at all and none ever sent: keyless, with nothing to count.
        let never = PushKeyRule.choose(failures: nil, sent: nil, now: t0, read: { nil }, replace: replaceFails)
        XCTAssertNil(never.pushKey)
        XCTAssertNil(never.failures)
        XCTAssertTrue(never.holds)

        // A key that reads clears the count and is what goes.
        let fine = PushKeyRule.choose(failures: due, sent: "K1", now: t0, read: { "K2" }, replace: replaceFails)
        XCTAssertEqual(fine.pushKey, "K2")
        XCTAssertNil(fine.failures)
        XCTAssertNil(fine.failure)
        XCTAssertTrue(fine.holds)
        XCTAssertEqual(replaced, 2)
    }

    /// What You says rests on this: whether the phone knows it can open what
    /// is sealed to it. A key it could not use is doubt until a key it holds
    /// is sent or a seal opens; a seal that did not open is doubt until one
    /// opens or a new key is sent; and nothing older than what is known
    /// overrides it. The same cases as `PushCryptoTest.kt`.
    func testThePhoneSaysWhenItDoesNotKnowItCanOpenItsNotifications() {
        struct Locked: Error {}
        let t0: TimeInterval = 1_700_000_000
        let broken: () throws -> String? = { throw Locked() }
        let none: () -> String? = { nil }
        let held = PushKeyRule.choose(failures: nil, sent: "K1", now: t0, read: { "K1" }, replace: none)
        let unusable = PushKeyRule.choose(failures: nil, sent: "K1", now: t0, read: broken, replace: none)
        let renewed = PushKeyRule.choose(failures: nil, sent: "K1", now: t0, read: { "K2" }, replace: none)
        let keyless = PushKeyRule.choose(failures: nil, sent: nil, now: t0, read: broken, replace: none)

        // A key it could not use, and the same key read later.
        let doubted = PushKeyRule.afterRegistration(nil, choice: unusable, sent: "K1", now: t0)
        XCTAssertEqual(doubted, PushKeyRule.Evidence(doubt: .key, at: t0))
        XCTAssertNil(PushKeyRule.afterRegistration(doubted, choice: held, sent: "K1", now: t0 + 1)?.doubt)
        // Keyless is plaintext, which this phone reads.
        XCTAssertNil(PushKeyRule.afterRegistration(doubted, choice: keyless, sent: nil, now: t0 + 1)?.doubt)

        // A seal that did not open is not answered by the app reading the
        // key: the extension is another process. A seal that opens, or a
        // new key, answers it.
        let unopened = PushKeyRule.afterSeal(nil, opened: false, at: t0 + 10)
        XCTAssertEqual(unopened?.doubt, .seal)
        XCTAssertEqual(PushKeyRule.afterRegistration(unopened, choice: held, sent: "K1", now: t0 + 20), unopened)
        XCTAssertNil(PushKeyRule.afterSeal(unopened, opened: true, at: t0 + 30)?.doubt)
        let fresh = PushKeyRule.afterRegistration(unopened, choice: renewed, sent: "K1", now: t0 + 20)
        XCTAssertEqual(fresh, PushKeyRule.Evidence(doubt: nil, at: t0 + 20))
        // A notification from before the new key, still in Notification
        // Center, is old news.
        XCTAssertEqual(PushKeyRule.afterSeal(fresh, opened: false, at: t0 + 10), fresh)
        // Nothing learnt yet, and a held key: still nothing learnt, so a
        // notification the extension could not open before this launch
        // still counts when You reads Notification Center.
        XCTAssertNil(PushKeyRule.afterRegistration(nil, choice: held, sent: "K1", now: t0 + 20))

        // What the app sees of one: `e` left means not opened, and
        // `mutable-content` is only ever on a sealed one.
        XCTAssertEqual(PushKeyRule.sealOpened(["e": "x", "aps": ["mutable-content": 1]]), false)
        XCTAssertEqual(PushKeyRule.sealOpened(["aps": ["mutable-content": 1], "name": "s"]), true)
        XCTAssertNil(PushKeyRule.sealOpened(["aps": ["alert": "a"], "name": "s"]))
    }

    /// The self-test registration runs before it sends a key.
    func testTheSelfTestOpensItsOwnSealAndNoOneElses() throws {
        let f = try fixture()
        let key = try recipientKey(f)
        XCTAssertTrue(PushKey.opensItsOwnSeal(key))

        // The seal is the coordinator's scheme, so the key opens what it seals.
        let recipient = try XCTUnwrap(PushCrypto.unb64(f.recipient.pushKey))
        let envelope = try PushCrypto.seal(to: recipient, title: "a", body: "b")
        let opened = try PushCrypto.open(privateKey: key, recipientPublic: recipient, envelope: envelope)
        XCTAssertEqual(opened.title, "a")
        XCTAssertEqual(opened.body, "b")

        // And only for the key it was sealed to.
        let other = P256.KeyAgreement.PrivateKey()
        XCTAssertThrowsError(try PushCrypto.open(
            privateKey: other, recipientPublic: other.publicKey.x963Representation, envelope: envelope
        ))
    }
}
