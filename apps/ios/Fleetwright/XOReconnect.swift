import Foundation

/// Reconnecting a pool's servers in Xen Orchestra, when Xen Orchestra answers
/// and shows none of the pool, or no longer shows part of it. The words and
/// the opening half of the reconnect screen (AddHypervisorView, reconnect
/// mode), kept apart from it so XOReconnectTests can run them.
///
/// WHY THE PHONE AND NOT THE FLEET. `server.getAll`, `server.enable` and
/// `server.disable` are Xen Orchestra's admin calls, and the only admin
/// sign-in there is lives on this phone (XOSaved), behind Face ID. So the
/// fleet notices, pushes, and the person's tap opens the kept sign-in and
/// seals it to one job on one machine, exactly the way a policy change does:
/// the same `begin`, the same key check, the same seal, saying
/// `purpose: reconnect` inside it. The machine reconnects only the servers
/// that are not connected, leaves any a person turned off as they are,
/// changes nothing else, and keeps nothing afterwards.
///
/// WHAT COMES BACK IS SEALED TO THIS PHONE. Which server is which, and at
/// what address, is not the coordinator's to read, so the machine seals the
/// per-server outcome to a key this phone sent inside the sign-in, under a
/// binding of its own (Seal.xosetupReconnectAAD), and the coordinator's own
/// progress says only counts. The key lives in the screen's memory: nothing
/// comes back to a reconnect once its screen is gone.
enum XOReconnect {
    /// What the machine sealed back, as `{ v, servers, pools }`.
    struct Outcome: Decodable, Equatable {
        let v: Int
        let servers: [Server]
        /// What the admin session sees at the end. Nil is a machine that did
        /// not say, which is said as that and never as "no pools" (C-5).
        let pools: [Pool]?

        struct Server: Decodable, Equatable {
            let label: String?
            let host: String?
            /// `connected`, `connecting` or `disconnected`, before and after.
            let before: String?
            let enabled: Bool?
            let after: String?
            /// `left`, `enabled`, `cycled`, `skipped-disabled` or `failed`.
            let action: String
            let error: String?
        }

        struct Pool: Decodable, Equatable {
            let id: String
            let name: String?
        }
    }

    /// The sealed outcome, opened with the key this phone sent and held to
    /// its version, or nil when it does not open or is not one.
    static func open(_ sealed: String, job: String, address: String, key: Seal.OneUseKey) -> Outcome? {
        let parts = sealed.split(separator: ".").map(String.init)
        guard parts.count == 3,
              let object = try? Seal.open(key, aad: Seal.xosetupReconnectAAD(job: job, address: address),
                                          sealed: ["epk": parts[0], "iv": parts[1], "ct": parts[2]]),
              let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return decode(data)
    }

    static func decode(_ data: Data) -> Outcome? {
        guard let outcome = try? JSONDecoder().decode(Outcome.self, from: data), outcome.v == 1 else { return nil }
        return outcome
    }

    /// A server's name as Xen Orchestra lists it: its label, else its
    /// address, else that it has neither.
    static func title(_ s: Outcome.Server) -> String {
        if let label = s.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        if let host = s.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty { return host }
        return "A server with no name"
    }

    /// Its address, under the name, when the name is not already the address.
    static func address(_ s: Outcome.Server) -> String? {
        guard let host = s.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty, host != title(s) else { return nil }
        return host
    }

    /// What was done to it and how it is now, in one or two sentences.
    static func line(_ s: Outcome.Server) -> String {
        switch s.action {
        case "left":
            return "Connected already, so it was left as it was."
        case "enabled":
            return "It was disconnected, so it was connected again. \(now(s.after))"
        case "cycled":
            let stuck = s.before == "connecting" ? "It was stuck connecting" : "It was connected with an error"
            return "\(stuck), so it was disconnected and connected again. \(now(s.after))"
        case "skipped-disabled":
            return "It is turned off in Xen Orchestra, so it was left off. Only a person turns a server back on."
        case "failed":
            let why = s.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            return "It did not reconnect: \(why.flatMap { $0.isEmpty ? nil : $0 } ?? "Xen Orchestra did not say why")."
        default:
            // A word a newer machine knows and this build does not: what it
            // is now is still known, so that much is said.
            return now(s.after)
        }
    }

    /// The one row that went wrong, which is the one that spends a tone.
    static func failed(_ s: Outcome.Server) -> Bool { s.action == "failed" }

    /// How it is after, as the machine last read it. Cannot tell is said as
    /// that, never rounded to connected (C-5).
    static func now(_ after: String?) -> String {
        switch after {
        case "connected": return "It is connected now."
        case "connecting": return "It is still connecting."
        case "disconnected": return "It is disconnected now."
        default: return "Xen Orchestra did not say how it is now."
        }
    }

    /// A pool's name, or the start of its id when Xen Orchestra gave it none:
    /// the same words a kept record uses (XOSetupHandoff.poolNames).
    static func poolName(_ p: Outcome.Pool) -> String {
        let name = p.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Unnamed pool \(String(p.id.prefix(8)))" : name
    }

    /// The pools the admin session sees at the end, as one sentence for an
    /// empty list and an unsaid one: neither is a list to draw.
    static func noPools(_ pools: [Outcome.Pool]?) -> String? {
        guard let pools else { return "The machine did not say which pools Xen Orchestra shows now." }
        return pools.isEmpty ? "Xen Orchestra shows no pools yet." : nil
    }
}
