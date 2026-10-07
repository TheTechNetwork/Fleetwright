import CryptoKit
import Foundation

/// Managing a Xen Orchestra pool from this phone, directly: the rules the
/// screens in ManageView.swift draw, with no networking in them.
/// docs/manage.md, "The first slice".
///
/// A COMPONENT HAS THREE PARTS, and every row and every page is built from
/// them, so a pool, a host, a VM and a storage repository are the same kind of
/// row (RHYTHM 1):
///
///   what it is     its name, its kind, where it lives and what it belongs to
///   how it is      one state from a fixed set, and the numbers behind it
///   what it can do the actions that exist for it now, and what each costs
///
/// AN ACTION IS DRAWN ONLY WHEN THE SERVER LISTS ITS METHOD (C-2).
/// `system.getMethodsInfo` is Xen Orchestra's own list, so an action whose
/// method this server does not offer is not drawn, rather than drawn and
/// refused. A list that could not be read is cannot tell and draws nothing:
/// a guess about a method name is how a broken button gets made, which is the
/// guard xo-setup.js keeps for the same reason.
///
/// WHAT IT COSTS TO UNDO decides how it is confirmed. Reversible (start,
/// resume, a snapshot, maintenance mode) is one tap. Interrupting (shut down,
/// reboot, pause, suspend) asks, naming what it interrupts. Destructive
/// (forcing a VM off or to restart, deleting one) asks for the name typed
/// back. Growing a disk asks too: nothing is lost, and it cannot be undone.
///
/// MISSING IS CANNOT TELL. A token sees only what its user may see, so a VM can
/// sit on a host the list does not have, and a field Xen Orchestra did not send
/// is said as not known rather than drawn as a zero or a blank (C-5).
///
/// THE SAME RULES ARE WRITTEN IN Manage.kt, and both are run against one table,
/// test/fixtures/parity/manage.json, by ManageParityTests and its Kotlin twin:
/// change a sentence or a rule here and that table has to change with it,
/// which fails Android until it agrees.
enum Manage {

    // MARK: What is listed

    enum Kind: String, CaseIterable {
        case pool, host, vm, sr
    }

    /// How a host or a VM is. Nil is cannot tell, and a pool or a storage
    /// repository has none of its own: its numbers say how it is.
    enum State: String {
        case running, stopped, suspended, paused, maintenance
    }

    struct Component: Identifiable, Equatable {
        let id: String
        let kind: Kind
        let name: String
        let state: State?
        let poolId: String?
        /// Xen Orchestra's `$container`: the host a running VM or a local
        /// storage repository is on, or the pool when it is on none.
        let containerId: String?
        /// A VM's vCPUs, a host's cores.
        let cpus: Int?
        /// A VM's memory, a host's total.
        let memory: Int64?
        /// A host's memory in use.
        let memoryUsed: Int64?
        /// A storage repository's size and what is physically used of it.
        let size: Int64?
        let used: Int64?
        /// A VM's main address, a host's management address.
        let address: String?
        /// A VM's guest tools: true when either the agent or the drivers were
        /// detected, false when both were said to be missing, nil when neither
        /// was said.
        let toolsRunning: Bool?
        let storageType: String?
        let shared: Bool?
        /// A host's "XCP-ng 8.3.0".
        let software: String?
    }

    /// A VM's disk, for growing it.
    struct Disk: Identifiable, Equatable {
        let id: String
        let name: String
        let size: Int64?
        let storageId: String?
    }

    /// A VBD: which disk is attached to which VM, and where.
    struct Attachment: Equatable {
        let vm: String
        let vdi: String?
        let cd: Bool
        let position: String
    }

    /// The types read, each with its own `xo.getAllObjects` filter.
    static let objectTypes = ["pool", "host", "VM", "SR", "VBD", "VDI"]

    // MARK: Decoding what Xen Orchestra sent

