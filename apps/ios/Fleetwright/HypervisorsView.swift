import Network
import SwiftUI

/// Every hypervisor of yours, of either kind, on one page, and the one way to
/// add another. Asked for: "unify the two hypervisor pages". The Machines tab
/// had "Add a hypervisor", "Add Proxmox VE" and a list of the Xen Orchestra
/// pools this phone holds, and nothing anywhere for a Proxmox VE cluster,
/// whose token lives in the vault and on the boxes alone. A cluster the boxes
/// could not use was invisible for hours that way.
///
/// WHAT THIS PAGE IS FOR: is each hypervisor usable, and if not, why. So each
/// row is the same shape (RHYTHM 1): its address, which kind it is, and what
/// the machines holding it saw. A row that wears the attention ring is one no
/// machine can use, or a cluster too old for the fleet. Calm recedes, trouble
/// comes forward.
struct HypervisorsView: View {
    let settings: Settings

    /// The Xen Orchestra pools this phone holds a token for: their pages read
    /// the pool phone-direct with it.
    @State private var held: [XOSetupHandoff.Held] = []
    /// What the fleet says: nil before the first answer, and after one from a
    /// coordinator too old to send the list.
    @State private var fleet: [Fleet.Hypervisor]?
    @State private var loaded = false
    @State private var failed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One row per hypervisor: the fleet's, and this phone's pools the fleet
    /// does not list (no machine holds their token yet).
    private var rows: [Row] {
        var all = (fleet ?? []).map { h in Row(address: h.address, proxmox: h.onProxmox, fleet: h, onPhone: !h.onProxmox && held.contains { $0.address == h.address }) }
        for pool in held where !all.contains(where: { !$0.proxmox && $0.address == pool.address }) {
            all.append(Row(address: pool.address, proxmox: false, fleet: nil, onPhone: true))
        }
        return all.sorted { ($0.proxmox ? 1 : 0, $0.address) < ($1.proxmox ? 1 : 0, $1.address) }
    }

    struct Row: Identifiable, Hashable {
        let address: String
        let proxmox: Bool
        let fleet: Fleet.Hypervisor?
        let onPhone: Bool
        var id: String { "\(proxmox ? "proxmox" : "xo") \(address)" }
    }

