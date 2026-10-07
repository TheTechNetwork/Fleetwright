import SwiftUI

/// The Machines tab: every machine in the fleet, one card each, and a way to
/// add one.
///
/// WHAT THIS SCREEN IS FOR. Somebody opens it because a machine might be
/// unwell, often at night, often from a notification. It used to open on the
/// coordinator URL and a section called "Add a machine" holding the pin, the
/// runner repository, this phone's GitHub sign-in, the vault and runner
/// tokens, all permanently drawn, all above the list it was opened to read.
/// Setup lives under You now; this screen carries the list and one row.
///
/// The cards are facts only and every one is the same shape (RHYTHM 1). A
/// card that wears the attention ring is a machine that wants something. Tap
/// one for its page, where everything you can do about it lives.
struct MachinesView: View {
    let settings: Settings
    /// A machine somebody asked to see from elsewhere: a notification about
    /// it, or the reassurance line naming it. Pushed once the list has it.
    @Binding var opening: String?

    @State private var fleetHosts: [Fleet.FleetHost] = []
    @State private var hosts: [Fleet.Host] = []
    /// HAS THE FIRST ANSWER ARRIVED? Every list starts empty, and "No machines
    /// yet" before the fleet has replied is a confident statement about a
    /// question nobody has asked.
    @State private var loaded = false
    /// The machine whose page is showing.
    @State private var showing: String?
    /// The pools this phone holds a token for (XOSetupHandoff), read when
    /// the list is, not on every redraw: each is a Keychain read.
    @State private var hypervisors: [XOSetupHandoff.Held] = []
    /// The machines made on your pools, as the boxes holding them last saw.
    @State private var poolMachines: [Fleet.VMMachine] = []
    /// The images a machine can come from, for keeping some ready.
    @State private var poolImages: [Fleet.VMImage] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Enrolled, and not saying anything: membership with no report.
    private var silent: [Fleet.Host] {
        hosts.filter { h in !fleetHosts.contains { $0.hostId == h.hostId } }
    }

