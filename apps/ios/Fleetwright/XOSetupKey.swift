import CryptoKit
import Foundation

/// Is the key a machine answered `xosetup begin` with really that machine's?
///
/// THE QUESTION THIS ANSWERS. The admin sign-in is sealed to `key` so the
/// coordinator relays ciphertext it cannot read (docs/hypervisors.md). The
/// coordinator also carries `key` to the phone, so on its own it could put a
/// key of its choosing in the reply and open what the phone seals. What stops
/// that is `keySig`: the machine signs the key with its enrolment key, the
/// one whose fingerprint `fleetwright-sidecar identity` prints and the one
/// this phone may already have approved for its vault (PhoneVault). A
/// coordinator can forge neither the signature nor the fingerprint, so a key
/// that checks out under a fingerprint the person has compared is the
/// machine's and nobody else's.
///
/// WHAT IS SIGNED, exactly: the UTF-8 of "agent-fleet/v1/xosetup-key\n"
/// followed by canonical JSON of {address, job, key, pin} with the keys sorted
/// and no whitespace. Over plain HTTP there is no certificate and so no pin,
/// and the machine signs over the empty string: `"pin":""`, the two quotes
/// and nothing between, which is what this writes for "" as it is. The pin
/// is still in the signed bytes, so a key signed for a plain setup cannot be
/// passed off as one for a pinned setup at the same address, or the other
/// way round. The JSON is written out by hand rather than serialised,
/// as PhoneVault.fingerprint writes its JWK, because every value is checked to
/// be plain ASCII with nothing to escape first, and a serialiser's choices
/// about slashes and spaces are exactly the bytes this must not get wrong.
/// ECDSA P-256 over SHA-256, raw r||s, base64url without padding.
enum XOSetupKey {
    static let signingPrefix = "agent-fleet/v1/xosetup-key\n"

    /// True only when `keySig` is `hostKey`'s signature over this job's key.
    /// Anything malformed is false, never a throw: the only thing the caller
    /// does with the answer is refuse. `pin` is the certificate's SHA-256, or
    /// "" for a setup the person accepted over plain HTTP; nothing in between.
    static func isSigned(key: String, keySig: String, hostKey: Fleet.Host.PublicKey, address: String, job: String, pin: String) -> Bool {
        guard isJob(job), pin.isEmpty || isPin(pin), Seal.isKey(key), isAddress(address),
              hostKey.kty == "EC", hostKey.crv == "P-256",
              let x = Seal.unb64(hostKey.x), x.count == 32,
              let y = Seal.unb64(hostKey.y), y.count == 32,
              let raw = Seal.unb64(keySig), raw.count == 64,
              let publicKey = try? P256.Signing.PublicKey(x963Representation: Data([0x04]) + x + y),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw)
        else { return false }
        let signed = signingPrefix + "{\"address\":\"\(address)\",\"job\":\"\(job)\",\"key\":\"\(key)\",\"pin\":\"\(pin)\"}"
        return publicKey.isValidSignature(signature, for: Data(signed.utf8))
    }

    static let deploySigningPrefix = "agent-fleet/v1/xodeploy-key\n"

    /// The same question for an install: the machine signs the job's key
    /// under the install's own context, over the SHA-256 of the pool
    /// master's SSH host key in place of a certificate's: canonical JSON of
    /// {address, job, key, pin}. A setup's signature does not pass for it,
    /// nor one over another pool master's key.
    static func isSignedForDeploy(key: String, keySig: String, hostKey: Fleet.Host.PublicKey, address: String, job: String, pin: String) -> Bool {
        guard isJob(job), isPin(pin), Seal.isKey(key), isAddress(address),
              hostKey.kty == "EC", hostKey.crv == "P-256",
              let x = Seal.unb64(hostKey.x), x.count == 32,
              let y = Seal.unb64(hostKey.y), y.count == 32,
              let raw = Seal.unb64(keySig), raw.count == 64,
              let publicKey = try? P256.Signing.PublicKey(x963Representation: Data([0x04]) + x + y),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw)
        else { return false }
        let signed = deploySigningPrefix + "{\"address\":\"\(address)\",\"job\":\"\(job)\",\"key\":\"\(key)\",\"pin\":\"\(pin)\"}"
        return publicKey.isValidSignature(signature, for: Data(signed.utf8))
    }

    /// An SSH host key fingerprint as OpenSSH prints it (SSH_HOST_KEY_RE):
    /// `SHA256:` and 43 characters of base64, none of which JSON escapes.
    static func isSSHKey(_ s: String) -> Bool {
        guard s.hasPrefix("SHA256:") else { return false }
        let digest = s.dropFirst(7)
        return digest.count == 43 && digest.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/") }
    }

    /// Twelve lowercase hex digits, made by the host (XOSETUP_JOB_RE).
    static func isJob(_ s: String) -> Bool { s.count == 12 && isHex(s) }

    /// A SHA-256 certificate fingerprint, lowercase hex (CERT_PIN_RE).
    static func isPin(_ s: String) -> Bool { s.count == 64 && isHex(s) }

    /// What the protocol lets an address be made of (XO_ADDRESS_RE): letters,
    /// digits, dots and dashes, brackets round an IPv6 literal, a colon before
    /// a port. Enough to know there is nothing in it JSON would escape.
    static func isAddress(_ s: String) -> Bool {
        (1...260).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-.:[]".contains($0)) }
    }

    /// Lowercase hex only: `isHexDigit` also takes A-F, and the host writes
    /// neither.
    private static func isHex(_ s: String) -> Bool {
        s.allSatisfy { $0.isASCII && $0.isHexDigit && !$0.isUppercase }
    }

    /// A 64-hex fingerprint in groups of four, so a person can compare it
    /// against a terminal without losing their place at character thirty.
    static func grouped(_ hex: String) -> String {
        stride(from: 0, to: hex.count, by: 4).map { at in
            let start = hex.index(hex.startIndex, offsetBy: at)
            let end = hex.index(start, offsetBy: min(4, hex.count - at))
            return String(hex[start..<end])
        }.joined(separator: " ")
    }
}
