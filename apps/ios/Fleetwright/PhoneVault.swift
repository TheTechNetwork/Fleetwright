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
        /// For a person's own vault: whether their managers may manage it,
        /// who those managers are, and what they changed. Nil for a member's
        /// vault opened by a custodian, and from a vault older than the
        /// organization.
        var custody: Custody? = nil
    }

    /// Who else may manage a person's vault, as the vault itself holds it
    /// (docs/members.md, "Custodians of a person member").
    struct Custody: Hashable {
        let allow: Bool
        /// The person's own member, by id, or nil when the vault's tree has none for them.
        let member: String?
        /// Whoever added this person, and so manages what they keep with no
        /// switch asked (docs/members.md, "Custodians of a person member").
        /// Empty from a vault older than the rule, which is also the truth there.
        let custodians: [String]
        /// Their other managers, who wait on `allow`.
        let managers: [String]
        let log: [Change]

        /// One thing a manager did, by name and never by value.
        struct Change: Hashable {
            let at: Double
            let by: String
            let op: String
            let name: String?
        }
    }

    /// The organization as the vault holds it: its admins, this person's
    /// standing there, and each member's place and who may act for it. The
    /// vault's own copy of the tree, which the fleet's list is never shown as
    /// (docs/members.md, "A member's vault").
    struct Org: Hashable {
        let admins: [String]
        let youAdmin: Bool
        /// Whether the vault knows this address as this GitHub account's.
        let youBound: Bool
        let members: [OrgMember]

        func member(_ id: String) -> OrgMember? { members.first { $0.id == id } }
    }

    struct OrgMember: Hashable {
        let id: String
        let kind: String
        let email: String?
        let reportsTo: String?
        let managers: [String]
        /// An agent member's own custodians. For a person, whoever added
        /// them, when the vault had not met them before.
        let custodians: [String]
        /// For a person: "allowed", "off" or "no_vault". Nil for an agent.
        let custody: String?
        /// Everybody who may act for this member's vault now.
        let may: [String]
    }

    /// `extra` with the member whose vault this request opens, when it is
    /// not the asker's own: the vault's `for` (src/fleet/minter/vault.js).
    private static func aimed(_ extra: [String: Any], at member: String?) -> [String: Any] {
        guard let member, !member.isEmpty else { return extra }
        var out = extra
        out["for"] = member
        return out
    }

    /// Seal one request, relay it, open the answer.
    private func ask(_ fleet: Fleet, op: String, extra: [String: Any] = [:]) async throws -> (text: String, answer: [String: Any]) {
        let pin = try await PhoneGitHub(settings: settings).minterKey(fleet)
        let email = settings.signedInAs.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty else {
            throw FleetError.message("Sign in to your fleet again.")
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
            throw FleetError.message(r["text"] as? String ?? "Your fleet refused that.")
        }
        let answer = try Seal.open(reply, aad: Seal.vaultReplyAAD, sealed: box)
        return (r["text"] as? String ?? "", answer)
    }

    func list(_ fleet: Fleet, for member: String? = nil) async throws -> Contents {
        let answer = try await ask(fleet, op: "list", extra: Self.aimed([:], at: member)).answer
        let items = (answer["items"] as? [[String: Any]] ?? []).map {
            Item(name: $0["name"] as? String ?? "", at: ($0["at"] as? NSNumber)?.doubleValue ?? 0, kind: $0["kind"] as? String)
        }
        let grants = (answer["grants"] as? [[String: Any]] ?? []).map {
            Grant(key: $0["key"] as? String ?? "", fingerprint: $0["fingerprint"] as? String ?? "",
                  label: $0["label"] as? String ?? "", email: $0["email"] as? String ?? "",
                  only: ($0["only"] as? [Any])?.map { "\($0)" } ?? [])
        }
        let custody = (answer["custody"] as? [String: Any]).map { c in
            Custody(
                allow: c["allow"] as? Bool == true,
                member: c["member"] as? String,
                custodians: (c["custodians"] as? [Any])?.map { "\($0)" } ?? [],
                managers: (c["managers"] as? [Any])?.map { "\($0)" } ?? [],
                log: (c["log"] as? [[String: Any]] ?? []).map {
                    Custody.Change(at: ($0["at"] as? NSNumber)?.doubleValue ?? 0, by: $0["by"] as? String ?? "",
                                   op: $0["op"] as? String ?? "", name: $0["name"] as? String)
                }
            )
        }
        return Contents(items: items, grants: grants, custody: custody)
    }

    func keepSecret(_ fleet: Fleet, name: String, value: String, for member: String? = nil) async throws -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isSecretName(n) else {
            throw FleetError.message("A secret's name is up to 64 letters, digits, dots, dashes and underscores.")
        }
        guard !value.isEmpty else { throw FleetError.message("The secret is empty.") }
        return try await ask(fleet, op: "put", extra: Self.aimed(["name": "secret:\(n)", "value": value], at: member)).text
    }

    /// Keep a Claude login in a MEMBER'S vault: a setup-token, or the whole
    /// sign-in one of the fleet's machines made. A person's own goes through
    /// PhoneGitHub.depositClaudeLogin, as it always did; this is the same
    /// thing as a vault request, because only a vault request can say whose
    /// vault it is for.
    func keepClaude(_ fleet: Fleet, token: String?, signIn: [String: Any]?, for member: String) async throws -> String {
        var extra: [String: Any] = ["name": "claude"]
        if let signIn {
            extra["signIn"] = signIn
        } else {
            let value = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !value.isEmpty else { throw FleetError.message("The token is empty.") }
            extra["value"] = value
        }
        return try await ask(fleet, op: "put", extra: Self.aimed(extra, at: member)).text
    }

    /// Keep a hypervisor's token in the fleet: the record setup handed this
    /// phone, under `hypervisor:<address>`, or one box's own user under
    /// `hypervisor:<address>+<box>` (XOSetupHandoff.keepBoxUsers). The minter
    /// checks the record names that address, and that box; the boxes this
    /// person approved are handed the shared one, and a box its own alone,
    /// hold it in memory only (src/fleet/host/xo-pools.js), and make machines
    /// on the pool with it.
    func keepHypervisor(_ fleet: Fleet, address: String, record: String, box: String? = nil) async throws -> String {
        let name = box.map { "hypervisor:\(address)+\($0)" } ?? "hypervisor:\(address)"
        return try await ask(fleet, op: "put", extra: ["name": name, "value": record]).text
    }

    func forget(_ fleet: Fleet, name: String, for member: String? = nil) async throws -> String {
        try await ask(fleet, op: "forget", extra: Self.aimed(["name": name], at: member)).text
    }

    /// Whether a kept credential still works, asked by the minter of the
    /// service it is for (vault.js, testItem). Anything short of accepted,
    /// cannot tell included, comes back as a failure, so it is drawn as one.
    func test(_ fleet: Fleet, name: String, for member: String? = nil) async throws -> String {
        let r = try await ask(fleet, op: "test", extra: Self.aimed(["name": name], at: member))
        guard r.answer["state"] as? String == "accepted" else { throw FleetError.message(r.text) }
        return r.text
    }

    /// Sign in to GitHub or Cloudflare for the vault: this phone runs the page, the minter keeps the result.
    @MainActor
    func connect(_ fleet: Fleet, provider: String, for member: String? = nil) async throws -> String {
        let back: DeviceSignIn.Back
        if provider == "github" {
            let start = try await fleet.githubDeviceStart()
            guard start.ok == true, let clientId = start.clientId, let redirectUri = start.redirectUri else {
                throw FleetError.message(start.text ?? "Your fleet cannot start that sign-in.")
            }
            back = try await DeviceSignIn.run(authorize: "https://github.com/login/oauth/authorize", clientId: clientId,
                                              redirectUri: redirectUri, statePrefix: start.statePrefix ?? "d.", host: "github")
        } else {
            let start = try await fleet.cloudflareDeviceStart()
            guard start.ok == true, let clientId = start.clientId, let redirectUri = start.redirectUri,
                  let authorize = start.authorizeUrl
            else { throw FleetError.message(start.text ?? "Your fleet cannot start that sign-in.") }
            back = try await DeviceSignIn.run(
                authorize: authorize, clientId: clientId, redirectUri: redirectUri,
                statePrefix: start.statePrefix ?? "d.", host: "cloudflare",
                extra: [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: start.scopes ?? "")]
            )
        }
        return try await ask(fleet, op: "connect", extra: Self.aimed([
            "provider": provider, "code": back.code, "verifier": back.verifier, "redirectUri": back.redirectUri,
        ], at: member)).text
    }

    func approve(_ fleet: Fleet, host: Fleet.Host, for member: String? = nil) async throws -> String {
        guard let key = host.publicJwk else {
            throw FleetError.message("\(host.hostId) cannot be approved yet. Update your fleet first.")
        }
        let jwk: [String: Any] = ["kty": key.kty, "crv": key.crv, "x": key.x, "y": key.y]
        return try await ask(fleet, op: "grant", extra: Self.aimed(["hostKey": jwk, "label": host.hostId], at: member)).text
    }

    /// A pool's own machine, approved for its pool's record and nothing else
    /// of this person's: the vault's `only` (src/fleet/minter/vault.js).
    func approveHolder(_ fleet: Fleet, hostId: String, key: Fleet.Host.PublicKey, address: String) async throws -> String {
        let jwk: [String: Any] = ["kty": key.kty, "crv": key.crv, "x": key.x, "y": key.y]
        return try await ask(fleet, op: "grant", extra: ["hostKey": jwk, "label": hostId, "only": ["hypervisor:\(address)"]]).text
    }

    func remove(_ fleet: Fleet, grant: Grant, for member: String? = nil) async throws -> String {
        try await ask(fleet, op: "revoke", extra: Self.aimed(["key": grant.key], at: member)).text
    }

    // MARK: - the organization, as the vault holds it

    /// The vault's own copy of the tree, and who may act for each member.
    func org(_ fleet: Fleet) async throws -> Org {
        let answer = try await ask(fleet, op: "org").answer
        func strings(_ value: Any?) -> [String] { (value as? [Any])?.map { "\($0)" } ?? [] }
        let you = answer["you"] as? [String: Any]
        let members = (answer["members"] as? [[String: Any]] ?? []).map {
            OrgMember(id: $0["id"] as? String ?? "", kind: $0["kind"] as? String ?? "", email: $0["email"] as? String,
                      reportsTo: $0["reportsTo"] as? String, managers: strings($0["managers"]),
                      custodians: strings($0["custodians"]), custody: $0["custody"] as? String, may: strings($0["may"]))
        }
        return Org(admins: strings(answer["admins"]), youAdmin: you?["admin"] as? Bool == true,
                   youBound: you?["bound"] as? Bool == true, members: members)
    }

    /// Add an admin of the organization in the vault, or remove one. The
    /// first is somebody who administers the fleet filing themselves.
    func fileOrgAdmin(_ fleet: Fleet, address: String, remove: Bool = false) async throws -> String {
        var extra: [String: Any] = ["address": address]
        if remove { extra["remove"] = true }
        return try await ask(fleet, op: "orgadmin", extra: extra).text
    }

    /// File one member's place in the vault's tree, or take it out. Custody
    /// of the member's vault follows what is filed here, and nothing the
    /// fleet's own list says.
    func fileOrgMember(_ fleet: Fleet, id: String, kind: String, address: String?, reportsTo: String?,
                       managers: [String]? = nil, remove: Bool = false) async throws -> String {
        var extra: [String: Any] = ["id": id, "kind": kind]
        // Left out is nobody: the vault reads a missing `reportsTo` as the top of the tree.
        if let reportsTo, !reportsTo.isEmpty { extra["reportsTo"] = reportsTo }
        if let address, !address.isEmpty { extra["address"] = address }
        if let managers { extra["managers"] = managers }
        if remove { extra["remove"] = true }
        return try await ask(fleet, op: "orgmember", extra: extra).text
    }

    /// Add one of an agent member's own custodians, or remove one. The last
    /// one stays, and the vault says so.
    func setCustodian(_ fleet: Fleet, member: String, address: String, remove: Bool = false) async throws -> String {
        var extra: [String: Any] = ["member": member, "address": address]
        if remove { extra["remove"] = true }
        return try await ask(fleet, op: "custodian", extra: extra).text
    }

    /// Let this person's managers manage their own vault, or stop.
    func setCustody(_ fleet: Fleet, allow: Bool) async throws -> String {
        try await ask(fleet, op: "custody", extra: ["allow": allow]).text
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
            return "Your sessions stop using it. Getting it back means adding it again."
        case "github", "cloudflare":
            return "Machines you approved stop being given it. Getting it back means signing in again."
        default:
            return "Machines you approved stop being given it. Getting it back means typing it in again."
        }
    }

    /// The same, for a member's vault a custodian is changing: whose sessions
    /// stop, by the member's name. The same sentences as Android.
    static func forgetting(_ name: String, for who: String) -> String {
        name == "claude"
            ? "Sessions started as \(who) stop using it. Getting it back means adding it again."
            : "Machines approved for \(who) stop being given it. Getting it back means adding it again."
    }

    /// One thing a manager did to this person's vault, as a row: who, what
    /// they did to which item, and when. A machine approved or removed is
    /// said as that, with no item. The same words as Android.
    static func custodyLine(_ change: Custody.Change, when: String) -> String {
        let what = change.name.map { label($0) } ?? ""
        let did: String
        switch change.op {
        case "put", "connect": did = "kept \(what)"
        case "forget": did = "removed \(what)"
        case "grant": did = "approved a machine"
        case "revoke": did = "removed a machine"
        default: did = change.op
        }
        return "\(change.by) \(did.trimmingCharacters(in: .whitespaces)) · \(when)"
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