    var body: some View {
        List {
            if !settings.configured {
                ContentUnavailableView {
                    Label("Not signed in", systemImage: "server.rack")
                } description: {
                    Text("Sign in to a fleet under You, and its machines are listed here.")
                }
                .fleetRow()
            } else if !loaded {
                Text("Asking the fleet…")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetRow()
            } else if fleetHosts.isEmpty && hosts.isEmpty {
                ContentUnavailableView {
                    Label("No machines yet", systemImage: "server.rack")
                } description: {
                    Text("A machine joins with a pin from Add a machine and one line typed on it.")
                }
                .fleetRow()
            }

            ForEach(fleetHosts) { host in
                Button { showing = host.hostId } label: { reportingCard(host) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens its page")
                    .fleetRow()
            }

            // THE MACHINES THAT ARE NOT SAYING ANYTHING. A box that has gone
            // quiet is still enrolled, the coordinator still holds its key, and
            // that key is exactly what a reinstalled box is refused for — so it
            // needs a page, to be re-keyed or removed. A card of the same shape,
            // on purpose: the ring and the words "not reporting" already say it
            // is different.
            ForEach(silent) { host in
                Button { showing = host.hostId } label: { silentCard(host) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens its page")
                    .fleetRow()
            }

            // THE MACHINES ON YOUR HYPERVISOR, each a way to its page: its
            // console, SSH, a restart, longer, a new size. Asked for: "Vm
            // console, settings, reboot, ssh". Drawn only when there is one.
            if !poolMachines.isEmpty {
                poolMachineRows
            }
            // MACHINES KEPT READY, so a session starts in seconds. Asked for:
            // "standby vms to speed up session starts". Offered wherever an
            // image is, and only then.
            if !poolImages.isEmpty {
                NavigationLink {
                    VMStandbyView(settings: settings, images: poolImages)
                } label: {
                    Label("Keep machines ready", systemImage: "bolt.horizontal")
                        .fleetType(.body)
                        .frame(minHeight: 44)
                }
                .fleetCard(radius: Design.Radius.cardSmall)
                .fleetRow()
            }

            if settings.configured {
                // ONE ROW, AFTER THE LIST. Adding a machine is something done
                // once per machine; the list is read every time.
                NavigationLink {
                    AddMachineView(settings: settings)
                } label: {
                    Label("Add a machine", systemImage: "plus")
                        .fleetType(.body)
                        .frame(minHeight: 44)
                }
                .fleetCard(radius: Design.Radius.cardSmall)
                .fleetRow()
            }

            // A POOL OF VIRTUAL MACHINES, for the one person who can add one:
            // onboarding makes a user and a token on the hypervisor, which is
            // the fleet's business and not a member's. Drawn only for a known
            // admin (nil is cannot tell and draws nothing), and the row is the
            // same shape as the one above it, because it is the same kind of
            // thing: a way in, read once. The stacked squares are the mark
            // the Dynamic Island uses for the same job, so the two agree.
            if settings.configured && settings.showsAdmin {
                NavigationLink {
                    AddHypervisorView(settings: settings)
                } label: {
                    Label("Add a hypervisor", systemImage: "square.stack.3d.up")
                        .fleetType(.body)
                        .frame(minHeight: 44)
                }
                .fleetCard(radius: Design.Radius.cardSmall)
                .fleetRow()
            }

            // THE POOLS THIS PHONE HOLDS, each a way to its page: what is on
            // it and what can be done there, phone-direct with the token
            // setup handed back (PoolManageView, docs/manage.md), and the
            // change to what the fleet may use. Behind the same gate as Add a
            // hypervisor, for the same reason, and drawn only when there is
            // one: a heading over nothing is a screen promising something it
            // does not have. The rows are cards of the one shape (RHYTHM 1):
            // the address at the weight a hostname gets, what the record says
            // the pools are called, and when this phone last looked.
            // A method rather than more of this body, for the reason
            // healthLines gives.
            if settings.configured && settings.showsAdmin && !hypervisors.isEmpty {
                hypervisorRows
            }
        }
        .listStyle(.plain)
        .listRowSpacing(Design.Space.groupTight)
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle("Machines")
        .refreshable { await loadHosts() }
        .task(id: "\(settings.credential)|\(settings.viewAsMember)") { await loadHosts() }
        .onChange(of: opening) { _, _ in openAsked() }
        .navigationDestination(item: $showing) { id in hostPage(id) }
        // Back from adding one, the new pool is listed.
        .onAppear { hypervisors = XOSetupHandoff.heldPools() }
    }

    @ViewBuilder private var poolMachineRows: some View {
        Text("On your hypervisor")
            .fleetType(.section)
            .foregroundStyle(Design.Palette.ink)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, Design.Space.insideTight)
            .fleetRow()
        ForEach(poolMachines) { machine in
            NavigationLink {
                VMMachineView(settings: settings, name: machine.name)
            } label: {
                poolMachineCard(machine)
            }
            .fleetCard(radius: Design.Radius.cardSmall)
            .fleetRow()
        }
    }

    private func poolMachineCard(_ m: Fleet.VMMachine) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(m.name)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                Text(vmStateWords(m.state))
                    .fleetType(.label)
                    .foregroundStyle(m.state == "Running" ? Design.Palette.ok : Design.Palette.attention)
            }
            Text([m.standby == true ? "kept ready" : m.image, m.ip, m.until.map { "ends \(relativeTime($0))" }].compactMap { $0 }.joined(separator: " · "))
                .fleetType(.micro)
                .foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var hypervisorRows: some View {
        Text("Hypervisors")
            .fleetType(.section)
            .foregroundStyle(Design.Palette.ink)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, Design.Space.insideTight)
            .fleetRow()
        ForEach(hypervisors) { pool in
            NavigationLink {
                PoolManageView(settings: settings, pool: pool)
            } label: {
                hypervisorRow(pool)
            }
            .fleetCard(radius: Design.Radius.cardSmall)
            .fleetRow()
        }
    }

    private func hypervisorRow(_ pool: XOSetupHandoff.Held) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(pool.address)
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
            // Nil is a record that did not say, and is said as that.
            Text(pool.pools.map { $0.isEmpty ? "Its record lists no pools" : $0.joined(separator: ", ") }
                 ?? "Pool names not recorded")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            // HOW CURRENT ITS PAGE WILL BE: nothing watches a pool while the
            // app is closed, so the row says when this phone last looked
            // rather than letting the page's first frame pass for now.
            Text(Manage.lastLooked(pool.address).map { Manage.Words.rowLooked(relativeTime($0.timeIntervalSince1970 * 1000)) }
                 ?? Manage.Words.never)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens its page")
    }

    /// Push the page somebody asked for from elsewhere, once this list knows
    /// the machine. A name it does not know is simply not opened: the list is
    /// there, and the notification may be about a box that has since gone.
    private func openAsked() {
        guard let wanted = opening else { return }
        if fleetHosts.contains(where: { $0.hostId == wanted }) || hosts.contains(where: { $0.hostId == wanted }) {
            showing = wanted
            opening = nil
        } else if loaded {
            opening = nil
        }
    }

    @ViewBuilder private func hostPage(_ id: String) -> some View {
        let reporting = fleetHosts.first { $0.hostId == id }
        let member = hosts.first { $0.hostId == id }
        // Nil health for a silent machine, not a guess: the page shows what a
        // box reports, and this one reports nothing. Its membership record is
        // what there is, and it is what Replace key and Revoke act on.
        HostView(
            settings: settings,
            hostId: id,
            initialHealth: reporting?.health,
            initialState: reporting?.state ?? (member?.isRevoked == true ? "revoked" : "not reporting"),
            initialReason: reporting?.reason ?? (member?.isRevoked == true
                ? "Its key was revoked. Readmit mints the pin that brings it back."
                : "Not connected to the fleet. Reinstalled? Replace key mints the pin its new key needs."),
            enrolled: member,
            onChange: { await loadHosts() },
        )
    }

    private func reportingCard(_ host: Fleet.FleetHost) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                // A hostname is compared character by character against a
                // terminal, at the weight a headline gets.
                Text(host.hostId)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Image(systemName: "chevron.right")
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                // Colour reinforces the word; it never carries the meaning alone.
                Text(host.state ?? "unknown")
                    .fleetType(.label)
                    .foregroundStyle(host.state == "healthy" ? Design.Palette.ok : Design.Palette.attention)
            }
            // ONLY WHEN IT IS NEWS. "reporting normally" under "healthy" is the
            // same fact twice.
            if let reason = host.reason, !reason.isEmpty, (host.state ?? "") != "healthy" {
                Text(reason).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            healthLines(for: host)
        }
        .contentShape(Rectangle())
        .fleetCard(radius: Design.Radius.cardSmall, ring: hostRing(host))
        .accessibilityElement(children: .combine)
    }

    private func silentCard(_ host: Fleet.Host) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(host.hostId)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Image(systemName: "chevron.right")
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                Text(host.isRevoked ? "revoked" : "not reporting")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
            }
            Text(absence(host))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
        .contentShape(Rectangle())
        .fleetCard(radius: Design.Radius.cardSmall, ring: Design.Palette.attention.opacity(0.55))
        .accessibilityElement(children: .combine)
    }

    /// What this box says about itself, as lines. A method rather than more of
    /// the card's body: the Swift type checker gives up on a body this size,
    /// and only on CI.
    @ViewBuilder
    private func healthLines(for host: Fleet.FleetHost) -> some View {
        // WHO CAN START A SESSION HERE, and as whom. Zero is the real fault and
        // the only thing worth colouring; nil is an older host and says nothing.
        if let accounts = host.health?.claudeAccounts {
            let auth = host.health?.runnerAuth
            let runner = host.ephemeral == true
            Text(describeWhoCanStart(accounts, account: host.health?.account, runnerAuth: auth, runner: runner))
                .fleetType(.micro)
                .foregroundStyle(whoCanStartIsFault(accounts, runnerAuth: auth, runner: runner)
                                 ? Design.Palette.attention : Design.Palette.inkDim)
        }
        // THE SECOND WAY TO BE SIGNED OUT: the credential file a session is
        // actually handed. Shown only when it is DEAD; an expired token that
        // can renew itself is the ordinary state of a box nobody has touched.
        if let credential = host.health?.credential, credential.isDead {
            Text(credential.summary ?? "Sessions started here will come up signed out.")
                .fleetType(.micro).foregroundStyle(Design.Palette.bad)
        }
        // Version, what it is behind, and which releases it takes: one line,
        // in the order somebody asks.
        Text(describeRunning(host))
            .fleetType(.micro)
            .foregroundStyle(host.updatePending ? Design.Palette.attention : Design.Palette.inkDim)
        if let system = host.health?.updates?.system, !system.isEmpty {
            Text("OS: \(system)").fleetType(.micro).foregroundStyle(Design.Palette.attention)
        }
        if host.health?.updates?.rebootRequired == true {
            Text("reboot required").fleetType(.micro).foregroundStyle(Design.Palette.attention)
        }
    }

    /// A machine that wants something wears the attention ring: not healthy,
    /// an update waiting, or nobody able to start a session on it. Calm
    /// recedes, trouble comes forward.
    private func hostRing(_ host: Fleet.FleetHost) -> Color {
        let unwell = (host.state ?? "unknown") != "healthy"
        let waiting = host.updatePending
        let unusable = whoCanStartIsFault(host.health?.claudeAccounts ?? 1, runnerAuth: host.health?.runnerAuth,
                                          runner: host.ephemeral == true)
        return unwell || waiting || unusable ? Design.Palette.attention.opacity(0.55) : Design.Palette.ring
    }

    /// "never connected" is a different fact from "last seen a while ago": one
    /// is a box that enrolled and never came up, the other one that went away.
    private func absence(_ host: Fleet.Host) -> String {
        if let seen = host.lastSeenAt, seen > 0 { return "last seen \(relativeTime(seen))" }
        return "never connected"
    }

    @MainActor
    private func loadHosts() async {
        guard settings.configured else { return }
        hypervisors = XOSetupHandoff.heldPools()
        // TWO ANSWERS, ONE WAIT: the cost is the slower of them, not the sum.
        // Enrolled is the membership (keys, revocation); reporting is what
        // each machine is saying now. Different questions.
        let fleet = Fleet(settings: settings)
        async let reporting = fleet.fleetHosts()
        async let enrolled = fleet.enrolledHosts()
        async let onPools = fleet.vmMachines()
        async let images = fleet.vmImages()
        // A FAILED REQUEST IS NOT AN EMPTY FLEET. A list that was right ten
        // seconds ago is a better answer than nothing, and the next refresh
        // corrects it.
        // A machine that stops reporting moves to the silent cards below, and
        // one that joins arrives, rather than the list becoming another list.
        let gotReporting = try? await reporting
        let gotEnrolled = try? await enrolled
        let gotPools = try? await onPools
        let gotImages = try? await images
        withAnimation(Design.Motion.settle(reduceMotion)) {
            if let got = gotReporting { fleetHosts = got }
            if let got = gotEnrolled { hosts = got }
            if let got = gotPools { poolMachines = got }
            if let got = gotImages { poolImages = got }
        }
        loaded = true
        openAsked()
    }
}

/// Milliseconds since the epoch, as words: "2 hours ago".
func relativeTime(_ at: Double) -> String {
    let date = Date(timeIntervalSince1970: at / 1000)
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .full
    return f.localizedString(for: date, relativeTo: Date())
}
