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
/// row is the same shape (RHYTHM 1): its address, which kind it is, and one
/// short status from a fixed set (`HypervisorWords.status`). The why, the
/// machines and the counts are on its page, not in the row (the copy review
/// of 2026-11-06, finding 59). A row that wears the attention ring is one no
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
                Text("Checking…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetRow()
            } else if rows.isEmpty {
                ContentUnavailableView {
                    // THE TITLE KEEPS §7: a fleet that did not answer is not a fleet with
                    // no hypervisors, and the title says which.
                    Label(failed ? "Couldn't load hypervisors" : "No hypervisors yet", systemImage: "square.stack.3d.up")
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
            // ONE STATUS, never colour alone: the word changes with the colour.
            // `answered` keeps §7: a pool the fleet did not list is waiting for
            // a machine only when the fleet actually answered, and Unknown
            // when it did not.
            Text(HypervisorWords.status(row.fleet, onPhone: row.onPhone, answered: fleet != nil))
                .fleetType(.label)
                .foregroundStyle(HypervisorWords.wantsSomething(row.fleet, onPhone: row.onPhone) ? Design.Palette.attention : Design.Palette.inkDim)
            // HOW CURRENT ITS PAGE WILL BE, for a pool this phone reads
            // itself: nothing watches a pool while the app is closed, so the
            // row says when this phone last read it rather than letting the
            // page's first frame pass for now.
            if row.onPhone {
                Text(Manage.lastLooked(row.address).map { HypervisorWords.updated(relativeTime($0.timeIntervalSince1970 * 1000)) }
                     ?? HypervisorWords.neverOpened)
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

/// One hypervisor: the answer in a sentence, then the machines that checked
/// it, its details, and what can be done. The sentence is the page; the rest
/// is the evidence under it.
struct HypervisorPageView: View {
    let settings: Settings
    let row: HypervisorsView.Row

    var body: some View {
        List {
            Section {
                Text(HypervisorWords.answer(row.fleet))
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                    .frame(minHeight: 44, alignment: .leading)
            }
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
                        // THE MACHINE'S OWN WORDS on why, under Details: the
                        // row's verdict is the word beside the name, and the
                        // sentence is the mechanism (docs/design-system.md,
                        // Words), selectable because it names a path and a
                        // status, which is what gets searched for.
                        if let why = box.problem, !why.isEmpty {
                            DisclosureGroup("Details") {
                                Text(why).fleetType(.label).foregroundStyle(Design.Palette.inkDim).textSelection(.enabled)
                            }
                            .fleetType(.label)
                            .frame(minHeight: 44)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                if (row.fleet?.boxes ?? []).isEmpty {
                    Text(HypervisorWords.noBox).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
            } header: {
                Text("Machines")
            }
            if let f = row.fleet, !HypervisorWords.facts(f).isEmpty {
                Section("Details") {
                    ForEach(HypervisorWords.facts(f), id: \.self) { line in
                        Text(line).fleetType(.body).foregroundStyle(Design.Palette.ink)
                    }
                }
            }
            if row.proxmox, let own = row.fleet?.holder {
                // ITS OWN MACHINE (docs/proxmox.md): there, or the setup that
                // makes one. Unsaid by an older box, so nothing is drawn.
                Section {
                    switch own {
                    case let .there(name, running):
                        Text(HypervisorWords.ownThere(name, running: running)).fleetType(.body).foregroundStyle(running ? Design.Palette.ink : Design.Palette.attention)
                            .frame(minHeight: 44, alignment: .leading)
                        NavigationLink(HypervisorWords.makeOwnAgain) {
                            AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address), startOptions: ProxmoxOptions(holder: true, holderAgain: true))
                        }
                        .frame(minHeight: 44)
                    case .none:
                        Text(HypervisorWords.ownNone).fleetType(.body).foregroundStyle(Design.Palette.inkDim)
                        NavigationLink(HypervisorWords.makeOwn) {
                            AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address), startOptions: ProxmoxOptions(holder: true))
                        }
                        .frame(minHeight: 44)
                    }
                } header: {
                    Text(HypervisorWords.ownHeader)
                } footer: {
                    if case .there = own { Text(HypervisorWords.makeOwnAgainFooter) }
                }
            }
            if row.proxmox, let edge = row.fleet?.edge {
                // ITS EDGE ROUTER (docs/proxmox.md): there, or the setup that
                // makes one. Unsaid by an older box, so nothing is drawn.
                Section {
                    switch edge {
                    case let .there(running, blocks):
                        Text(HypervisorWords.edgeThere(running: running, blocks: blocks)).fleetType(.body).foregroundStyle(running ? Design.Palette.ink : Design.Palette.attention)
                            .frame(minHeight: 44, alignment: .leading)
                        NavigationLink(HypervisorWords.makeEdgeAgain) {
                            AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address), startOptions: ProxmoxOptions(edge: true, edgeBlock: blocks ? true : nil, edgeAgain: true))
                        }
                        .frame(minHeight: 44)
                    case .none:
                        Text(HypervisorWords.edgeNone).fleetType(.body).foregroundStyle(Design.Palette.inkDim)
                        NavigationLink(HypervisorWords.makeEdge) {
                            AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address), startOptions: ProxmoxOptions(edge: true))
                        }
                        .frame(minHeight: 44)
                    }
                } header: {
                    Text(HypervisorWords.edgeHeader)
                } footer: {
                    if case .there = edge { Text(HypervisorWords.makeEdgeAgainFooter) }
                }
            }
            if row.proxmox {
                Section {
                    // THE SAME SETUP, again: it finds what it made, keeps the
                    // image, and issues new access.
                    // THE FIREWALL, where it is off: the same setup, with the
                    // address filled in and the option already on.
                    if row.fleet?.fenced == false {
                        NavigationLink(HypervisorWords.turnOnFirewall) {
                            AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address), startOptions: ProxmoxOptions(firewall: true))
                        }
                        .frame(minHeight: 44)
                    }
                    NavigationLink("Set it up again") { AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(row.address)) }
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
/// network only the phone reaches. Both kinds are rows under the field the
/// whole time, so the page has the same shape whatever answers: the one that
/// did is marked and its setup opens with the address filled in; when nothing
/// answers as either, the line above the rows says so and the person picks.
struct AddHypervisorChoiceView: View {
    let settings: Settings

