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
    /// The edge router's raw disk, OPNSENSE_IMAGE.rawSize in edge-router.js.
    static let edgeDiskBytes: Int64 = 3 * 1024 * 1024 * 1024
    /// The machine image's disk, VM_IMAGE.diskSize in vm-image.js.
    static let imageDiskBytes: Int64 = 20 * 1024 * 1024 * 1024
    /// The image an older machine builds, and what an image that predates
    /// saying which it is was made of.
    static let debianKey = "debian-13"

    /// What Apply does to a machine image the pool has. Asked for: "There is
    /// no rebuild button or delete button".
    enum ImageAction: String, CaseIterable {
        case keep, rebuild, remove
    }
    /// The smallest limits the machine takes: a GiB of memory, ten of disk
    /// (MIN_MEMORY and MIN_DISK in xo-setup.js). One vCPU is the floor of
    /// `cpuRange`.
    static let minMemoryGiB = 1
    static let minDiskGiB = 10
    /// What a group network is called, and the most a policy makes on one
    /// pool (GROUP_PREFIX and MAX_GROUPS in edge-router.js).
    static let groupPrefix = "fleetwright-group-"
    static let maxGroups = 4
    /// What a lab network is called, and the most labs an edge has room for
    /// (LAB.prefix and LAB.max in edge-router.js).
    static let labPrefix = "fleetwright-lab-"
    static let maxLabs = 4

    /// Labs per person, as the stepper says it. The same words as Android
    /// (XoPolicy.labsEachLine).
    static func labsEachLine(_ each: Int) -> String {
        each == 0 ? "No limit" : each == 1 ? "At most one at once" : "At most \(each) at once"
    }

    /// What the machine read, in `inventoryOf`'s shape. Sizes are bytes.
    struct Inventory: Decodable, Equatable {
        let v: Int
        let address: String
        let pools: [Pool]
        let srs: [Storage]
        let networks: [Network]
        let capacity: Capacity
        let current: Current
        /// Each pool's edge router, from a machine that can build one; nil
        /// from one older than that, which is "cannot tell", never "none".
        let edges: [Edge]?
        /// Each pool's machine image, from a machine that can build one; nil
        /// from one older than that, which is "cannot tell", never "none".
        var images: [Image]? = nil
        /// The operating systems a machine image can be made of, from this
        /// machine's catalogue (vm-image.js, IMAGES); nil from one older than
        /// the choice, which builds Debian alone.
        var imageKinds: [ImageKind]? = nil
        /// Each pool's group networks, from a machine that makes them; nil
        /// from one older than that, which is "cannot tell", never "none".
        var groups: [GroupNetwork]? = nil
        /// Each pool's own machine, from a machine that can make one
        /// (xo-holder.js); nil from one older than that, which is "cannot
        /// tell", never "none".
        var holders: [Holder]? = nil
        /// The most labs an edge has room for, from a machine that makes
        /// them; nil from one older than that, which makes none.
        var labMax: Int? = nil

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

        /// The edge router on a pool, whether it is running, and the
        /// storage its disk is on, by name (nil from a machine that predates
        /// saying it, or when it cannot be told).
        struct Edge: Decodable, Equatable {
            let pool: String?
            let running: Bool
            var sr: String? = nil
            /// It drops what its threat rules match, rather than only logging
            /// it; nil from a machine that predates saying, which built none.
            var blocks: Bool? = nil
            /// The labs it was built with, by kind; nil from a machine that
            /// predates labs, whose edge has none.
            var labs: Labs? = nil
            /// How many of them one person may hold at once; nil is no
            /// limit, which is also what a policy from before the setting
            /// has, and never 0.
            var labsEach: Int? = nil
        }

        struct Labs: Decodable, Equatable {
            let open: Int
            let closed: Int
        }

        /// A pool's machine image: the template sessions' machines are cloned from.
        struct Image: Decodable, Equatable {
            let pool: String?
            let name: String
            /// Which of the catalogue's images it is; nil from a machine that
            /// predates saying, which only ever built Debian.
            var key: String? = nil
        }

        /// A pool's own machine: a permanent fleet host on the pool that
        /// holds it once its owner approves it.
        struct Holder: Decodable, Equatable {
            let pool: String?
            let name: String
            let running: Bool
        }

        /// A network for machines that work together: no way off the pool.
        struct GroupNetwork: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
            let pool: String?
        }

        /// The networks a person chooses among: the pool's, less its group
        /// networks, which are this policy's to make and not a choice.
        var choosable: [Network] {
            networks.filter { !$0.name.hasPrefix(XOPolicy.groupPrefix) && !$0.name.hasPrefix(XOPolicy.labPrefix) }
        }

        /// How many group networks the pool this network is in has.
        func groupCount(on network: String?) -> Int {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return 0 }
            return (groups ?? []).filter { $0.pool == pool }.count
        }

        /// One operating system an image can be made of.
        struct ImageKind: Decodable, Equatable, Identifiable {
            let key: String
            let os: String
            var id: String { key }
        }

        /// The images already on the pool this network is in, by key.
        func imageKeys(on network: String?) -> Set<String> {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return [] }
            return Set((images ?? []).filter { $0.pool == pool }.map { $0.key ?? XOPolicy.debianKey })
        }

        /// The machine image on the pool this network is in, if it has one.
        func image(on network: String?) -> Image? {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return nil }
            return images?.first { $0.pool == pool }
        }

        /// The pool's own machine on the pool this network is in, if it has one.
        func holder(on network: String?) -> Holder? {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return nil }
            return holders?.first { $0.pool == pool }
        }

        /// The edge router on the pool this network is in, if it has one.
        func edge(on network: String?) -> Edge? {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return nil }
            return edges?.first { $0.pool == pool }
        }

        /// Storage the router's disk can go on: in the way out's pool, with
        /// room for its 3 GiB raw disk. Any the pool listed, not only the
        /// fleet's, because the router is not one of the fleet's VMs.
        func edgeDisks(for network: String?, need: Int64 = XOPolicy.edgeDiskBytes) -> [Storage] {
            guard let network, let pool = networks.first(where: { $0.id == network })?.pool else { return [] }
            return srs.filter { $0.pool == pool && $0.free > need }
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
        /// Build the edge router on the way out, or keep the one there in
        /// step with it. Needs a way out; goes with it when it goes.
        var edge = false
        /// The machine takes any of the pool's networks as the way out
        /// (`egress-any` in begin's `can`), not only one the fleet may use.
        /// An older one refuses those, so they are not offered to it.
        var anyWayOut = false
        /// Where the router's disk goes, when the person picked; nil is the
        /// default `edgeDisk(in:)` says. Asked for: "which disk did it put it
        /// on?" The first version picked one and never said which.
        var edgeSr: String?
        /// The machine reads `edgeSr` (`edge-disk` in begin's `can`). An
        /// older one ignores it, so it is neither offered nor sent.
        var edgeDiskChoice = false
        /// The edge drops what its threat rules match, rather than only
        /// logging it. Changing it on an edge that is there rebuilds it.
        var edgeBlock = false
        /// The machine builds either kind (`edge-block` in begin's `can`).
        /// An older one only logs, so it is neither offered nor sent.
        var edgeBlockChoice = false
        /// Make the machine image sessions' machines are cloned from, on the
        /// way out's pool, behind its router. Needs the router, there or
        /// built with it.
        var image = false
        /// The machine builds one (`image` in begin's `can`). An older one
        /// cannot, so it is neither offered nor sent.
        var imageChoice = false
        /// Which images to make, by key, for a machine that builds any of its
        /// catalogue (`images` in begin's `can`). Asked for: "os selection
        /// not just Debian".
        var images: Set<String> = []
        /// The machine takes `images`. An older one is sent `image` alone,
        /// and offered Debian alone.
        var imagesChoice = false
        /// What Apply does to each image the way out's pool has, by key; one
        /// not named is kept.
        var imageActions: [String: ImageAction] = [:]
        /// The machine rebuilds and removes images (`image-manage` in begin's
        /// `can`). An older one keeps every image, so neither is offered.
        var imageManageChoice = false
        /// How many group networks the way out's pool is to have. Asked for:
        /// "the 3 VMs need to reach each other".
        var groups = 0
        /// The machine makes them (`groups` in begin's `can`). An older one
        /// cannot, so they are neither offered nor sent.
        var groupsChoice = false
        /// How many labs the edge is to have, of each kind (docs/hypervisors.md,
        /// "Labs"). Changing either rebuilds the edge.
        var labsOpen = 0
        var labsClosed = 0
        /// The machine makes them (`labs` in begin's `can`). An older one
        /// cannot, so they are neither offered nor sent.
        var labsChoice = false
        /// How many labs one person may hold at once. 0 is the stepper's
        /// "No limit", sent as null and never as 0, which is no number of
        /// labs anybody could hold.
        var labsEach = 0
        /// The machine keeps it (`labs-each` in begin's `can`). An older one
        /// would drop it without a word, so it is neither offered nor sent.
        var labsEachChoice = false

        /// Whether Apply would rebuild the edge that is there to change its labs.
        func labsChanged(in inv: Inventory) -> Bool {
            guard labsChoice, let there = inv.edge(on: egress) else { return false }
            return (there.labs?.open ?? 0) != labsOpen || (there.labs?.closed ?? 0) != labsClosed
        }

        /// The fewest group networks there can be: the ones there now, which
        /// are never removed, because a machine may be on one.
        func groupRange(in inv: Inventory) -> ClosedRange<Int> {
            min(inv.groupCount(on: egress), XOPolicy.maxGroups)...XOPolicy.maxGroups
        }

        /// Make the pool a machine of its own on the way out, or keep the one
        /// there running (xo-holder.js). Needs the pool's machine image, there
        /// or made with it.
        var holder = false
        /// The machine makes one (`holder` in begin's `can`). An older one
        /// cannot, so it is neither offered nor sent.
        var holderChoice = false

        /// An image is asked for, in whichever form this machine reads.
        var wantsImage: Bool { imagesChoice ? !images.isEmpty : image }

        /// The images asked for that the way out's pool does not have yet.
        func imagesToBuild(in inv: Inventory) -> Set<String> {
            guard imageChoice, wantsImage else { return [] }
            return (imagesChoice ? images : [XOPolicy.debianKey]).subtracting(inv.imageKeys(on: egress))
        }

        /// The images the way out's pool has that Apply is to rebuild, or to
        /// remove, in the catalogue's order.
        func imageKeys(_ action: ImageAction, in inv: Inventory) -> [String] {
            guard imageManageChoice else { return [] }
            let present = inv.imageKeys(on: egress)
            return (inv.imageKinds ?? []).map(\.key).filter { present.contains($0) && imageActions[$0] == action }
        }

        /// The router or an image is to be built now, on storage still to be
        /// picked. A rebuilt image is built like a new one.
        func building(in inv: Inventory) -> (edge: Bool, image: Bool) {
            (edge && inv.edge(on: egress) == nil, !imagesToBuild(in: inv).isEmpty || !imageKeys(.rebuild, in: inv).isEmpty)
        }

        /// How much room the disks being built need on the storage picked:
        /// the image's when it is one of them, the router's otherwise.
        func diskNeed(in inv: Inventory) -> Int64 {
            building(in: inv).image ? XOPolicy.imageDiskBytes : XOPolicy.edgeDiskBytes
        }

        /// The storage the disks being built will go on: the person's pick
        /// while it is still one that fits on the way out's pool, otherwise
        /// the fleet's chosen storage there with the most room, otherwise the
        /// pool's. Nil when nothing in that pool has room.
        func edgeDisk(in inv: Inventory) -> String? {
            let fits = inv.edgeDisks(for: egress, need: diskNeed(in: inv))
            if let edgeSr, fits.contains(where: { $0.id == edgeSr }) { return edgeSr }
            let fleet = fits.filter { srs.contains($0.id) }
            return (fleet.isEmpty ? fits : fleet).max { $0.free < $1.free }?.id
        }
        var cpus = 1
        var memoryGiB = XOPolicy.minMemoryGiB
        var diskGiB = XOPolicy.minDiskGiB

        /// Where the screen starts: what the fleet may use now, wherever the
        /// pool says. A limit that is not set starts at half of what there is
        /// (memory: half the pool; disk: half the free space on the storage
        /// chosen), the way onboarding sets the first one; every number is
        /// then held inside what the machine will take.
        static func initial(for inv: Inventory, anyWayOut: Bool = false) -> Choice {
            var c = Choice()
            c.anyWayOut = anyWayOut
            c.srs = Set(inv.current.srs).intersection(inv.srs.map(\.id))
            let networks = Set(inv.current.networks).intersection(inv.networks.map(\.id))
            c.networks = networks
            c.egress = inv.networks.first { $0.egress && (anyWayOut || networks.contains($0.id)) }?.id
            // On when there is one already, so Apply keeps it on the way out.
            c.edge = inv.edge(on: c.egress) != nil
            // As it is: Apply rebuilds nothing the person did not change.
            c.edgeBlock = inv.edge(on: c.egress)?.blocks ?? false
            // The same for the pool's own machine: Apply keeps it, or starts it.
            c.holder = inv.holder(on: c.egress) != nil
            // As many as there are: Apply asks for none it does not show.
            c.groups = inv.groupCount(on: c.egress)
            // The labs the edge has: Apply rebuilds nothing nobody changed.
            c.labsOpen = inv.edge(on: c.egress)?.labs?.open ?? 0
            c.labsClosed = inv.edge(on: c.egress)?.labs?.closed ?? 0
            c.labsEach = inv.edge(on: c.egress)?.labsEach ?? 0
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

        /// A network on or off. On a machine that holds the way out to the
        /// fleet's networks, the way out goes with its network; on one that
        /// takes any of the pool's, it stays where it is.
        mutating func setNetwork(_ id: String, on: Bool) {
            if on { networks.insert(id) } else { networks.remove(id) }
            if !anyWayOut, let egress, !networks.contains(egress) {
                self.egress = nil
                edge = false
                holder = false
            }
        }

        /// Why the machine would refuse this, in its own words
        /// (`checkPolicy`), or nil when it would take it.
        func problem(in inv: Inventory) -> String? {
            if srs.isEmpty { return "Choose at least one storage repository: a VM needs somewhere for its disk." }
            if !srs.isSubset(of: inv.srs.map(\.id)) || !networks.isSubset(of: inv.networks.map(\.id)) {
                return "That names storage or a network this pool did not list."
            }
            if let egress, !inv.networks.contains(where: { $0.id == egress }) {
                return "The way out has to be a network this pool listed."
            }
            if !anyWayOut, let egress, !networks.contains(egress) { return "The way out has to be one of the networks the fleet may use." }
            if edge, egress == nil { return "The edge router needs a way out: choose the network its WAN goes on." }
            if groupsChoice, groups > 0, egress == nil {
                return "Group networks are made in the way out’s pool: choose the way out. Nothing was changed."
            }
            if labsChoice, labsOpen + labsClosed > XOPolicy.maxLabs {
                return "Between 0 and \(XOPolicy.maxLabs) labs in all. Nothing was changed."
            }
            if labsChoice, labsOpen + labsClosed > 0, egress == nil {
                return "Labs are on the edge router: choose the way out it is on. Nothing was changed."
            }
            if labsChoice, labsOpen + labsClosed > 0, !edge, inv.edge(on: egress) == nil {
                return "Labs are on the edge router, and that pool has none yet. Build the router with them. Nothing was changed."
            }
            if labsChoice, labsEachChoice, labsEach > labsOpen + labsClosed {
                return labsOpen + labsClosed == 0
                    ? "With no labs, labs per person is no limit. Nothing was changed."
                    : "Labs per person is no limit, or 1 to \(labsOpen + labsClosed), the labs there are. Nothing was changed."
            }
            if imageChoice, wantsImage, egress == nil {
                return "The machine image is built behind the edge router: choose the way out it leaves through."
            }
            if imageChoice, wantsImage, !edge, inv.edge(on: egress) == nil {
                return "The machine image is built behind the edge router, and that pool has none yet. Build the router with it."
            }
            if !imageKeys(.rebuild, in: inv).isEmpty, !edge, inv.edge(on: egress) == nil {
                return "A machine image is rebuilt behind the edge router, and that pool has none. Build the router with it."
            }
            if holderChoice, holder, imageKeys(.remove, in: inv).contains(XOPolicy.debianKey) {
                return "The pool’s own machine is made from the Debian 13 image, so that one stays while it is asked for."
            }
            if holderChoice, holder, egress == nil { return "The pool’s own machine goes on the way out: choose the network it is on." }
            if holderChoice, holder, inv.image(on: egress) == nil, !(imageChoice && wantsImage) {
                return "The pool’s own machine is made from its machine image, and that pool has none yet. Build one with it."
            }
            let build = building(in: inv)
            if edgeDiskChoice, build.image || build.edge, edgeDisk(in: inv) == nil {
                return build.image
                    ? "Nothing in the way out’s pool has 20 GiB free for the machine image’s disk."
                    : "Nothing in the way out’s pool has 3 GiB free for the edge router’s disk."
            }
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
            var out: [String: Any] = [
                "v": 1,
                "srs": inv.srs.map(\.id).filter { srs.contains($0) },
                "networks": inv.networks.map(\.id).filter { networks.contains($0) },
                "egress": way,
                "edge": edge,
                "limits": limits,
            ]
            // Only to a machine that builds an image, and only when asked.
            if imageChoice, wantsImage {
                if imagesChoice {
                    out["images"] = (inv.imageKinds ?? []).map(\.key).filter { images.contains($0) }
                } else {
                    out["image"] = true
                }
            }
            // Only to a machine that rebuilds and removes them, and only when asked.
            let rebuild = imageKeys(.rebuild, in: inv)
            let remove = imageKeys(.remove, in: inv)
            if !rebuild.isEmpty { out["rebuild"] = rebuild }
            if !remove.isEmpty { out["remove"] = remove }
            // Only to a machine that makes one, and only when asked.
            if holderChoice, holder { out["holder"] = true }
            // Only to a machine that makes them, and only with a way out.
            if groupsChoice, egress != nil { out["groups"] = groups }
            // Only to a machine that makes them, and only where there is a router, there or asked for.
            if labsChoice, egress != nil, edge || inv.edge(on: egress) != nil {
                out["labs"] = ["open": labsOpen, "closed": labsClosed]
                // And how many one person may hold, with them: null is no limit.
                if labsEachChoice { out["labsEach"] = labsEach > 0 ? (labsEach as Any) : (NSNull() as Any) }
            }
            // Only to a machine that builds either kind, and only with the router.
            if edgeBlockChoice, edge { out["edgeBlock"] = edgeBlock }
            // Only to a machine that reads it, and only with something to build.
            if edgeDiskChoice, edge || (imageChoice && wantsImage) || !rebuild.isEmpty { out["edgeSr"] = edgeDisk(in: inv).map { $0 as Any } ?? NSNull() }
            return out
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
        if let end = XOSetupWords.policyEnd(s.state) { return end }
        switch s.state {
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