    static func text(_ any: Any?) -> String? {
        guard let s = any as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// A count or a size. A JSON boolean is not a number here, though
    /// Foundation would happily read one as 1.
    static func number(_ any: Any?) -> Int64? {
        guard let n = any as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= 0, d < 9.0e18 else { return nil }
        return Int64(d)
    }

    static func flag(_ any: Any?) -> Bool? {
        guard let n = any as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    static func kindWord(_ kind: Kind) -> String {
        switch kind {
        case .pool: return "pool"
        case .host: return "host"
        case .vm: return "VM"
        case .sr: return "storage"
        }
    }

    static func component(_ o: [String: Any]) -> Component? {
        guard let id = text(o["id"]), let type = o["type"] as? String else { return nil }
        let kind: Kind
        switch type {
        case "pool": kind = .pool
        case "host": kind = .host
        case "VM": kind = .vm
        case "SR": kind = .sr
        default: return nil
        }
        let cpus = o["CPUs"] as? [String: Any]
        let hostCpus = o["cpus"] as? [String: Any]
        let memory = o["memory"] as? [String: Any]
        let agent = flag(o["managementAgentDetected"])
        let drivers = flag(o["pvDriversDetected"])
        let tools: Bool?
        if agent == true || drivers == true {
            tools = true
        } else if agent == false || drivers == false {
            tools = false
        } else {
            tools = nil
        }
        let software = [text(o["productBrand"]), text(o["version"])].compactMap { $0 }.joined(separator: " ")
        // One let per field rather than ternaries in the initialiser: the
        // type checker gives up on an expression this size, and only on CI.
        var count: Int64?
        var address: String?
        if kind == .vm {
            count = number(cpus?["number"])
            address = vmAddress(o)
        } else if kind == .host {
            count = number(hostCpus?["cores"])
            address = text(o["address"])
        }
        let sized = kind == .vm || kind == .host
        let storage = kind == .sr
        return Component(
            id: id,
            kind: kind,
            name: text(o["name_label"]) ?? "Unnamed \(kindWord(kind)) \(String(id.prefix(8)))",
            state: state(kind, o),
            poolId: text(o["$pool"]),
            containerId: text(o["$container"]),
            cpus: count.map { Int($0) },
            memory: sized ? number(memory?["size"]) : nil,
            memoryUsed: kind == .host ? number(memory?["usage"]) : nil,
            size: storage ? number(o["size"]) : nil,
            used: storage ? number(o["physical_usage"]) : nil,
            address: address,
            toolsRunning: kind == .vm ? tools : nil,
            storageType: storage ? text(o["SR_type"]) : nil,
            shared: storage ? flag(o["shared"]) : nil,
            software: kind == .host && !software.isEmpty ? software : nil
        )
    }

    static func state(_ kind: Kind, _ o: [String: Any]) -> State? {
        let power = o["power_state"] as? String
        switch kind {
        case .vm:
            switch power {
            case "Running"?: return .running
            case "Halted"?: return .stopped
            case "Suspended"?: return .suspended
            case "Paused"?: return .paused
            default: return nil
            }
        case .host:
            if power == "Halted" { return .stopped }
            guard power == "Running" else { return nil }
            // A disabled host takes no new VMs: maintenance mode, as Xen
            // Orchestra's own screens call it.
            return flag(o["enabled"]) == false ? .maintenance : .running
        case .pool, .sr:
            return nil
        }
    }

    /// The address a VM's guest agent reported: the main one, or the first
    /// IPv4 one, as xo-pools.js reads it.
    static func vmAddress(_ o: [String: Any]) -> String? {
        if let main = text(o["mainIpAddress"]) { return main }
        guard let all = o["addresses"] as? [String: Any] else { return nil }
        let keys = all.keys.sorted()
        guard let key = keys.first(where: { $0.contains("ipv4") }) ?? keys.first else { return nil }
        return text(all[key])
    }

    static func attachment(_ o: [String: Any]) -> Attachment? {
        guard let vm = text(o["VM"]) else { return nil }
        return Attachment(vm: vm, vdi: text(o["VDI"]), cd: flag(o["is_cd_drive"]) == true, position: text(o["position"]) ?? "")
    }

    static func disk(_ o: [String: Any]) -> Disk? {
        guard let id = text(o["id"]) else { return nil }
        return Disk(id: id, name: text(o["name_label"]) ?? "Unnamed disk \(String(id.prefix(8)))",
                    size: number(o["size"]), storageId: text(o["$SR"]))
    }

    // MARK: What the phone knows about the pool

    /// Everything read, kept current from the notifications Xen Orchestra
    /// pushes on the same socket rather than by asking again.
    struct Snapshot: Equatable {
        var components: [String: Component] = [:]
        var disks: [String: Disk] = [:]
        var attachments: [String: Attachment] = [:]

        mutating func enter(_ o: [String: Any]) {
            guard let id = Manage.text(o["id"]), let type = o["type"] as? String else { return }
            switch type {
            case "VBD":
                if let a = Manage.attachment(o) { attachments[id] = a }
            case "VDI":
                if let d = Manage.disk(o) { disks[id] = d }
            default:
                if let c = Manage.component(o) { components[id] = c }
            }
        }

        mutating func leave(_ id: String) {
            components[id] = nil
            disks[id] = nil
            attachments[id] = nil
        }

        /// What `xo.getAllObjects` answered: objects keyed by id, or a list
        /// of them from an older server.
        mutating func take(_ answer: Any?) {
            if let byId = answer as? [String: Any] {
                for value in byId.values { if let o = value as? [String: Any] { enter(o) } }
            } else if let list = answer as? [Any] {
                for value in list { if let o = value as? [String: Any] { enter(o) } }
            }
        }

        /// A notification from the socket. Only `all` carries objects: an
        /// `enter` is an object that arrived or changed, an `exit` one that
        /// went. Anything else is left alone; true when it was one of these.
        @discardableResult
        mutating func apply(method: String, params: Any?) -> Bool {
            guard method == "all", let p = params as? [String: Any], let type = p["type"] as? String,
                  let items = p["items"] as? [String: Any]
            else { return false }
            for (id, value) in items {
                if type == "exit" {
                    leave(id)
                } else if type == "enter", let o = value as? [String: Any] {
                    enter(o)
                }
            }
            return true
        }

        /// One kind, by name, the way a person scans for one.
        func list(_ kind: Kind) -> [Component] {
            components.values.filter { $0.kind == kind }.sorted { a, b in
                let x = a.name.lowercased(), y = b.name.lowercased()
                return x == y ? a.id < b.id : x < y
            }
        }

        var isEmpty: Bool { components.isEmpty }

        /// The host a VM or a storage repository is on, when it is on one:
        /// `$container` names the pool otherwise.
        func hostId(of c: Component) -> String? {
            guard let container = c.containerId, container != c.poolId else { return nil }
            return container
        }

        /// How many VMs this token can see running on a host.
        func runningOn(_ hostId: String) -> Int {
            components.values.filter { $0.kind == .vm && $0.state == .running && self.hostId(of: $0) == hostId }.count
        }

        /// A VM's disks, CD drives left out, in the order they are attached.
        func attachedDisks(_ vmId: String) -> [Disk] {
            let mine = attachments.values.filter { $0.vm == vmId && !$0.cd && $0.vdi != nil }
            let ordered = mine.sorted { a, b in
                (Int(a.position) ?? Int.max, a.position) < (Int(b.position) ?? Int.max, b.position)
            }
            return ordered.compactMap { a in a.vdi.flatMap { id in self.disks[id] } }
        }
    }

    // MARK: Words

    /// Sizes in powers of 1024, as Xen Orchestra reports them, to a tenth,
    /// rounded half away from zero by hand so both phones round alike.
    static func bytes(_ b: Int64) -> String {
        let units: [(Int64, String)] = [(1 << 40, "TiB"), (1 << 30, "GiB"), (1 << 20, "MiB")]
        for (size, unit) in units where b >= size {
            let tenths = Int64((Double(b) / Double(size) * 10).rounded())
            return tenths % 10 == 0 ? "\(tenths / 10) \(unit)" : "\(tenths / 10).\(tenths % 10) \(unit)"
        }
        return "\(b) byte\(b == 1 ? "" : "s")"
    }

    static func stateWords(_ state: State?) -> String {
        guard let state else { return "cannot tell" }
        switch state {
        case .running: return "running"
        case .stopped: return "stopped"
        case .suspended: return "suspended"
        case .paused: return "paused"
        case .maintenance: return "in maintenance mode"
        }
    }

    /// The state word a row carries, or nil for a kind that has no state.
    static func stateWords(_ c: Component) -> String? {
        c.kind == .vm || c.kind == .host ? stateWords(c.state) : nil
    }

    static func poolWords(_ id: String?, in s: Snapshot) -> String {
        if let id, let p = s.components[id], p.kind == .pool { return "pool \(p.name)" }
        return "a pool this token cannot see"
    }

    /// What it is: its kind, and where it lives.
    static func what(_ c: Component, in s: Snapshot) -> String {
        switch c.kind {
        case .pool:
            let n = s.components.values.filter { $0.kind == .host && $0.poolId == c.id }.count
            return "Pool of \(n) host\(n == 1 ? "" : "s")"
        case .host:
            let place = "Host in \(poolWords(c.poolId, in: s))"
            return c.software.map { "\(place) · \($0)" } ?? place
        case .vm:
            if let hostId = s.hostId(of: c) {
                guard let host = s.components[hostId], host.kind == .host else { return "VM on a host this token cannot see" }
                return "VM on \(host.name) in \(poolWords(c.poolId, in: s))"
            }
            return "VM in \(poolWords(c.poolId, in: s)), not on a host"
        case .sr:
            var parts = ["Storage"]
            if let type = c.storageType { parts.append(type) }
            if let hostId = s.hostId(of: c) {
                if let host = s.components[hostId], host.kind == .host {
                    parts.append("on \(host.name)")
                } else {
                    parts.append("on a host this token cannot see")
                }
            } else if c.shared == true || c.containerId != nil {
                parts.append("shared by \(poolWords(c.poolId, in: s))")
            }
            return parts.joined(separator: ", ")
        }
    }

    /// The numbers behind how it is. Each one Xen Orchestra did not send is
    /// said as cannot tell, in its place.
    static func numbers(_ c: Component, in s: Snapshot) -> String {
        switch c.kind {
        case .pool:
            let vms = s.components.values.filter { $0.kind == .vm && $0.poolId == c.id }
            let running = vms.filter { $0.state == .running }.count
            return vms.isEmpty ? "No VMs" : "\(running) of \(vms.count) VMs running"
        case .host:
            let cores = c.cpus.map { "\($0) core\($0 == 1 ? "" : "s")" } ?? "cores: cannot tell"
            let memory: String
            if let size = c.memory, let used = c.memoryUsed {
                memory = "\(bytes(used)) of \(bytes(size)) in use"
            } else if let size = c.memory {
                memory = "\(bytes(size)), use cannot tell"
            } else {
                memory = "memory: cannot tell"
            }
            let n = s.runningOn(c.id)
            let vms = n == 0 ? "no VMs running" : "\(n) VM\(n == 1 ? "" : "s") running"
            return [cores, memory, vms].joined(separator: " · ")
        case .vm:
            var parts = [c.cpus.map { "\($0) vCPU\($0 == 1 ? "" : "s")" } ?? "vCPUs: cannot tell",
                         c.memory.map { bytes($0) } ?? "memory: cannot tell"]
            if let address = c.address { parts.append(address) }
            return parts.joined(separator: " · ")
        case .sr:
            guard let size = c.size, let used = c.used else { return "space: cannot tell" }
            return "\(bytes(max(0, size - used))) free of \(bytes(size))"
        }
    }

    // MARK: What it can do

    enum Cost: String {
        case reversible, interrupting, destructive
    }

    enum Verb: String, CaseIterable {
        case start, resume, unpause, snapshot, clone, shutdown, reboot, pause, suspend, forceReboot, forceShutdown, delete
        case maintenanceOn, maintenanceOff, hostReboot
    }

    struct Action: Identifiable, Equatable {
        let verb: Verb
        let label: String
        /// The method it calls, which is the one the server listed.
        let method: String
        let cost: Cost
        var id: String { verb.rawValue }
    }

    /// How an action is confirmed, decided by what it costs to undo.
    enum Confirmation: Equatable {
        case none
        case ask(title: String, button: String)
        case typeName(title: String, name: String, button: String)
    }

    /// The actions that exist for this component now, in the order they are
    /// drawn: the ones that undo themselves first, the ones that cannot last.
    /// Nothing when the methods could not be read, and nothing when its state
    /// is not known, because every one of these depends on it.
    static func offered(_ c: Component, methods: Set<String>?) -> [Action] {
        guard let methods, let state = c.state else { return [] }
        var out: [Action] = []
        func add(_ verb: Verb, _ label: String, _ method: String, _ cost: Cost, when ok: Bool) {
            if ok, methods.contains(method) { out.append(Action(verb: verb, label: label, method: method, cost: cost)) }
        }
        switch c.kind {
        case .vm:
            // NO GUEST TOOLS, NO CLEAN SHUTDOWN: Xen Orchestra asks the guest
            // to shut itself down, and a guest with no agent cannot hear it.
            // Not drawn when it was said to be missing; drawn when nothing was
            // said, because that is cannot tell, not no.
            let tools = c.toolsRunning != false
            add(.start, "Start", "vm.start", .reversible, when: state == .stopped)
            add(.resume, "Resume", "vm.resume", .reversible, when: state == .suspended)
            add(.unpause, "Unpause", "vm.unpause", .reversible, when: state == .paused)
            add(.snapshot, "Take a snapshot", "vm.snapshot", .reversible, when: true)
            add(.clone, "Clone", "vm.clone", .reversible, when: state == .stopped)
            add(.shutdown, "Shut down", "vm.stop", .interrupting, when: state == .running && tools)
            add(.reboot, "Reboot", "vm.restart", .interrupting, when: state == .running && tools)
            add(.pause, "Pause", "vm.pause", .interrupting, when: state == .running)
            add(.suspend, "Suspend", "vm.suspend", .interrupting, when: state == .running)
            add(.forceReboot, "Force a restart", "vm.restart", .destructive, when: state == .running || state == .paused)
            add(.forceShutdown, "Force off", "vm.stop", .destructive,
                when: state == .running || state == .paused || state == .suspended)
            add(.delete, "Delete", "vm.delete", .destructive, when: state == .stopped)
        case .host:
            // setMaintenanceMode moves a host's VMs off first; an older Xen
            // Orchestra has only disable and enable, which is the same mode.
            let modern = methods.contains("host.setMaintenanceMode")
            add(.maintenanceOn, "Enter maintenance mode", modern ? "host.setMaintenanceMode" : "host.disable", .reversible,
                when: state == .running)
            add(.maintenanceOff, "Leave maintenance mode", modern ? "host.setMaintenanceMode" : "host.enable", .reversible,
                when: state == .maintenance)
            add(.hostReboot, "Reboot", "host.restart", .interrupting, when: state == .running || state == .maintenance)
        case .pool, .sr:
            break
        }
        return out
    }

    static func cloneName(_ c: Component) -> String { "\(c.name) (clone)" }

    /// A snapshot's name: the VM's, and when, in UTC so both phones and Xen
    /// Orchestra's own list agree on it.
    static func stamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return "\(f.string(from: date)) UTC"
    }

    /// What is sent, in the shapes xo-pools.js and vm-image.js already send.
    static func params(_ a: Action, for c: Component, now: Date) -> [String: Any] {
        switch a.verb {
        case .shutdown, .reboot:
            return ["id": c.id, "force": false]
        case .forceShutdown, .forceReboot:
            return ["id": c.id, "force": true]
        case .snapshot:
            return ["id": c.id, "name": "\(c.name) \(stamp(now))"]
        case .clone:
            return ["id": c.id, "name": cloneName(c), "full_copy": false]
        case .delete:
            return ["id": c.id, "deleteDisks": true]
        case .maintenanceOn:
            return a.method == "host.setMaintenanceMode" ? ["id": c.id, "maintenance": true] : ["id": c.id]
        case .maintenanceOff:
            return a.method == "host.setMaintenanceMode" ? ["id": c.id, "maintenance": false] : ["id": c.id]
        case .start, .resume, .unpause, .pause, .suspend, .hostReboot:
            return ["id": c.id]
        }
    }

    static func confirmation(_ a: Action, for c: Component, in s: Snapshot) -> Confirmation {
        let n = c.name
        switch a.verb {
        case .shutdown:
            return .ask(title: "Shut down \(n)? Everything running on it stops.", button: "Shut down")
        case .reboot:
            return .ask(title: "Reboot \(n)? Everything running on it restarts.", button: "Reboot")
        case .pause:
            return .ask(title: "Pause \(n)? Everything running on it is frozen until it is unpaused.", button: "Pause")
        case .suspend:
            return .ask(title: "Suspend \(n)? Everything running on it stops until it is resumed, from where it left off.",
                        button: "Suspend")
        case .hostReboot:
            let k = s.runningOn(c.id)
            let cost: String
            if k == 0 {
                cost = "No VM this phone can see is running on it."
            } else if k == 1 {
                cost = "1 VM running on it stops with it unless Xen Orchestra moves it to another host first."
            } else {
                cost = "\(k) VMs running on it stop with it unless Xen Orchestra moves them to another host first."
            }
            return .ask(title: "Reboot \(n)? \(cost)", button: "Reboot")
        case .forceReboot:
            return .typeName(title: "Force \(n) to restart? It is reset as if its power button were held: anything not saved on it is lost.",
                             name: n, button: "Force a restart")
        case .forceShutdown:
            return .typeName(title: "Force \(n) off? It is cut off as if unplugged: anything not saved on it is lost.",
                             name: n, button: "Force it off")
        case .delete:
            return .typeName(title: "Delete \(n) and its disks? This cannot be undone.", name: n, button: "Delete it")
        case .start, .resume, .unpause, .snapshot, .clone, .maintenanceOn, .maintenanceOff:
            return .none
        }
    }

    /// What is said once Xen Orchestra has answered yes.
    static func done(_ a: Action, for c: Component) -> String {
        let n = c.name
        switch a.verb {
        case .start: return "Started \(n)."
        case .resume: return "Resumed \(n)."
        case .unpause: return "Unpaused \(n)."
        case .snapshot: return "Took a snapshot of \(n)."
        case .clone: return "Cloned \(n) as \(cloneName(c))."
        case .shutdown: return "Shut down \(n)."
        case .reboot: return "Rebooted \(n)."
        case .pause: return "Paused \(n)."
        case .suspend: return "Suspended \(n)."
        case .forceReboot: return "Forced \(n) to restart."
        case .forceShutdown: return "Forced \(n) off."
        case .delete: return "Deleted \(n) and its disks."
        case .maintenanceOn: return "\(n) is in maintenance mode."
        case .maintenanceOff: return "\(n) is out of maintenance mode."
        case .hostReboot: return "Rebooting \(n)."
        }
    }

    // MARK: Its size

    static let gib: Int64 = 1 << 30

    /// vCPUs and memory, offered only while the VM is stopped: Xen
    /// Orchestra changes a running VM's only within limits set while it was
    /// stopped, and a change that might be refused is not offered as one.
    static func canResize(_ c: Component, methods: Set<String>?) -> Bool {
        c.kind == .vm && c.state == .stopped && methods?.contains("vm.set") == true
    }

    /// The sentence in its place on a VM that could be resized if stopped.
    static func resizeNeedsStopped(_ c: Component, methods: Set<String>?) -> Bool {
        c.kind == .vm && c.state != nil && c.state != .stopped && methods?.contains("vm.set") == true
    }

    /// How a disk is grown, in the host's order (RESIZE_METHODS in
    /// src/fleet/host/xo-setup.js): `disk.resize`, or `vdi.set` with a size.
    static let growMethods = ["disk.resize", "vdi.set"]

    /// Running or not; nil when neither method is listed or the VM's state
    /// is not known.
    static func growMethod(_ c: Component, methods: Set<String>?) -> String? {
        guard c.kind == .vm, c.state != nil, let methods else { return nil }
        return growMethods.first { methods.contains($0) }
    }

    static func resizeParams(_ c: Component, cpus: Int, memoryGiB: Int) -> [String: Any] {
        ["id": c.id, "CPUs": cpus, "memory": Int64(memoryGiB) * gib]
    }

    static func resized(_ c: Component, cpus: Int, memoryGiB: Int) -> String {
        "\(c.name) now has \(cpus) vCPU\(cpus == 1 ? "" : "s") and \(bytes(Int64(memoryGiB) * gib))."
    }

    static func growParams(_ d: Disk, toGiB: Int) -> [String: Any] {
        ["id": d.id, "size": Int64(toGiB) * gib]
    }

    static func growConfirmation(_ d: Disk, toGiB: Int) -> Confirmation {
        .ask(title: "Grow \(d.name) to \(bytes(Int64(toGiB) * gib))? A disk cannot be made smaller again.", button: "Grow it")
    }

    static func grown(_ d: Disk, toGiB: Int) -> String {
        "\(d.name) is now \(bytes(Int64(toGiB) * gib))."
    }

    // MARK: The token this phone holds

    /// What setup sealed back to this phone (XOSetupHandoff), as much of it
    /// as connecting needs. The admin sign-in is not in it and never was: a
    /// password used to make a token is dropped on the machine that used it.
    struct Record: Equatable {
        let token: String
        let pin: String?
        let plain: Bool
        let user: String?
        /// Nil is the server's own default length, which it does not say.
        let expires: Date?
    }

    static func record(_ raw: String, address: String) -> Record? {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              o["address"] as? String == address,
              let token = o["token"] as? String, !token.isEmpty
        else { return nil }
        let expires = (o["tokenExpires"] as? String).flatMap { isoDate($0) }
        return Record(token: token, pin: text(o["pin"]), plain: flag(o["plain"]) == true, user: text(o["user"]), expires: expires)
    }

    static func isoDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// A certificate's SHA-256 as the host writes a pin: lowercase hex of the
    /// DER (certSha256 in src/fleet/host/xo-ws.js).
    static func fingerprint(der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: When it was last looked at

    /// Nothing watches a phone-direct pool while the app is closed, so the
    /// screen says when it last knew. Kept per address; not a secret.
    private static let lookedKey = "manage.looked"

    static func lastLooked(_ address: String) -> Date? {
        guard let at = (UserDefaults.standard.dictionary(forKey: lookedKey) as? [String: Double])?[address] else { return nil }
        return Date(timeIntervalSince1970: at)
    }

    static func rememberLooked(_ address: String, at date: Date) {
        var all = (UserDefaults.standard.dictionary(forKey: lookedKey) as? [String: Double]) ?? [:]
        all[address] = date.timeIntervalSince1970
        UserDefaults.standard.set(all, forKey: lookedKey)
    }

    // MARK: Sentences

    /// Every sentence the screens say about a pool, in one place, held equal
    /// to Manage.kt's by the shared table.
    enum Words {
        static let watching = "Watching now. Changes arrive as Xen Orchestra makes them."
        static func connecting(_ address: String) -> String { "Connecting to \(address)…" }
        static let never = "Not looked at from this phone yet."
        static let closed = "Nothing watches while the app is closed."
        static func lookedAt(_ when: String) -> String { "Last looked at \(when). \(closed)" }
        static func rowLooked(_ when: String) -> String { "Last looked at \(when)" }
        static func plainPool(_ address: String) -> String {
            "\(address) was set up over plain HTTP. This phone manages a pool only over HTTPS, with the certificate pinned at setup, "
                + "so it does not connect to this one."
        }
        static func noToken(_ address: String) -> String {
            "This phone holds no token for \(address) any more. Run Add a hypervisor again for it."
        }
        static func expired(_ address: String, on date: String) -> String {
            "Its token ran out on \(date). Run Add a hypervisor again for \(address) to make a new one."
        }
        static func wrongCertificate(_ address: String) -> String {
            "\(address) answered with a different certificate from the one pinned when it was set up. Nothing was sent. "
                + "If Xen Orchestra’s certificate changed, run Add a hypervisor again for it."
        }
        static func signInRefused(_ address: String, _ why: String) -> String {
            "Xen Orchestra refused this phone’s token for \(address): \(why). If it ran out or was revoked, run Add a hypervisor again for it."
        }
        static let noObjects = "This Xen Orchestra does not offer xo.getAllObjects, so nothing can be listed."
        static func lost(_ why: String) -> String { "The connection ended: \(why). Look again to reconnect." }
        static let methodsUnknown = "Cannot tell which actions this Xen Orchestra offers, so none are drawn."
        static let nothingOffered = "Nothing Xen Orchestra offers can be done to it in the state it is in."
        static let seesNothing = "This token sees nothing on the pool."
        static func limitedUser(_ user: String) -> String {
            "Signed in as \(user), the limited user setup made, so only what its resource set allows is listed."
        }
        static let tuneNeedsStopped = "vCPUs and memory change only while it is stopped."
        static let growNote = "A disk can grow while the VM runs. It cannot be made smaller again."
        static func refused(_ why: String) -> String { "Xen Orchestra refused: \(why)" }
        static let slow = "Xen Orchestra did not answer in time. It may still be doing it; the list shows what it reports."
        static func typePrompt(_ name: String) -> String { "Type \(name) to confirm." }
        static let actionsFooter = "Each action is here only because this Xen Orchestra lists its method. Shutting down, rebooting, "
            + "pausing and suspending ask first; forcing a VM off or deleting one asks for its name typed back."
        static let gone = "Xen Orchestra no longer lists it. It may have been deleted, or this token can no longer see it."
        static let lookAgain = "Look again"
        static let changePolicy = "Change what the fleet may use"
        static let whatItIs = "What it is"
        static let howItIs = "How it is"
        static let whatItCanDo = "What it can do"
        static func resizeButton(cpus: Int, memoryGiB: Int) -> String {
            "Set to \(cpus) vCPU\(cpus == 1 ? "" : "s") and \(memoryGiB) GiB"
        }
        static func growButton(_ disk: String, toGiB: Int) -> String { "Grow \(disk) to \(toGiB) GiB" }

        /// A section of the pool's page.
        static func heading(_ kind: Kind) -> String {
            switch kind {
            case .pool: return "Pools"
            case .host: return "Hosts"
            case .vm: return "VMs"
            case .sr: return "Storage"
            }
        }

        /// What a component is, on its own page.
        static func kindTitle(_ kind: Kind) -> String {
            switch kind {
            case .pool: return "Pool"
            case .host: return "Host"
            case .vm: return "VM"
            case .sr: return "Storage"
            }
        }
    }

    /// A disk, as its row says it: its size and where it is kept.
    static func diskLine(_ d: Disk, in s: Snapshot) -> String {
        let size = d.size.map { bytes($0) } ?? "size cannot tell"
        if let id = d.storageId, let sr = s.components[id], sr.kind == .sr { return "\(size) on \(sr.name)" }
        return "\(size) on storage this token cannot see"
    }
}