    var body: some View {
        List {
            if !loaded {
                Text("Asking the fleet…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetRow()
            } else if rows.isEmpty {
                ContentUnavailableView {
                    Label("No hypervisors yet", systemImage: "square.stack.3d.up")
                } description: {
                    Text(failed ? HypervisorWords.fleetSilentEmpty : HypervisorWords.none)
                }
                .fleetRow()
            }
            if loaded && failed && !rows.isEmpty {
                Text(HypervisorWords.fleetSilent)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
                    .fleetRow()
            }
            ForEach(rows) { row in
                NavigationLink {
                    page(row)
                } label: {
                    card(row)
                }
                .fleetCard(radius: Design.Radius.cardSmall, ring: HypervisorWords.wantsSomething(row.fleet, onPhone: row.onPhone) ? Design.Palette.attention.opacity(0.55) : Design.Palette.ring)
                .fleetRow()
            }
            // ONE WAY TO ADD, after the list, which is read every time.
            NavigationLink {
                AddHypervisorChoiceView(settings: settings)
            } label: {
                Label("Add a hypervisor", systemImage: "plus")
                    .fleetType(.body)
                    .frame(minHeight: 44)
            }
            .fleetCard(radius: Design.Radius.cardSmall)
            .fleetRow()
        }
        .listStyle(.plain)
        .listRowSpacing(Design.Space.groupTight)
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle("Hypervisors")
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func page(_ row: Row) -> some View {
        // A POOL THIS PHONE HOLDS opens its own page, which reads the pool
        // with the token kept here; everything else opens what the fleet saw.
        if row.onPhone, let pool = held.first(where: { $0.address == row.address }) {
            PoolManageView(settings: settings, pool: pool)
        } else {
            HypervisorPageView(settings: settings, row: row)
        }
    }

    private func card(_ row: Row) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(row.address)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                Text(row.proxmox ? "Proxmox VE" : "Xen Orchestra")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            Text(HypervisorWords.status(row.fleet, onPhone: row.onPhone))
                .fleetType(.label)
                .foregroundStyle(HypervisorWords.wantsSomething(row.fleet, onPhone: row.onPhone) ? Design.Palette.attention : Design.Palette.inkDim)
            // HOW CURRENT ITS PAGE WILL BE, for a pool this phone reads
            // itself: nothing watches a pool while the app is closed, so the
            // row says when this phone last looked rather than letting the
            // page's first frame pass for now.
            if row.onPhone {
                Text(Manage.lastLooked(row.address).map { Manage.Words.rowLooked(relativeTime($0.timeIntervalSince1970 * 1000)) }
                     ?? Manage.Words.never)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens its page")
    }

    @MainActor
    private func load() async {
        held = XOSetupHandoff.heldPools()
        do {
            let got = try await Fleet(settings: settings).hypervisors()
            withAnimation(Design.Motion.settle(reduceMotion)) {
                fleet = got
                failed = false
                loaded = true
            }
        } catch {
            // A FAILED ASK IS NOT "NONE": what was listed stays, and the page
            // says the fleet did not answer.
            withAnimation(Design.Motion.settle(reduceMotion)) {
                failed = true
                loaded = true
            }
        }
    }
}

/// What the fleet saw of one hypervisor, box by box, and what can be done.
struct HypervisorPageView: View {
    let settings: Settings
    let row: HypervisorsView.Row

    var body: some View {
        List {
            Section {
                ForEach(row.fleet?.boxes ?? [], id: \.hostId) { box in
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(box.hostId).fleetType(.bodyStrong).foregroundStyle(Design.Palette.ink)
                            Spacer(minLength: 0)
                            Text(HypervisorWords.reach(box.reachable))
                                .fleetType(.label)
                                .foregroundStyle(box.reachable == true ? Design.Palette.ok : box.reachable == false ? Design.Palette.attention : Design.Palette.inkDim)
                        }
                        if let why = box.problem, !why.isEmpty {
                            Text(why).fleetType(.label).foregroundStyle(Design.Palette.inkDim).textSelection(.enabled)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
                if (row.fleet?.boxes ?? []).isEmpty {
                    Text(HypervisorWords.noBox).fleetType(.label).foregroundStyle(Design.Palette.attention)
                }
            } header: {
                Text("What each machine saw")
            } footer: {
                Text(HypervisorWords.boxesFooter)
            }
            if let f = row.fleet {
                Section("The hypervisor") {
                    ForEach(HypervisorWords.facts(f), id: \.self) { line in
                        Text(line).fleetType(.body).foregroundStyle(Design.Palette.ink)
                    }
                }
            }
            if row.proxmox {
                Section {
                    // THE SAME SETUP, again: it finds what it made, keeps the
                    // image, and hands over a new line.
                    NavigationLink("Set it up again") { AddProxmoxView(settings: settings) }
                        .frame(minHeight: 44)
                } footer: {
                    Text(HypervisorWords.againFooter)
                }
            } else if !row.onPhone {
                Section {
                    Text(HypervisorWords.xoElsewhere).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
            }
        }
        .navigationTitle(row.address)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Add a hypervisor: its address, and the kind found from what answers there.
/// Asked for: "Instead of ask which kind detect don't ask question you can
/// find the answer to". The fleet's machines look (`xoprobe`, which says both
/// whether Xen Orchestra answered and whether Proxmox VE's API did), and so
/// does this phone, at Proxmox VE's port, because a node is often on a
/// network only the phone reaches. The setup for what was found opens with
/// the address filled in. Only when nothing answers as either is the person
/// asked which it is, and then it is a fact nobody here could find.
struct AddHypervisorChoiceView: View {
    let settings: Settings

    @State private var address = ""
    @State private var finding = false
    @State private var found: Found?
    /// Nothing answered as either: said, and both setups offered.
    @State private var unknown: String?

    enum Found: Hashable {
        case xo(String)
        case pve(String)
    }

    private var trimmed: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            Section {
                TextField("Host name or address", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { Task { await find() } }
                    .frame(minHeight: 44)
                Button(finding ? "Looking…" : "Find it") { Task { await find() } }
                    .disabled(trimmed.isEmpty || finding)
                    .frame(minHeight: 44)
            } footer: {
                Text(HypervisorWords.findFooter)
            }
            if let unknown {
                Section {
                    Text(unknown).fleetType(.label).foregroundStyle(Design.Palette.attention)
                    NavigationLink { AddHypervisorView(settings: settings, startAt: trimmed) } label: {
                        VStack(alignment: .leading, spacing: Design.Space.hair) {
                            Text("Xen Orchestra").fleetType(.bodyStrong)
                            Text(HypervisorWords.xoChoice).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                    NavigationLink { AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(trimmed)) } label: {
                        VStack(alignment: .leading, spacing: Design.Space.hair) {
                            Text("Proxmox VE").fleetType(.bodyStrong)
                            Text(HypervisorWords.pveChoice).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                } header: {
                    Text("Which hypervisor is it")
                }
            }
        }
        .navigationTitle("Add a hypervisor")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $found) { what in
            switch what {
            case .xo(let at): AddHypervisorView(settings: settings, startAt: at)
            case .pve(let at): AddProxmoxView(settings: settings, startNode: at)
            }
        }
    }

    @MainActor
    private func find() async {
        let at = trimmed
        guard !at.isEmpty, !finding else { return }
        finding = true
        unknown = nil
        defer { finding = false }
        let fleet = Fleet(settings: settings)
        async let asked = try? fleet.xoprobe(address: at)
        async let opens = HypervisorAddress.pveAnswers(at)
        let probes = (await asked)?.probes ?? []
        let phoneSees = await opens
        if probes.contains(where: { $0.xo == true }) {
            found = .xo(at)
        } else if probes.contains(where: { $0.pve == true }) || phoneSees {
            found = .pve(HypervisorAddress.node(at))
        } else {
            unknown = HypervisorWords.notFound(at)
        }
    }
}

/// An address as Add a hypervisor reads it.
enum HypervisorAddress {
    /// The host, without a port, as the Proxmox VE setup takes it (it is
    /// what SSH is pointed at).
    static func node(_ address: String) -> String {
        split(address).host
    }

    static func split(_ address: String) -> (host: String, port: UInt16?) {
        if address.hasPrefix("["), let close = address.firstIndex(of: "]") {
            let host = String(address[address.index(after: address.startIndex)..<close])
            let rest = address[address.index(after: close)...]
            return (host, rest.hasPrefix(":") ? UInt16(rest.dropFirst()) : nil)
        }
        let parts = address.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count == 2, let port = UInt16(parts[1]) { return (String(parts[0]), port) }
        return (address, nil)
    }

    /// WHETHER PROXMOX VE'S PORT TAKES A CONNECTION from this phone: a TCP
    /// connection to 8006 (or the port the address names, unless it is 443,
    /// Xen Orchestra's), closed as soon as it opens. Nothing is sent, so no
    /// certificate is involved; the setup checks the node itself over SSH.
    static func pveAnswers(_ address: String) async -> Bool {
        let (host, named) = split(address)
        let port = named.flatMap { $0 == 443 ? nil : $0 } ?? 8006
        guard !host.isEmpty, let p = NWEndpoint.Port(rawValue: port) else { return false }
        let queue = DispatchQueue(label: "network.thetech.fleetwright.pve-port")
        let once = Once()
        let connection = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
        return await withCheckedContinuation { continuation in
            let end: @Sendable (Bool) -> Void = { open in
                guard !once.done else { return }
                once.done = true
                connection.cancel()
                continuation.resume(returning: open)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: end(true)
                case .failed, .waiting, .cancelled: end(false)
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 3) { end(false) }
        }
    }

    private final class Once: @unchecked Sendable {
        var done = false
    }
}

/// The page's words, the same on Android (HypervisorsScreen.kt); a test
/// holds the two equal (test/hypervisors-in-apps.test.js).
enum HypervisorWords {
    static let none = "Add one, and the machines that can reach it make machines on it for your sessions."
    static let fleetSilent = "The fleet did not answer, so only the pools this phone holds are listed. Open this page again to ask again."
    static let fleetSilentEmpty = "The fleet did not answer, and this phone holds no pool of its own. Open this page again to ask again."
    static let noBox = "No machine of the fleet holds its token yet. Machines pick up a hypervisor from your vault within ten minutes of it being kept there."
    static let boxesFooter = "Each machine you approved reads your vault and looks at the hypervisor every few minutes. One that can reach it makes machines on it."
    static let againFooter = "Run on the node again, it finds what it made, keeps the image, and hands over a new line. The old line stops working."
    static let xoElsewhere = "Its page opens on the phone that set it up, which holds its token."
    static let xoChoice = "A pool of XCP-ng hosts, through the Xen Orchestra in front of it."
    static let pveChoice = "A Proxmox VE 9 node or cluster, set up over SSH as root."
    static let findFooter = "The fleet's machines and this phone look at what answers there, and the setup for it opens."

    /// Nothing answered as either kind: the one question the page asks.
    static func notFound(_ address: String) -> String {
        "Nothing at \(address) answered as Xen Orchestra or as Proxmox VE, from the fleet's machines or from this phone. Which is it?"
    }

    static func reach(_ reachable: Bool?) -> String {
        switch reachable {
        case true?: return "reached it"
        case false?: return "could not reach it"
        case nil: return "has not looked yet"
        }
    }

    /// The row's one line: the machines that reached it and what is there, or
    /// why none could.
    static func status(_ h: Fleet.Hypervisor?, onPhone: Bool) -> String {
        guard let h, !h.boxes.isEmpty else {
            return onPhone ? "On this phone. No machine of the fleet holds its token yet." : "No machine of the fleet holds its token yet."
        }
        let reached = h.boxes.filter { $0.reachable == true }.map(\.hostId)
        if !reached.isEmpty {
            var parts = ["Reached from \(reached.joined(separator: ", "))"]
            if let n = h.images { parts.append(n == 1 ? "1 image" : "\(n) images") }
            if let n = h.machines { parts.append(n == 1 ? "1 machine" : "\(n) machines") }
            if h.onProxmox && h.supported == false { parts.append("older than Proxmox VE 9") }
            return parts.joined(separator: " · ")
        }
        if let failed = h.boxes.first(where: { $0.reachable == false }) {
            let why = failed.problem.map { ": \($0)" } ?? ""
            return "No machine reached it. \(failed.hostId)\(why)"
        }
        return "Not looked at yet. The machines holding it look every few minutes."
    }

    /// Whether the row wears the attention ring: nothing of the fleet's can
    /// use it, or the cluster is too old. Not looked at yet is not trouble.
    static func wantsSomething(_ h: Fleet.Hypervisor?, onPhone: Bool) -> Bool {
        guard let h else { return !onPhone }
        if h.boxes.isEmpty { return true }
        if h.boxes.contains(where: { $0.reachable == true }) { return h.onProxmox && h.supported == false }
        return h.boxes.contains { $0.reachable == false }
    }

    /// The facts the machines could tell, each said only when known.
    static func facts(_ h: Fleet.Hypervisor) -> [String] {
        var lines: [String] = []
        if let v = h.version { lines.append(h.onProxmox ? "Proxmox VE \(v)" : "Version \(v)") }
        if h.supported == false { lines.append("Older than Proxmox VE 9, so no machine is made on it.") }
        if let pools = h.pools, !pools.isEmpty { lines.append("\(h.onProxmox ? "Pool" : "Pools"): \(pools.joined(separator: ", "))") }
        if h.onProxmox {
            switch h.fenced {
            case true?: lines.append("The datacenter firewall is on, and the fleet's machines are behind it.")
            case false?: lines.append("The datacenter firewall is off: machines are made only on networks you chose until it is on.")
            case nil: break
            }
        }
        if let n = h.images { lines.append(n == 1 ? "1 machine image" : "\(n) machine images") }
        if let n = h.machines { lines.append(n == 1 ? "1 machine of the fleet's on it" : "\(n) machines of the fleet's on it") }
        return lines
    }
}
