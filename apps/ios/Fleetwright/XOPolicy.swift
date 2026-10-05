import Foundation

/// What the fleet may use on a pool it already manages: the storage, the
/// networks, the network a lab's way out goes on, and how much. The arithmetic
/// half of the policy screen (AddHypervisorView, policy mode), kept apart from
/// it so XOPolicyTests can run it. docs/hypervisors.md, "The policy";
/// src/fleet/host/xo-setup.js, `#policySteps`, `inventoryOf`, `checkPolicy`.
///
/// THE SHAPE OF IT. A policy job begins and signs in exactly as onboarding
/// does, then reads the pool and hands this phone an INVENTORY, sealed to a
/// key the phone sent inside the sign-in, because a network map is not the
/// coordinator's to read. The person chooses; the CHOICE goes back sealed to
/// the job's key; the machine checks it against the inventory it sent and
/// applies it as the resource set, which is what Xen Orchestra enforces.
///
/// THE RULES HERE ARE THE MACHINE'S, mirrored, not a second opinion.
/// `checkPolicy` is the bound: it refuses anything outside the inventory and
/// says why, and the job goes on waiting. These exist so Apply is offered
/// only for a choice the machine will take (C-2), and the sentences are the
/// machine's own, so the screen and a refusal never disagree about a limit.
///
/// THE KEY THE INVENTORY OPENS WITH LIVES IN MEMORY. Unlike onboarding's
/// hand-off key (XOSetupHandoff), nothing comes back after the screen is
/// gone: the machine waits ten minutes for a choice and then lets go, so a
/// key kept past the screen would be kept for nothing.
enum XOPolicy {
    static let gib: Int64 = 1024 * 1024 * 1024
    /// The smallest limits the machine takes: a GiB of memory, ten of disk
    /// (MIN_MEMORY and MIN_DISK in xo-setup.js). One vCPU is the floor of
    /// `cpuRange`.
    static let minMemoryGiB = 1
    static let minDiskGiB = 10

    /// What the machine read, in `inventoryOf`'s shape. Sizes are bytes.
    struct Inventory: Decodable, Equatable {
        let v: Int
        let address: String
        let pools: [Pool]
        let srs: [Storage]
        let networks: [Network]
        let capacity: Capacity
        let current: Current

        struct Pool: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
        }

