import CryptoKit
import Foundation

/// The person's vault, from this phone: what they keep in the fleet's minting
/// Worker once, and which of their boxes may hold it. PhoneVault.kt is the same
/// thing on Android. See docs/vault.md, and src/fleet/minter/vault.js for the
/// other end.
///
/// EVERY REQUEST IS SEALED to the minter's key (PhoneGitHub.minterKey), with this
/// phone's GitHub token inside so the minter can ask GitHub whose vault it is,
/// and the fleet account it is for. The answer comes back sealed to a key this
/// phone made for that one request. The coordinator relays both and reads
/// neither.
///
/// APPROVING A BOX names the box's own public key, as the fleet listed it. This
/// phone works out the fingerprint from that key itself (`fingerprint`) for the
/// person to compare with `fleetwright-sidecar identity` on the box, because a
/// coordinator that wanted a person's credentials would offer its own key here.
struct PhoneVault {
    let settings: Settings

    struct Item: Hashable {
        let name: String
        let at: Double
    }

    struct Grant: Hashable {
        let key: String
        let fingerprint: String
        let label: String
        let email: String
    }

    struct Contents: Hashable {
        let items: [Item]
        let grants: [Grant]
    }

    /// Seal one request, relay it, open the answer.
    private func ask(_ fleet: Fleet, op: String, extra: [String: Any] = [:]) async throws -> (text: String, answer: [String: Any]) {
        let pin = try await PhoneGitHub(settings: settings).minterKey(fleet)
        let email = settings.signedInAs.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else {
            throw FleetError.message("This phone does not know which fleet account it is signed in as. Sign in to the fleet again.")
        }
        let github = try await PhoneGitHub(settings: settings).accessToken(fleet)
        let reply = Seal.newKey()
        var payload = extra
        payload["v"] = 1
        payload["github"] = github
        payload["email"] = email
        payload["op"] = op
        payload["at"] = Int(Date().timeIntervalSince1970 * 1000)
        payload["reply"] = reply.publicKey
        let r = try await fleet.vault(sealed: try Seal.seal(to: pin, aad: Seal.vaultRequestAAD, payload: payload))
        guard r["ok"] as? Bool == true, let box = r["sealed"] as? [String: Any] else {
            throw FleetError.message(r["text"] as? String ?? "The vault refused that.")
        }
        let answer = try Seal.open(reply, aad: Seal.vaultReplyAAD, sealed: box)
        return (r["text"] as? String ?? "", answer)
    }

    func list(_ fleet: Fleet) async throws -> Contents {
        let answer = try await ask(fleet, op: "list").answer
        let items = (answer["items"] as? [[String: Any]] ?? []).map {
            Item(name: $0["name"] as? String ?? "", at: ($0["at"] as? NSNumber)?.doubleValue ?? 0)
        }
        let grants = (answer["grants"] as? [[String: Any]] ?? []).map {
            Grant(key: $0["key"] as? String ?? "", fingerprint: $0["fingerprint"] as? String ?? "",
                  label: $0["label"] as? String ?? "", email: $0["email"] as? String ?? "")
        }
        return Contents(items: items, grants: grants)
    }

    func keepSecret(_ fleet: Fleet, name: String, value: String) async throws -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isSecretName(n) else {
            throw FleetError.message("A secret's name is up to 64 letters, digits, dots, dashes and underscores.")
        }
        guard !value.isEmpty else { throw FleetError.message("The secret is empty.") }
        return try await ask(fleet, op: "put", extra: ["name": "secret:\(n)", "value": value]).text
    }

    func forget(_ fleet: Fleet, name: String) async throws -> String {
        try await ask(fleet, op: "forget", extra: ["name": name]).text
    }

    /// Sign in to GitHub or Cloudflare for the vault: this phone runs the page, the minter keeps the result.
    @MainActor
    func connect(_ fleet: Fleet, provider: String) async throws -> String {
        let back: DeviceSignIn.Back
        if provider == "github" {
            let start = try await fleet.githubDeviceStart()
            guard start.ok == true, let clientId = start.clientId, let redirectUri = start.redirectUri else {
                throw FleetError.message(start.text ?? "The fleet cannot start that sign-in.")
            }
            back = try await DeviceSignIn.run(authorize: "https://github.com/login/oauth/authorize", clientId: clientId,
                                              redirectUri: redirectUri, statePrefix: start.statePrefix ?? "d.", host: "github")
        } else {
            let start = try await fleet.cloudflareDeviceStart()
            guard start.ok == true, let clientId = start.clientId, let redirectUri = start.redirectUri,
                  let authorize = start.authorizeUrl
            else { throw FleetError.message(start.text ?? "The fleet cannot start that sign-in.") }
            back = try await DeviceSignIn.run(
                authorize: authorize, clientId: clientId, redirectUri: redirectUri,
                statePrefix: start.statePrefix ?? "d.", host: "cloudflare",
                extra: [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: start.scopes ?? "")]
            )
        }
        return try await ask(fleet, op: "connect", extra: [
            "provider": provider, "code": back.code, "verifier": back.verifier, "redirectUri": back.redirectUri,
        ]).text
    }

    func approve(_ fleet: Fleet, host: Fleet.Host) async throws -> String {
        guard let key = host.publicJwk else {
            throw FleetError.message("The fleet did not list \(host.hostId)'s key, so it cannot be approved from here. Update the fleet.")
        }
        let jwk: [String: Any] = ["kty": key.kty, "crv": key.crv, "x": key.x, "y": key.y]
        return try await ask(fleet, op: "grant", extra: ["hostKey": jwk, "label": host.hostId]).text
    }

    func remove(_ fleet: Fleet, grant: Grant) async throws -> String {
        try await ask(fleet, op: "revoke", extra: ["key": grant.key]).text
    }

    static func isSecretName(_ s: String) -> Bool {
        (1...64).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
    }

    /// A box key's fingerprint, worked out here from the key: sixteen hex
    /// characters of SHA-256 over `{"crv","kty","x","y"}` in that order, exactly
    /// as src/fleet/crypto.js `fingerprint` makes it and `fleetwright-sidecar
    /// identity` prints it.
    static func fingerprint(_ key: Fleet.Host.PublicKey) -> String {
        let canonical = "{\"crv\":\"\(key.crv)\",\"kty\":\"\(key.kty)\",\"x\":\"\(key.x)\",\"y\":\"\(key.y)\"}"
        return SHA256.hash(data: Data(canonical.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// How a vault item is named to a person.
    static func label(_ name: String) -> String {
        switch name {
        case "claude": return "Claude"
        case "github": return "GitHub"
        case "cloudflare": return "Cloudflare"
        default: return name.hasPrefix("secret:") ? String(name.dropFirst("secret:".count)) : name
        }
    }
}
