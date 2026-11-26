import CryptoKit
import XCTest

@testable import Fleetwright

/// `EngineSignin.verified` against an answer a machine's own code sealed and
/// signed.
///
/// `test/fixtures/parity/engine-signin-answer.json` holds one answer to an
/// engine's sign-in as a phone is sent it: sealed to a key whose private half
/// is written there, carrying the machine's key and its signature. A seal
/// and an ECDSA signature come out different every time, so neither can be
/// made again here. What this shows is that the phone opens that answer,
/// accepts it, and refuses it once anything a person would be shown, or
/// anything that ties it to the request, is changed. `EngineSignInTest.kt`
/// does the same on Android.
///
/// WHAT IS PINNED is the order a code is reached by: opened with the
/// request's own key, then the key held to a grant for the whole vault under
/// the machine that was asked, then the signature over the request's own id,
/// member and engine. Each test fails one step and expects the answer for
/// that step and no code.
final class EngineSignInTests: XCTestCase {

    private struct Vector {
        let key: Seal.OneUseKey
        let sealed: [String: String]
        let opened: [String: Any]
        let keyId: String
        let signingInput: String
        let changed: [[String: Any]]
        var id: String { opened["id"] as? String ?? "" }
        var member: String { opened["member"] as? String ?? "" }
        var engine: String { opened["engine"] as? String ?? "" }
    }