    @State private var address = ""
    @State private var finding = false
    /// What answered, which opens its setup.
    @State private var found: Found?
    /// What answered last, kept once the setup closes so its row still says so.
    @State private var marked: Found?
    /// Nothing answered as either: said above the rows.
    @State private var unknown: String?
    /// Machines too old to check for Proxmox VE, named once, quietly.
    @State private var note: String?

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
                    .onChange(of: address) { _, _ in
                        unknown = nil
                        note = nil
                    }
                    .frame(minHeight: 44)
                Button(finding ? "Checking…" : "Find it") { Task { await find() } }
                    .disabled(trimmed.isEmpty || finding)
                    .frame(minHeight: 44)
            } footer: {
                Text(HypervisorWords.findFooter)
            }
            Section {
                if let unknown {
                    Text(unknown).fleetType(.label).foregroundStyle(Design.Palette.attention)
                }
                if let note {
                    Text(note).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                NavigationLink { AddHypervisorView(settings: settings, startAt: trimmed) } label: {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text("Xen Orchestra").fleetType(.bodyStrong)
                        Text(HypervisorWords.xoChoice).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                        if marked == .xo(trimmed) {
                            Text(HypervisorWords.foundHere).fleetType(.label).foregroundStyle(Design.Palette.ok)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                NavigationLink { AddProxmoxView(settings: settings, startNode: HypervisorAddress.node(trimmed)) } label: {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text("Proxmox VE").fleetType(.bodyStrong)
                        Text(HypervisorWords.pveChoice).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                        if marked == .pve(HypervisorAddress.node(trimmed)) {
                            Text(HypervisorWords.foundHere).fleetType(.label).foregroundStyle(Design.Palette.ok)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
            } header: {
                Text("Which hypervisor is it")
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
        note = nil
        marked = nil
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
            // A MACHINE THAT NEVER LOOKED is named, in one quiet line under the
            // answer, rather than counted among the ones that found nothing.
            let didNotLook = probes.filter { $0.pveLooked != true && $0.through != "phone" }.map(\.hostId)
            unknown = HypervisorWords.notFound(at)
            note = didNotLook.isEmpty ? nil : HypervisorWords.needsUpdate(didNotLook)
        }
        marked = found
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
///
/// THREE LEVELS, from the copy review of 2026-11-06: a row says a verdict in
/// a word or three, a page says the result in a sentence and offers at most
/// one action, and the mechanism is not on this screen at all. §7 of
/// docs/psychology.md survives as a word: "cannot tell" is `Unknown` or
/// `Not checked`, never a sentence naming what did not answer, and never
/// "none".
enum HypervisorWords {
    static let none = "Add one. Machines that can reach it make machines on it for your sessions."
    static let fleetSilent = "Your fleet didn't answer. Only pools on this phone are shown."
    static let fleetSilentEmpty = "Your fleet didn't answer, and this phone has no pool of its own."
    static let noBox = "None yet"
    static let turnOnFirewall = "Turn on the datacenter firewall"
    static let againFooter = "Keeps what it made; the old access stops working."
    // ITS OWN MACHINE, the same words on Android (HypervisorsScreen.kt).
    static let ownHeader = "Its own machine"
    static let ownNone = "None. Your machines with its access manage it while they’re on."
    static let makeOwn = "Make its own machine"
    static let makeOwnAgain = "Make it again"
    static let makeOwnAgainFooter = "Replaces it with a fresh one. Its disk is erased."
    static let edgeHeader = "Its edge router"
    static let edgeNone = "None. Its machines are behind the cluster’s firewall alone."
    static let makeEdge = "Make the edge router"
    static let makeEdgeAgain = "Make it again"
    static let makeEdgeAgainFooter = "Builds a fresh one. Machines have no internet access while it starts."
    static func edgeThere(running: Bool, blocks: Bool) -> String {
        running ? (blocks ? "Running, dropping what its threat rules match" : "Running, logging what its threat rules match") : "Off. Setting it up again starts it."
    }
    static func ownThere(_ name: String, running: Bool) -> String { running ? "\(name), running" : "\(name), off. Setting it up again starts it." }
    static let xoElsewhere = "Its page opens on the phone that set it up."
    static let xoChoice = "A pool of XCP-ng hosts, through Xen Orchestra."
    static let pveChoice = "A Proxmox VE 9 node or cluster, set up over SSH."
    static let findFooter = "Fleetwright checks what answers there and opens the right setup."
    static let foundHere = "Found at this address"
    static let neverOpened = "Never opened"

    /// THE ROW'S ONE STATUS, from a fixed set. Trouble is the three that wear
    /// the attention colour (`wantsSomething`); the rest are calm.
    static let ready = "Ready"
    static let cantReach = "Can't reach"
    static let waiting = "Waiting for a machine"
    static let needsPve9 = "Needs Proxmox VE 9"
    static let checking = "Checking"
    static let unknown = "Unknown"

    /// When this phone last read a pool it holds, for the row.
    static func updated(_ when: String) -> String { "Updated \(when)" }

    /// Nothing answered as either kind: the one line above the two rows.
    static func notFound(_ address: String) -> String {
        "Couldn't tell what's at \(address). Pick one."
    }

    /// Some machines never checked for Proxmox VE: their Fleetwright is older
    /// than that check. Named once, quietly, under the answer.
    static func needsUpdate(_ machines: [String]) -> String {
        "\(machines.joined(separator: ", ")) \(machines.count == 1 ? "needs" : "need") an update to check for Proxmox VE."
    }

    /// One machine's word on the page: nil is "has not checked", never "no".
    static func reach(_ reachable: Bool?) -> String {
        switch reachable {
        case true?: return "Reached"
        case false?: return "Can't reach"
        case nil: return "Not checked"
        }
    }

    /// The row's status. `answered` is whether the fleet sent its list at
    /// all: a pool of this phone's the fleet did not list is waiting for a
    /// machine only when the fleet said so by leaving it out (§7).
    static func status(_ h: Fleet.Hypervisor?, onPhone: Bool, answered: Bool) -> String {
        guard let h else { return answered && onPhone ? waiting : unknown }
        if h.boxes.isEmpty { return waiting }
        if h.boxes.contains(where: { $0.reachable == true }) { return h.onProxmox && h.supported == false ? needsPve9 : ready }
        if h.boxes.contains(where: { $0.reachable == false }) { return cantReach }
        return checking
    }

    /// The page's one sentence: the same verdict as the row, and the one
    /// fact that makes it so.
    static func answer(_ h: Fleet.Hypervisor?) -> String {
        guard let h else { return "Unknown. Your fleet said nothing about it." }
        if h.boxes.isEmpty { return "Waiting for a machine to pick it up." }
        let reached = h.boxes.filter { $0.reachable == true }.map(\.hostId)
        if !reached.isEmpty {
            if h.onProxmox && h.supported == false { return "Needs Proxmox VE 9. No machine is made on it." }
            return "Ready. \(reached.joined(separator: ", ")) \(reached.count == 1 ? "makes" : "make") machines on it."
        }
        if h.boxes.contains(where: { $0.reachable == false }) { return "Can't reach it. No machine got through." }
        return "Checking. No machine has checked it yet."
    }

    /// Whether the row wears the attention ring: nothing of the fleet's can
    /// use it, or the cluster is too old. Checking is not trouble.
    static func wantsSomething(_ h: Fleet.Hypervisor?, onPhone: Bool) -> Bool {
        guard let h else { return !onPhone }
        if h.boxes.isEmpty { return true }
        if h.boxes.contains(where: { $0.reachable == true }) { return h.onProxmox && h.supported == false }
        return h.boxes.contains { $0.reachable == false }
    }

    /// The facts the machines could tell, each said only when known, each a
    /// short line. Whether the cluster is new enough is the headline's, not
    /// repeated here.
    static func facts(_ h: Fleet.Hypervisor) -> [String] {
        var lines: [String] = []
        if let v = h.version { lines.append(h.onProxmox ? "Proxmox VE \(v)" : "Version \(v)") }
        if let pools = h.pools, !pools.isEmpty { lines.append("\(h.onProxmox ? "Pool" : "Pools"): \(pools.joined(separator: ", "))") }
        if h.onProxmox {
            switch h.fenced {
            case true?: lines.append("Datacenter firewall on")
            case false?: lines.append("Datacenter firewall off: machines only on networks you chose")
            case nil: break
            }
        }
        if let n = h.images { lines.append(n == 1 ? "1 image" : "\(n) images") }
        if let n = h.machines { lines.append(n == 1 ? "1 machine made on it" : "\(n) machines made on it") }
        return lines
    }
}
