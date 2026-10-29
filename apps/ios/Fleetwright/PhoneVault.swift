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
        /// For Claude, which kind is kept: `login`, the sign-in Remote Control
        /// needs, or `token`, a setup-token that runs sessions only. Nil for
        /// anything else, and from a minter from before it said.
        var kind: String? = nil
    }

    struct Grant: Hashable {
        /// The whole SHA-256 of the box's key, as the minter names the grant
        /// (`keyHash`); `fingerprint` is its first sixteen characters.
        let key: String
        let fingerprint: String
        let label: String
        let email: String
        /// The items a box approved for some of the vault may hold, by name:
        /// the vault's `only`, as `approveHolder` writes it for a pool's own
        /// machine. Empty is the whole vault.
        var only: [String] = []
    }

    /// What this vault says about the key a machine answered with.
    enum Approval: Equatable {
        /// Approved for the whole vault, under that machine's name, by that key.
        case approved
        /// Approved for the whole vault under that machine's name, by another
        /// key: a machine that was re-keyed would have been re-approved.
        case anotherKey
        /// Nothing that counts, which asks the person.
        case none
    }

    /// Whether these grants approve `key` as `hostId`'s for an admin's
    /// sign-in, which is the person's word that it is that machine's key.
    ///
    /// A GRANT SCOPED BY `only` IS NOT THAT WORD. It is the one this phone
    /// writes when it lets a pool's own machine in to hold its pool's record
    /// and nothing else (`approveHolder`), and nobody compared a key for it
    /// the way the comparison card asks. Counted, a machine holding a pool's
    /// record was handed the Xen Orchestra admin's sign-in without anyone
    /// being asked. So only a whole-vault grant counts, under the name that
    /// answered, by the whole hash of the key and not its sixteen-character
    /// prefix; anything else is `.none` and the person compares.
    static func approval(_ grants: [Grant], hostId: String, key: Fleet.Host.PublicKey) -> Approval {
        let named = grants.filter { $0.only.isEmpty && $0.label == hostId }
        if named.contains(where: { $0.key == keyHash(key) }) { return .approved }
        return named.isEmpty ? .none : .anotherKey
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
            Item(name: $0["name"] as? String ?? "", at: ($0["at"] as? NSNumber)?.doubleValue ?? 0, kind: $0["kind"] as? String)
        }
        let grants = (answer["grants"] as? [[String: Any]] ?? []).map {
            Grant(key: $0["key"] as? String ?? "", fingerprint: $0["fingerprint"] as? String ?? "",
                  label: $0["label"] as? String ?? "", email: $0["email"] as? String ?? "",
                  only: ($0["only"] as? [Any])?.map { "\($0)" } ?? [])
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

    /// Keep a hypervisor's token in the fleet: the record setup handed this
    /// phone, under `hypervisor:<address>`. The minter checks the record
    /// names that address; the boxes this person approved are handed it and
    /// hold it in memory only (src/fleet/host/xo-pools.js), and make
    /// machines on the pool with it.
    func keepHypervisor(_ fleet: Fleet, address: String, record: String, box: String? = nil) async throws -> String {
        let name = box.map { "hypervisor:\(address)+\($0)" } ?? "hypervisor:\(address)"
        return try await ask(fleet, op: "put", extra: ["name": name, "value": record]).text
    }

    func forget(_ fleet: Fleet, name: String) async throws -> String {
        try await ask(fleet, op: "forget", extra: ["name": name]).text
    }

    /// Whether a kept credential still works, asked by the minter of the
    /// service it is for (vault.js, testItem). Anything short of accepted,
    /// cannot tell included, comes back as a failure, so it is drawn as one.
    func test(_ fleet: Fleet, name: String) async throws -> String {
        let r = try await ask(fleet, op: "test", extra: ["name": name])
        guard r.answer["state"] as? String == "accepted" else { throw FleetError.message(r.text) }
        return r.text
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

    /// A pool's own machine, approved for its pool's record and nothing else
    /// of this person's: the vault's `only` (src/fleet/minter/vault.js).
    func approveHolder(_ fleet: Fleet, hostId: String, key: Fleet.Host.PublicKey, address: String) async throws -> String {
        let jwk: [String: Any] = ["kty": key.kty, "crv": key.crv, "x": key.x, "y": key.y]
        return try await ask(fleet, op: "grant", extra: ["hostKey": jwk, "label": hostId, "only": ["hypervisor:\(address)"]]).text
    }

    func remove(_ fleet: Fleet, grant: Grant) async throws -> String {
        try await ask(fleet, op: "revoke", extra: ["key": grant.key]).text
    }

    /// List this phone's signing key under the account it is signed in as, so
    /// the fleet's boxes are given it by the minter and can check what this
    /// phone signs (DeviceSigning.swift, docs/signed-intents.md). The minter
    /// files it under the GitHub account this request carries, and refuses it
    /// when that address's keys are another account's.
    func listDeviceKey(_ fleet: Fleet, key: DeviceKey) async throws -> String {
        try await ask(fleet, op: "devicekey", extra: [
            "key": key.jwk, "label": key.hardware ? "iPhone (Secure Enclave)" : "iPhone (keychain)",
        ]).text
    }

    /// Take back a delegation, at the minter: the coordinator carries
    /// delegations, so telling it alone would leave a dishonest one carrying
    /// this. Boxes refuse it from the next key list they take.
    func revokeDelegation(_ fleet: Fleet, id: String, until: Double) async throws -> String {
        try await ask(fleet, op: "revokedelegation", extra: ["id": id, "until": Int(until)]).text
    }

    static func isSecretName(_ s: String) -> Bool {
        (1...64).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
    }

    /// A box key's fingerprint, worked out here from the key: sixteen hex
    /// characters of SHA-256 over `{"crv","kty","x","y"}` in that order, exactly
    /// as src/fleet/crypto.js `fingerprint` makes it and `fleetwright-sidecar
    /// identity` prints it.
    static func fingerprint(_ key: Fleet.Host.PublicKey) -> String {
        String(keyHash(key).prefix(16))
    }

    /// The whole of that SHA-256, in hex: what the minter names a grant by
    /// (boxKeyHash in src/fleet/minter/vault.js), and `Grant.key`.
    static func keyHash(_ key: Fleet.Host.PublicKey) -> String {
        let canonical = "{\"crv\":\"\(key.crv)\",\"kty\":\"\(key.kty)\",\"x\":\"\(key.x)\",\"y\":\"\(key.y)\"}"
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The kept credentials there is a service to ask about. A named secret
    /// and a hypervisor's token have none, so they get no Test button.
    static func isTestable(_ name: String) -> Bool {
        ["claude", "github", "cloudflare"].contains(name)
    }

    /// What forgetting one costs, said before it is done.
    static func forgetting(_ name: String) -> String {
        switch name {
        case "claude":
            return "Runners you start go back to the runner repository's API key, and boxes stop being given it. "
                + "Getting it back means a new token from claude setup-token."
        case "github", "cloudflare":
            return "Boxes stop being given it when they next ask. Getting it back means signing in again from this page."
        default:
            return "Boxes stop being given it when they next ask. Getting it back means typing it in again."
        }
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