        /// A storage repository a VM's disk can go on.
        struct Storage: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
            let pool: String?
            let size: Int64
            let free: Int64
            let shared: Bool

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = try c.decode(String.self, forKey: .id)
                name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
                pool = try c.decodeIfPresent(String.self, forKey: .pool)
                size = try c.whole(.size)
                free = try c.whole(.free)
                shared = try c.decodeIfPresent(Bool.self, forKey: .shared) ?? false
            }

            private enum CodingKeys: String, CodingKey { case id, name, pool, size, free, shared }
        }

        struct Network: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
            let pool: String?
            /// The VLAN its interfaces carry, or nil for none: a private
            /// network, or one on an untagged interface.
            let vlan: Int?
            /// Tagged `fleetwright-egress` in Xen Orchestra now.
            let egress: Bool
        }

        struct Capacity: Decodable, Equatable {
            let cpus: Int
            let memory: Int64

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                cpus = try Int(clamping: c.whole(.cpus))
                memory = try c.whole(.memory)
            }

            private enum CodingKeys: String, CodingKey { case cpus, memory }
        }

        struct Current: Decodable, Equatable {
            let srs: [String]
            let networks: [String]
            let limits: Limits
        }

        /// The resource set's limits now. Each is nil when it has none, which
        /// is "not set", never zero.
        struct Limits: Decodable, Equatable {
            let cpus: Int?
            let memory: Int64?
            let disk: Int64?

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                cpus = try c.wholeIfPresent(.cpus).map { Int(clamping: $0) }
                memory = try c.wholeIfPresent(.memory)
                disk = try c.wholeIfPresent(.disk)
            }

            private enum CodingKeys: String, CodingKey { case cpus, memory, disk }
        }

        /// vCPUs the fleet may be given: one, up to what the pool has.
        var cpuRange: ClosedRange<Int> { 1...max(1, capacity.cpus) }

        /// Memory in whole GiB: one, up to what the pool has, rounded down so
        /// the top of the range is never past it.
        var memoryRange: ClosedRange<Int> {
            XOPolicy.minMemoryGiB...max(XOPolicy.minMemoryGiB, Int(clamping: capacity.memory / XOPolicy.gib))
        }

        /// Disk in whole GiB: ten, up to the size of the storage chosen, which
        /// is what the machine holds it to.
        func diskRange(for chosen: Set<String>) -> ClosedRange<Int> {
            let room = srs.filter { chosen.contains($0.id) }.reduce(Int64(0)) { $0 + $1.size }
            return XOPolicy.minDiskGiB...max(XOPolicy.minDiskGiB, Int(clamping: room / XOPolicy.gib))
        }

        /// A pool's name by id, for an inventory with more than one pool in it.
        func poolName(_ id: String?) -> String? {
            guard pools.count > 1, let id else { return nil }
            return pools.first { $0.id == id }.map { XOPolicy.title($0.name, id: $0.id) }
        }
    }

    /// What the person has chosen so far. Memory and disk are whole GiB, the
    /// unit the steppers move in, and become bytes only in `payload`.
    struct Choice: Equatable {
        var srs: Set<String> = []
        var networks: Set<String> = []
        /// The network the edge router's WAN will go on, or nil for none yet.
        var egress: String?
        var cpus = 1
        var memoryGiB = XOPolicy.minMemoryGiB
        var diskGiB = XOPolicy.minDiskGiB

        /// Where the screen starts: what the fleet may use now, wherever the
        /// pool says. A limit that is not set starts at half of what there is
        /// (memory: half the pool; disk: half the free space on the storage
        /// chosen), the way onboarding sets the first one; every number is
        /// then held inside what the machine will take.
        static func initial(for inv: Inventory) -> Choice {
            var c = Choice()
            c.srs = Set(inv.current.srs).intersection(inv.srs.map(\.id))
            let networks = Set(inv.current.networks).intersection(inv.networks.map(\.id))
            c.networks = networks
            c.egress = inv.networks.first { $0.egress && networks.contains($0.id) }?.id
            c.cpus = XOPolicy.clamp(inv.current.limits.cpus ?? inv.capacity.cpus / 2, inv.cpuRange)
            let memory = inv.current.limits.memory.map(XOPolicy.nearestGiB) ?? Int(clamping: inv.capacity.memory / 2 / XOPolicy.gib)
            c.memoryGiB = XOPolicy.clamp(memory, inv.memoryRange)
            let chosen = c.srs
            let free = inv.srs.filter { chosen.contains($0.id) }.reduce(Int64(0)) { $0 + $1.free }
            let disk = inv.current.limits.disk.map(XOPolicy.nearestGiB) ?? Int(clamping: free / 2 / XOPolicy.gib)
            c.diskGiB = XOPolicy.clamp(disk, inv.diskRange(for: chosen))
            return c
        }

        /// Storage on or off. Disk is held inside the storage that is left.
        mutating func setStorage(_ id: String, on: Bool, in inv: Inventory) {
            if on { srs.insert(id) } else { srs.remove(id) }
            diskGiB = XOPolicy.clamp(diskGiB, inv.diskRange(for: srs))
        }

        /// A network on or off. The way out goes with its network: the
        /// fleet's VMs could not put a router's WAN on one they may not use.
        mutating func setNetwork(_ id: String, on: Bool) {
            if on { networks.insert(id) } else { networks.remove(id) }
            if let egress, !networks.contains(egress) { self.egress = nil }
        }

        /// Why the machine would refuse this, in its own words
        /// (`checkPolicy`), or nil when it would take it.
        func problem(in inv: Inventory) -> String? {
            if srs.isEmpty { return "Choose at least one storage repository: a VM needs somewhere for its disk." }
            if !srs.isSubset(of: inv.srs.map(\.id)) || !networks.isSubset(of: inv.networks.map(\.id)) {
                return "That names storage or a network this pool did not list."
            }
            if let egress, !networks.contains(egress) { return "The way out has to be one of the networks the fleet may use." }
            if !inv.cpuRange.contains(cpus) { return "vCPUs are between 1 and \(inv.cpuRange.upperBound), what the pool has." }
            if !inv.memoryRange.contains(memoryGiB) {
                return "Memory is between 1 GiB and \(inv.memoryRange.upperBound) GiB, what the pool has."
            }
            let disk = inv.diskRange(for: srs)
            if !disk.contains(diskGiB) { return "Disk is between 10 GiB and \(disk.upperBound) GiB, the size of the storage chosen." }
            return nil
        }

        /// What is sealed to the job's key: `checkPolicy`'s input exactly.
        /// Ids in the inventory's order, so the same choice is the same bytes.
        func payload(in inv: Inventory) -> [String: Any] {
            let limits: [String: Any] = [
                "cpus": cpus,
                "memory": Int64(memoryGiB) * XOPolicy.gib,
                "disk": Int64(diskGiB) * XOPolicy.gib,
            ]
            let way: Any = egress.map { $0 as Any } ?? NSNull()
            return [
                "v": 1,
                "srs": inv.srs.map(\.id).filter { srs.contains($0) },
                "networks": inv.networks.map(\.id).filter { networks.contains($0) },
                "egress": way,
                "limits": limits,
            ]
        }
    }

    /// The inventory a machine sealed to this phone's key, or nil for anything
    /// that does not open under this job and address with this key, is not
    /// the shape `inventoryOf` writes, or is about another address.
    static func open(_ sealed: String, job: String, address: String, key: Seal.OneUseKey) -> Inventory? {
        let parts = sealed.split(separator: ".").map(String.init)
        guard parts.count == 3,
              let object = try? Seal.open(key, aad: Seal.xosetupInventoryAAD(job: job, address: address),
                                          sealed: ["epk": parts[0], "iv": parts[1], "ct": parts[2]]),
              let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return decode(data, address: address)
    }

    /// The JSON of an inventory, held to its version and its address.
    static func decode(_ data: Data, address: String) -> Inventory? {
        guard let inv = try? JSONDecoder().decode(Inventory.self, from: data), inv.v == 1, inv.address == address
        else { return nil }
        return inv
    }

    /// The line at the top of a policy job, in place of onboarding's
    /// headline: its end is not a hypervisor added. The step words are
    /// shared (XOSetupWords.phrase).
    static func statusLine(_ s: XOSetupAttributes.ContentState) -> String {
        switch s.state {
        case "done": return "What the fleet may use is changed"
        case "failed": return "The change stopped"
        case "cancelled": return "The change was cancelled"
        case "waiting": return "Waiting for the sign-in"
        case "choosing": return "Waiting for your choice"
        default: return XOSetupWords.phrase(phase: s.phase, step: s.step, of: s.of)
        }
    }

    /// Bytes as whole GiB, with the locale's grouping: "1,862 GiB".
    static func gibText(_ bytes: Int64) -> String { "\(nearestGiB(bytes).formatted()) GiB" }

    /// "412 GiB free of 931 GiB", for a storage row.
    static func room(_ sr: Inventory.Storage) -> String { "\(gibText(sr.free)) free of \(gibText(sr.size))" }

    /// "VLAN 20", or "no VLAN".
    static func vlan(_ n: Inventory.Network) -> String { n.vlan.map { "VLAN \($0)" } ?? "no VLAN" }

    /// A name to show: Xen Orchestra's, or the start of the id when it has
    /// none, so two unnamed networks are still two different rows.
    static func title(_ name: String, id: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Unnamed, \(id.prefix(8))" : trimmed
    }

    static func nearestGiB(_ bytes: Int64) -> Int {
        Int(clamping: (bytes + gib / 2) / gib)
    }

    static func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }
}

/// JavaScript writes every number as a number. A size that came out of
/// arithmetic there can arrive as `1.0e12` as easily as `1000000000000`, and
/// a strict Int64 decode would refuse the whole inventory over it.
private extension KeyedDecodingContainer {
    func whole(_ key: Key) throws -> Int64 {
        if let n = try? decode(Int64.self, forKey: key) { return n }
        return try wholeNumber(decode(Double.self, forKey: key), key)
    }

    func wholeIfPresent(_ key: Key) throws -> Int64? {
        if let n = try? decodeIfPresent(Int64.self, forKey: key) { return n }
        guard let d = try decodeIfPresent(Double.self, forKey: key) else { return nil }
        return try wholeNumber(d, key)
    }

    private func wholeNumber(_ d: Double, _ key: Key) throws -> Int64 {
        guard d.isFinite, abs(d) < 9.0e18 else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "not a whole number of bytes")
        }
        return Int64(d.rounded(.down))
    }
}