    private func whole() throws -> [String: Any] {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "engine-signin-answer", withExtension: "json", subdirectory: "parity")
            ?? bundle.url(forResource: "engine-signin-answer", withExtension: "json")
        else {
            XCTFail("parity/engine-signin-answer.json is not in the test bundle")
            throw CocoaError(.fileNoSuchFile)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func vector() throws -> Vector {
        let part = try XCTUnwrap(try whole()["sealed"] as? [String: Any])
        let recipient = try XCTUnwrap(part["recipient"] as? [String: String])
        let secret = try XCTUnwrap(Seal.unb64(try XCTUnwrap(recipient["d"])))
        let key = Seal.OneUseKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: secret))
        XCTAssertEqual(key.publicKey, recipient["publicKey"])
        return Vector(
            key: key,
            sealed: try XCTUnwrap(part["sealed"] as? [String: String]),
            opened: try XCTUnwrap(part["opened"] as? [String: Any]),
            keyId: try XCTUnwrap(part["host"] as? String),
            signingInput: try XCTUnwrap(part["signingInput"] as? String),
            changed: try XCTUnwrap(part["changed"] as? [[String: Any]])
        )
    }

    /// The grant a custodian made for the machine that answered: the whole
    /// vault, under the name it was asked by.
    private func grant(_ v: Vector, label: String = "ops-box", only: [String] = []) -> PhoneVault.Grant {
        PhoneVault.Grant(key: v.keyId, fingerprint: String(v.keyId.prefix(16)), label: label, email: "eli@example.com", only: only)
    }

    private func check(_ v: Vector, sealed: [String: String]?, key: Seal.OneUseKey? = nil, grants: [PhoneVault.Grant]? = nil,
                       host: String = "ops-box", id: String? = nil, member: String? = nil, engine: String? = nil) -> EngineSigninCheck {
        EngineSignin.verified(sealed: sealed, key: key ?? v.key, grants: grants ?? [grant(v)], host: host,
                              id: id ?? v.id, member: member ?? v.member, engine: engine ?? v.engine)
    }

    func testAnAnswerThatPassesEveryCheckGivesTheCodeItsPageAndWhoIsSignedIn() throws {
        let v = try vector()
        let there = try XCTUnwrap(v.opened["signedIn"] as? [String: Any])
        let who = try XCTUnwrap(there["who"] as? [String: Any])
        let expected = EngineSigninSaid(
            code: v.opened["code"] as? String,
            page: v.opened["url"] as? String,
            signedIn: EngineSignedIn(since: try XCTUnwrap((there["since"] as? NSNumber)?.doubleValue),
                                     email: who["email"] as? String, plan: who["plan"] as? String)
        )
        XCTAssertNotNil(expected.code)
        XCTAssertNotNil(expected.page)
        XCTAssertEqual(check(v, sealed: v.sealed), .verified(expected))
    }

    func testAnAnswerWithNothingSealedOrSealedToAnotherKeyIsNotOpened() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: nil), .unopened)
        XCTAssertEqual(check(v, sealed: v.sealed, key: Seal.newKey()), .unopened)
        // Bound to its purpose: a vault's answer is not a machine's.
        XCTAssertThrowsError(try Seal.open(v.key, aad: Seal.vaultReplyAAD, sealed: v.sealed))
        XCTAssertNoThrow(try Seal.open(v.key, aad: Seal.engineSigninAAD, sealed: v.sealed))
    }

    func testOnlyAGrantForTheWholeVaultUnderTheMachineThatWasAskedCounts() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: v.sealed, grants: []), .unapproved)
        XCTAssertEqual(check(v, sealed: v.sealed, grants: [grant(v, only: ["codex"])]), .unapproved)
        XCTAssertEqual(check(v, sealed: v.sealed, grants: [grant(v, label: "other-box")]), .unapproved)
        // The right grant, and another machine was asked.
        XCTAssertEqual(check(v, sealed: v.sealed, host: "other-box"), .unapproved)
    }

    func testTheSignatureIsOverThisPhonesOwnRequest() throws {
        let v = try vector()
        XCTAssertEqual(check(v, sealed: v.sealed, id: v.id + "0"), .unsigned)
        XCTAssertEqual(check(v, sealed: v.sealed, member: "jason"), .unsigned)
        XCTAssertEqual(check(v, sealed: v.sealed, engine: "opencode"), .unsigned)
    }

    /// The bytes the machine signed, built the way `verified` builds them,
    /// and every change the vector lists refused under the machine's key.
    func testTheSignedBytesAreTheMachinesAndEveryChangeBreaksThem() throws {
        let v = try vector()
        let jwk = try XCTUnwrap(v.opened["hostKey"] as? [String: String])
        let hostKey = Fleet.Host.PublicKey(kty: try XCTUnwrap(jwk["kty"]), crv: try XCTUnwrap(jwk["crv"]),
                                           x: try XCTUnwrap(jwk["x"]), y: try XCTUnwrap(jwk["y"]))
        XCTAssertEqual(PhoneVault.keyHash(hostKey), v.keyId)
        let signature = try XCTUnwrap(v.opened["signature"] as? String)
        var signed = v.opened
        signed.removeValue(forKey: "hostKey")
        signed.removeValue(forKey: "signature")
        XCTAssertEqual(IntentSigning.signingInput("engine-signin-answer", signed), v.signingInput)
        XCTAssertTrue(XOSetupKey.holds(v.signingInput, sig: signature, hostKey: hostKey))
        XCTAssertFalse(v.changed.isEmpty)
        for change in v.changed {
            let field = try XCTUnwrap(change["field"] as? String)
            var other = signed
            other[field] = change["value"] ?? NSNull()
            XCTAssertFalse(XOSetupKey.holds(IntentSigning.signingInput("engine-signin-answer", other), sig: signature, hostKey: hostKey),
                           "a changed \(field) still passed")
        }
    }

    /// The answer an MCP client is sent, in the clear, has no `signedIn` key
    /// at all: the same encoder writes its bytes too.
    func testTheClearAnswersBytesAreTheMachinesToo() throws {
        let f = try whole()
        let jwk = try XCTUnwrap(f["hostKey"] as? [String: String])
        let hostKey = Fleet.Host.PublicKey(kty: try XCTUnwrap(jwk["kty"]), crv: try XCTUnwrap(jwk["crv"]),
                                           x: try XCTUnwrap(jwk["x"]), y: try XCTUnwrap(jwk["y"]))
        let context = try XCTUnwrap(f["context"] as? String)
        let input = IntentSigning.signingInput(context, try XCTUnwrap(f["payload"] as? [String: Any]))
        XCTAssertEqual(input, f["signingInput"] as? String)
        XCTAssertTrue(XOSetupKey.holds(input, sig: try XCTUnwrap(f["signature"] as? String), hostKey: hostKey))
    }

    // MARK: - what the screen shows of an answer (EngineSignin.shown)
    //
    // WHAT IS PINNED is what a person reads. Nothing the fleet wrote is
    // drawn: a refusal is this phone's own sentence for its code, and how
    // an attempt ended, why, and how long a code lasts come from inside the
    // checked answer or are not said. Each test hands `shown` an answer and
    // reads what comes out, with a lie where a fleet could put one.

    /// One of the further sealed answers under `more`, by its name
    /// (test/helpers/make-engine-signin-vectors.mjs made them).
    private func made(_ name: String) throws -> Vector {
        let all = try XCTUnwrap(try whole()["more"] as? [[String: Any]])
        let part = try XCTUnwrap(all.first { $0["name"] as? String == name }, "no vector called \(name)")
        let recipient = try XCTUnwrap(part["recipient"] as? [String: String])
        let secret = try XCTUnwrap(Seal.unb64(try XCTUnwrap(recipient["d"])))
        return Vector(
            key: Seal.OneUseKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: secret)),
            sealed: try XCTUnwrap(part["sealed"] as? [String: String]),
            opened: try XCTUnwrap(part["opened"] as? [String: Any]),
            keyId: try XCTUnwrap(part["host"] as? String),
            signingInput: try XCTUnwrap(part["signingInput"] as? String),
            changed: []
        )
    }

    /// What a fleet that lies would have somebody read: a code and a page.
    private let lie = "Enter ZZZZ-9999 at https://example.test/device"

    /// An answer as it arrives, from its JSON.
    private func reply(_ fields: [String: Any]) throws -> Fleet.Reply {
        try JSONDecoder().decode(Fleet.Reply.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    private func shown(_ v: Vector, _ fields: [String: Any], before: EngineSigninShown = EngineSigninShown(), poll: Bool = false,
                       now: Double = 0) throws -> EngineSigninShown {
        EngineSignin.shown(after: try reply(fields), before: before, poll: poll, key: v.key, grants: [grant(v)], host: "ops-box",
                           id: v.id, member: v.member, engine: v.engine, memberName: "Debbie", now: now)
    }

    /// Every word the block would draw for one machine.
    private func drawn(_ s: EngineSigninShown) -> String {
        [s.code ?? "", s.page ?? "", s.says, s.signedIn.map { EngineSigninWords.signedIn("ops-box", $0) } ?? ""].joined(separator: " ")
    }

    private let codexPage = "https://auth.openai.com/codex/device"

    func testARefusalIsThisPhonesOwnSentenceAndNothingTheFleetWroteIsDrawn() throws {
        let v = try vector()
        let before = EngineSigninShown(code: "WXYZ-1234", page: codexPage)
        for (code, poll) in [("host_timeout", true), ("not_approved", false), ("made_up_code", false), ("ZZZZ-9999", false)] {
            let got = try shown(v, ["ok": false, "error": ["code": code], "text": lie, "detail": lie, "state": "failed"], before: before, poll: poll)
            XCTAssertFalse(drawn(got).contains("ZZZZ"), "a refusal with \(code) drew the fleet’s code")
            XCTAssertFalse(drawn(got).contains("example.test"), "a refusal with \(code) drew the fleet’s page")
            XCTAssertTrue(got.bad)
            XCTAssertFalse(got.says.isEmpty)
        }
        // A code it knows says what to do; one it does not names the machine
        // and the code; one that is not shaped like a code is not printed.
        XCTAssertEqual(try shown(v, ["ok": false, "error": ["code": "host_timeout"], "text": lie]).says, "ops-box did not answer in time. Try again.")
        XCTAssertEqual(try shown(v, ["ok": false, "error": ["code": "made_up_code"], "text": lie]).says, "ops-box refused that (made_up_code).")
        XCTAssertEqual(try shown(v, ["ok": false, "error": ["code": "ZZZZ-9999"], "text": lie]).says, "ops-box refused that.")
        // BESIDE A CODE TO ENTER, a code it has not met is not printed
        // either: letters and underscores are enough to spell a code of the
        // fleet's own under the real one. Whether the asking was refused
        // or a button was.
        for poll in [true, false] {
            let beside = try shown(v, ["ok": false, "error": ["code": "enter_wdjb_mjht_instead"], "state": "waiting"], before: before, poll: poll)
            XCTAssertEqual(beside.code, "WXYZ-1234")
            XCTAssertEqual(beside.says, "ops-box refused that.")
        }
        // The box's own faults are not refusals, and none is printed as a
        // code: each says what a box that does not answer says.
        for code in ["hub_unreachable", "hub_error", "hub_unauthorised", "internal"] {
            XCTAssertEqual(try shown(v, ["ok": false, "error": ["code": code], "text": lie]).says,
                           "fleetwright on ops-box is not answering. Try again, and if it goes on, whoever runs ops-box restarts it.")
        }
        // No code at all is the fleet not answering: one fixed sentence, and
        // what was checked before stands.
        let unreached = try shown(v, ["ok": false, "text": lie], before: before)
        XCTAssertEqual(unreached.says, EngineSigninWords.notReached)
        XCTAssertEqual(unreached.code, "WXYZ-1234")
    }

    func testARefusedAskOfWhereItStandsKeepsTheCodeAndARefusedButtonDoesNot() throws {
        let v = try vector()
        let before = EngineSigninShown(signedIn: EngineSignedIn(since: 1, email: nil, plan: nil), code: "WXYZ-1234", page: codexPage, expiresAt: 540_000)
        // The asking every few seconds, refused once: everything stays.
        let polled = try shown(v, ["ok": false, "error": ["code": "host_timeout"]], before: before, poll: true)
        XCTAssertEqual([polled.code, polled.page], ["WXYZ-1234", codexPage])
        XCTAssertEqual(polled.expiresAt, 540_000)
        XCTAssertEqual(polled.signedIn, before.signedIn)
        XCTAssertTrue(polled.bad)
        // A button refused: the code goes unless the refusal says one is out.
        let pressed = try shown(v, ["ok": false, "error": ["code": "busy"]], before: before)
        XCTAssertNil(pressed.code)
        XCTAssertEqual(pressed.signedIn, before.signedIn)
        let still = try shown(v, ["ok": false, "error": ["code": "answer_unsigned"], "state": "waiting"], before: before)
        XCTAssertEqual(still.code, "WXYZ-1234")
    }

    func testAMachineThatCannotTellYetTakesNothingAwayAndIsAskedAgain() throws {
        // It did not hear how the last sign-in ended. That is not "nobody is
        // signed in" and not a fault: whatever asked, what was checked
        // stays, the sentence says it is asked again, and it is.
        let v = try vector()
        let before = EngineSigninShown(signedIn: EngineSignedIn(since: 1, email: "debbie@example.com", plan: nil), code: "WXYZ-1234", page: codexPage, expiresAt: 540_000)
        for poll in [true, false] {
            let got = try shown(v, ["ok": false, "error": ["code": "cannot_tell"], "text": lie], before: before, poll: poll)
            XCTAssertEqual(got.signedIn, before.signedIn)
            XCTAssertEqual([got.code, got.page], ["WXYZ-1234", codexPage])
            XCTAssertEqual(got.expiresAt, 540_000)
            XCTAssertTrue(got.unsure, "a machine that cannot tell yet is not asked again")
            XCTAssertFalse(got.bad)
            XCTAssertEqual(got.says, "It is not known yet whether Codex is signed in on ops-box: ops-box did not hear how the last sign-in ended. It is asked again in a moment, by itself.")
        }
        // With nothing checked before, it is still asked again, and still
        // says only that it cannot tell.
        let fresh = try shown(v, ["ok": false, "error": ["code": "cannot_tell"]], poll: true)
        XCTAssertTrue(fresh.unsure)
        XCTAssertNil(fresh.signedIn)
        XCTAssertFalse(fresh.says.isEmpty)
        // Any other refused ask keeps what was checked and is not that.
        XCTAssertFalse(try shown(v, ["ok": false, "error": ["code": "host_timeout"]], before: before, poll: true).unsure)
    }

    func testACodeIsDrawnOnlyFromACheckedAnswerAndOnlyBesideTheEnginesOwnPage() throws {
        // The machine's own page: the code and its page, and nothing of the
        // lies beside the seal.
        let v = try vector()
        let got = try shown(v, ["ok": true, "state": "failed", "detail": lie, "text": lie, "expiresInMinutes": 99, "sealed": v.sealed])
        XCTAssertEqual([got.code, got.page], ["WXYZ-1234", codexPage])
        XCTAssertFalse(drawn(got).contains("ZZZZ"))
        // A machine from before it signed when the code runs out: how long a
        // code lasts, and no count.
        XCTAssertNil(got.expiresAt)
        XCTAssertTrue(got.fixedLife)
        XCTAssertEqual(EngineSigninWords.waiting("OpenAI", minutes: EngineSignin.minutesLeft(got.expiresAt, now: 0), fixedLife: got.fixedLife),
                       "Waiting for this code to be approved at OpenAI. A code lasts 15 minutes.")
        // Signed, and beside a page that is not OpenAI's: no code, no page,
        // one sentence, and Cancel.
        let f = try made("foreign-page")
        let foreign = try shown(f, ["ok": true, "state": "waiting", "sealed": f.sealed])
        XCTAssertNil(foreign.code)
        XCTAssertNil(foreign.page)
        XCTAssertTrue(foreign.cancel)
        XCTAssertEqual(foreign.says, "ops-box gave a sign-in page that is not OpenAI’s, so the code is not shown. Cancel it, and tell whoever runs this fleet.")
        XCTAssertFalse(drawn(foreign).contains("LMNO"))
        // And the word beside an answer never makes a code or a sign-in.
        let none = try made("none")
        for state in ["waiting", "signed_in"] {
            let said = try shown(none, ["ok": true, "state": state, "signedIn": ["since": 5], "sealed": none.sealed])
            XCTAssertNil(said.code)
            XCTAssertNil(said.signedIn)
            XCTAssertEqual(said.says, "")
        }
    }

    func testTheEndOfACodeIsKeptOnlyWhereItCanBeRightAgainstThisPhonesClock() throws {
        let v = try made("next-waiting")
        let ends = try XCTUnwrap((v.opened["expiresAt"] as? NSNumber)?.doubleValue)
        let answer: [String: Any] = ["ok": true, "state": "waiting", "expiresInMinutes": 99, "sealed": v.sealed]
        let midway = try shown(v, answer, now: ends - 7.5 * 60_000)
        XCTAssertEqual(midway.code, "QRST-5678")
        XCTAssertEqual(midway.expiresAt, ends)
        XCTAssertFalse(midway.fixedLife)
        XCTAssertEqual(EngineSignin.minutesLeft(midway.expiresAt, now: ends - 7.5 * 60_000), 8)
        XCTAssertEqual(try shown(v, answer, now: ends - 15 * 60_000).expiresAt, ends)
        // More than a code lasts, or already past, by a machine that has
        // just said the code is out: two clocks disagree. No end is kept, so
        // no number is said, and the code is not taken off the screen for it.
        for now in [ends - 16 * 60_000, ends + 1, ends + 60 * 60_000] {
            let got = try shown(v, answer, now: now)
            XCTAssertNil(got.expiresAt)
            XCTAssertEqual(EngineSignin.at(got, box: "ops-box", now: now).code, "QRST-5678")
        }
        XCTAssertEqual(EngineSigninWords.waiting("OpenAI", minutes: nil, fixedLife: false), "Waiting for this code to be approved at OpenAI.")
        XCTAssertEqual(EngineSigninWords.waiting("OpenAI", minutes: 8, fixedLife: false), "Waiting for this code to be approved at OpenAI. It lasts 8 more minutes.")
    }

    func testTheMinutesAreCountedAsTheyAreDrawnAndACodePastItsEndIsNotDrawn() throws {
        // A checked answer twelve minutes before the code's end, and from
        // then on the asking is refused: what is kept does not change, and
        // the count used to stay at twelve, past the end.
        let v = try made("next-waiting")
        let ends = try XCTUnwrap((v.opened["expiresAt"] as? NSNumber)?.doubleValue)
        let first = try shown(v, ["ok": true, "state": "waiting", "sealed": v.sealed], now: ends - 12 * 60_000)
        let kept = try shown(v, ["ok": false, "error": ["code": "host_timeout"]], before: first, poll: true, now: ends - 60_000)
        XCTAssertEqual([kept.code, kept.page], ["QRST-5678", codexPage])
        XCTAssertEqual(kept.expiresAt, ends)
        func said(_ now: Double) -> String {
            let one = EngineSignin.at(kept, box: "ops-box", now: now)
            return one.code == nil ? one.says
                : EngineSigninWords.waiting("OpenAI", minutes: EngineSignin.minutesLeft(one.expiresAt, now: now), fixedLife: one.fixedLife)
        }
        XCTAssertEqual(said(ends - 12 * 60_000), "Waiting for this code to be approved at OpenAI. It lasts 12 more minutes.")
        XCTAssertEqual(said(ends - 3 * 60_000), "Waiting for this code to be approved at OpenAI. It lasts 3 more minutes.")
        XCTAssertEqual(said(ends - 20_000), "Waiting for this code to be approved at OpenAI. It lasts 1 more minute.")
        // Just past its end, the machine is left to say so itself: the code
        // is there for those seconds, with no count.
        XCTAssertEqual(said(ends + 1), "Waiting for this code to be approved at OpenAI.")
        // Then it is not drawn, nor its page, and the sentence says only
        // what this phone knows.
        let over = EngineSignin.at(kept, box: "ops-box", now: ends + EngineSignin.endSlack)
        XCTAssertNil(over.code)
        XCTAssertNil(over.page)
        XCTAssertTrue(over.bad)
        XCTAssertEqual(over.says, "This code has run out, so it is not shown. ops-box has not said whether it was approved in time, and is asked again in a moment, by itself. Start again for a new code.")
        XCTAssertFalse(drawn(over).contains("QRST"))
        // Nothing kept is changed, so the machine goes on being asked.
        XCTAssertEqual(kept.code, "QRST-5678")
        // Who is signed in was checked, and stays.
        var standing = kept
        standing.signedIn = EngineSignedIn(since: 1, email: "debbie@example.com", plan: nil)
        XCTAssertEqual(EngineSignin.at(standing, box: "ops-box", now: ends + 60_000).signedIn, standing.signedIn)
        // A machine that did not say when its code runs out is never taken
        // off the screen by a clock.
        let old = EngineSigninShown(code: "WXYZ-1234", page: codexPage, fixedLife: true)
        XCTAssertEqual(EngineSignin.at(old, box: "ops-box", now: ends * 2), old)
    }

    func testCodexSignedInNamesItsAccountAndAReasonKeepsItsQuotesAndSlashes() throws {
        // What a box answers most: Codex signed in, with its account inside
        // what is signed. Whatever word is beside the answer.
        let v = try made("next-signed-in")
        let there = try XCTUnwrap(v.opened["signedIn"] as? [String: Any])
        let since = try XCTUnwrap((there["since"] as? NSNumber)?.doubleValue)
        let got = try shown(v, ["ok": true, "state": "none", "detail": lie, "sealed": v.sealed])
        XCTAssertEqual(got.signedIn, EngineSignedIn(since: since, email: "debbie@example.com", plan: "plus"))
        XCTAssertNil(got.code)
        XCTAssertEqual(got.says, "")
        XCTAssertFalse(got.bad)
        XCTAssertTrue(EngineSigninWords.signedIn("ops-box", try XCTUnwrap(got.signedIn)).hasPrefix("Signed in on ops-box as debbie@example.com, on the plus plan, since "))
        // An engine's reason with a quote, a backslash and a slash in it:
        // checked over the bytes the machine signed, and drawn as it wrote it.
        let q = try made("next-failed-quoted")
        XCTAssertEqual(try shown(q, ["ok": true, "state": "failed", "detail": lie, "sealed": q.sealed]).says,
                       #"Codex did not sign in: the provider said "no" for C:\Users\debbie at /codex/device"#)
    }

    func testHowItEndedIsTheMachinesCheckedWordWhereItSignedOne() throws {
        // The next shape: the checked state and reason, whatever is beside it.
        let failed = try made("next-failed")
        let got = try shown(failed, ["ok": true, "state": "cancelled", "detail": lie, "sealed": failed.sealed])
        XCTAssertEqual(got.says, "Codex did not sign in: device auth failed with status 403 Forbidden")
        XCTAssertTrue(got.bad)
        // A machine from before that: this phone's fixed sentence for the
        // word beside the answer, and no reason at all.
        let none = try made("none")
        let old = try shown(none, ["ok": true, "state": "failed", "detail": lie, "sealed": none.sealed])
        XCTAssertEqual(old.says, "Codex did not sign in.")
        XCTAssertEqual(try shown(none, ["ok": true, "state": "expired", "sealed": none.sealed]).says,
                       "The code ran out before it was approved. Start again for a new one.")
        // Beside a sign-in the machine signed for, "did not sign in" is said
        // of a newer attempt, and "signed out" is not said at all.
        let signedIn = try made("opencode-signed-in")
        let standing = try shown(signedIn, ["ok": true, "state": "failed", "detail": lie, "sealed": signedIn.sealed])
        XCTAssertNotNil(standing.signedIn)
        XCTAssertNil(standing.signedIn?.email)
        XCTAssertEqual(standing.says, "A newer attempt did not sign in. The sign-in above stands.")
        XCTAssertEqual(try shown(signedIn, ["ok": true, "state": "signed_out", "sealed": signedIn.sealed]).says, "")
        XCTAssertEqual(EngineSigninWords.signedIn("ops-box", EngineSignedIn(since: 0, email: "debbie@example.com", plan: "plus")),
                       "Signed in on ops-box as debbie@example.com, on the plus plan.")
    }

    // MARK: - where it is offered (EngineSignin.places)

    private func machine(_ health: String, takes: Bool = true) throws -> Fleet.FleetHost {
        let json = #"{"hostId":"ops-box","state":"healthy","takesSessions":"# + (takes ? "true" : "false") + #","health":"# + health + "}"
        return try JSONDecoder().decode(Fleet.FleetHost.self, from: Data(json.utf8))
    }

    func testSignInIsOfferedOnlyOnAMachineThatWouldTakeItAndWhatIsMissingIsSaid() throws {
        let v = try vector()
        let jwk = try XCTUnwrap(v.opened["hostKey"] as? [String: String])
        let keyJSON = #"{"hostId":"ops-box","fingerprint":"0000000000000000","publicJwk":{"kty":"EC","crv":"P-256","x":""# + (jwk["x"] ?? "") + #"","y":""# + (jwk["y"] ?? "") + #""}}"#
        let keys = [try JSONDecoder().decode(Fleet.Host.self, from: Data(keyJSON.utf8))]
        let runs = #"{"protocol":22,"engines":["claude-code","codex"]}"#
        func places(_ host: Fleet.FleetHost?, grants: [PhoneVault.Grant]) -> EngineSigninPlaces {
            EngineSignin.places(engine: "codex", hosts: host.map { [$0] } ?? [], keys: keys, grants: grants, member: "Debbie")
        }
        XCTAssertEqual(places(try machine(runs), grants: [grant(v)]), EngineSigninPlaces(offered: ["ops-box"]))
        // One protocol too old: not offered, and said.
        XCTAssertEqual(places(try machine(#"{"protocol":21,"engines":["claude-code","codex"]}"#), grants: [grant(v)]),
                       EngineSigninPlaces(missing: "ops-box runs Codex and is too old to sign it in. Update fleetwright on ops-box."))
        // Not approved for the whole vault under its own name.
        let short: [[PhoneVault.Grant]] = [[], [grant(v, only: ["codex"])], [grant(v, label: "other-box")]]
        for grants in short {
            XCTAssertEqual(places(try machine(runs), grants: grants),
                           EngineSigninPlaces(missing: "ops-box runs Codex and is not approved for Debbie’s credentials. Approve it below, then sign in."))
        }
        // Does not run it, or cannot take a session now.
        let nowhere = EngineSigninPlaces(missing: "No machine that can take a session now runs Codex.")
        XCTAssertEqual(places(try machine(#"{"protocol":22,"engines":["claude-code"]}"#), grants: [grant(v)]), nowhere)
        XCTAssertEqual(places(try machine(runs, takes: false), grants: [grant(v)]), nowhere)
        // No machine heard from: nothing is said, which is not "none".
        XCTAssertEqual(places(nil, grants: [grant(v)]), EngineSigninPlaces())
    }
}
