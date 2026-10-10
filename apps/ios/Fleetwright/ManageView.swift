import SwiftUI

/// A pool this phone holds a token for, managed from here: its pools, hosts,
/// VMs and storage, each the same kind of row, and each a way to its page.
/// docs/manage.md, "The first slice".
///
/// WHERE IT IS. Machines → Hypervisors → the pool. That row was already the
/// pool's way in (it opened the policy), and a pool is a machine of a kind:
/// putting what is on it under the same tab, as one more page under the row
/// that names it, reads as part of Machines rather than as an app of its own.
/// Changing what the fleet may use there is a row on this page now, for an
/// admin, beside what it governs.
///
/// THE ROWS ARE THE MACHINES TAB'S ROWS: a card of the one shape (RHYTHM 1),
/// the name at a hostname's weight, the state word on the right in a tone that
/// only agrees with it, then what it is and the numbers behind how it is. No
/// row wears a ring: nothing here is asking anything, and the ring is spent on
/// the card that is (docs/design-system.md, "One card at a time wears a tone").
///
/// THE FIRST LINE SAYS HOW CURRENT IT IS. Watching now while the socket is
/// open, and otherwise when it was last looked at, because nothing watches a
/// phone-direct pool while the app is closed (PoolWatch).
///
/// MOTION: a row arriving, leaving or moving settles on the spring, and a
/// state word that changes crossfades, which is all that moves (MOTION 2).
/// Under Reduce Motion the row is simply in its new place.
struct PoolManageView: View {
    let settings: Settings
    let pool: XOSetupHandoff.Held

    @State private var watch: PoolWatch
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    init(settings: Settings, pool: XOSetupHandoff.Held) {
        self.settings = settings
        self.pool = pool
        _watch = State(initialValue: PoolWatch(address: pool.address, fleet: Fleet(settings: settings)))
    }

    var body: some View {
        List {
            statusCard
                .fleetRow()
            if watch.phase == .live && watch.snapshot.isEmpty {
                Text(Manage.Words.seesNothing)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetRow()
            }
            ForEach(Manage.Kind.allCases, id: \.self) { kind in
                section(kind)
            }
            // AN ADMIN'S, as it was on Machines: changing the policy takes an
            // admin sign-in and the verb refuses a member.
            if settings.showsAdmin {
                NavigationLink {
                    AddHypervisorView(settings: settings, policyFor: pool.address)
                } label: {
                    Label(Manage.Words.changePolicy, systemImage: "slider.horizontal.3")
                        .fleetType(.body)
                        .frame(minHeight: 44)
                }
                .fleetCard(radius: Design.Radius.cardSmall)
                .fleetRow()
            }
        }
        .listStyle(.plain)
        .listRowSpacing(Design.Space.groupTight)
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(pool.address)
        .animation(Design.Motion.settle(reduceMotion), value: watch.revision)
        .refreshable { await watch.again() }
        .task { await watch.start() }
        // THE APP LEAVING IS THE SOCKET CLOSING, said as such, rather than a
        // connection the system cuts later and the screen reports as lost.
        .onChange(of: scenePhase) { _, now in
            if now == .background {
                watch.stop()
            } else if now == .active {
                Task { await watch.start() }
            }
        }
    }

    // MARK: How current it is

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text(statusLine)
                .fleetType(.body)
                .foregroundStyle(statusTone)
                .contentTransition(.opacity)
                .animation(Design.Motion.change, value: statusLine)
            if case .stopped = watch.phase {
                Text(watch.lookedLine)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if let user = watch.user {
                Text(Manage.Words.limitedUser(user))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if canLookAgain {
                Button(Manage.Words.lookAgain) { Task { await watch.start() } }
                    .fleetType(.body)
                    .frame(minHeight: 44)
            }
        }
        .fleetCard(radius: Design.Radius.cardSmall)
    }

    private var statusLine: String {
        switch watch.phase {
        case .live: return watch.currentLine
        case .connecting: return Manage.Words.connecting(pool.address)
        case .relaying: return Manage.Words.askingFleet(pool.address)
        case let .stopped(why, _): return why
        case .idle: return watch.lookedLine
        }
    }

    /// A stop is the one state here that wants something of the person.
    private var statusTone: Color {
        if case .stopped = watch.phase { return Design.Palette.attention }
        return Design.Palette.ink
    }

    /// Only where looking again could change the answer (C-2).
    private var canLookAgain: Bool {
        switch watch.phase {
        case .idle: return true
        case let .stopped(_, retry): return retry
        case .live, .connecting, .relaying: return false
        }
    }

    // MARK: The rows

    /// A kind, under its heading, drawn only when there is one: a heading
    /// over nothing promises what the pool does not have.
    @ViewBuilder
    private func section(_ kind: Manage.Kind) -> some View {
        let rows = watch.snapshot.list(kind)
        if !rows.isEmpty {
            Text(Manage.Words.heading(kind))
                .fleetType(.section)
                .foregroundStyle(Design.Palette.ink)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, Design.Space.insideTight)
                .fleetRow()
            ForEach(rows) { c in
                NavigationLink {
                    ComponentView(watch: watch, id: c.id)
                } label: {
                    row(c)
                }
                .fleetCard(radius: Design.Radius.cardSmall)
                .fleetRow()
            }
        }
    }

    private func row(_ c: Manage.Component) -> some View {
        let s = watch.snapshot
        return VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(c.name)
                    .fleetType(.bodyStrong)
                    .foregroundStyle(Design.Palette.ink)
                Spacer(minLength: 0)
                if let word = Manage.stateWords(c) {
                    Text(word)
                        .fleetType(.label)
                        .foregroundStyle(manageTone(c.state))
                        .contentTransition(.opacity)
                        .animation(Design.Motion.change, value: word)
                }
            }
            Text(Manage.what(c, in: s))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            Text(Manage.numbers(c, in: s))
                .fleetType(.micro)
                .foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens its page")
    }
}

/// The tone a state word is set in. It agrees with the word and never carries
/// it: running is well, maintenance mode is something somebody chose and
/// should not forget, stopped is quiet, and not knowing is its own colour.
/// Not `idle` for stopped: as text on a card it does not clear AA.
func manageTone(_ state: Manage.State?) -> Color {
    switch state {
    case .running?: return Design.Palette.ok
    case .maintenance?: return Design.Palette.attention
    case nil: return Design.Palette.unsure
    case .stopped?, .suspended?, .paused?: return Design.Palette.inkDim
    }
}

/// One component's page: what it is, how it is, and what it can do, in that
/// order, the same three parts every row has. A `Form`, restyled in place like
/// a machine's page (docs/design-system.md §4): it is a list of facts and
/// controls, and the platform's list is a good one.
///
/// WHAT IT CAN DO IS WHAT THE SERVER LISTS (C-2), in the order Manage.offered
/// gives, and each is confirmed by what it costs to undo: one tap, a question
/// naming what it interrupts, or the name typed back.
struct ComponentView: View {
    let watch: PoolWatch
    let id: String

    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var asking: Asking?
    @State private var typing: Asking?
    @State private var cpus = 1
    @State private var memoryGiB = 1
    /// What each disk is to grow to, by its id, once a person has moved it.
    @State private var growTo: [String: Int] = [:]
    @State private var sized = false

    /// What is waiting on a yes.
    private struct Asking: Identifiable {
        let id = UUID()
        let title: String
        let name: String
        let button: String
        let run: Run
    }

    private enum Run {
        case action(Manage.Action)
        case resize(Int, Int)
        case grow(Manage.Disk, Int)
    }

    var body: some View {
        Form {
            if let c = watch.snapshot.components[id] {
                whatSection(c)
                howSection(c)
                doSection(c)
            } else {
                Text(Manage.Words.gone)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(watch.snapshot.components[id]?.name ?? "")
        .task(id: id) { takeSize() }
        .confirmationDialog(asking?.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible, presenting: asking) { ask in
            Button(ask.button) { Task { await perform(ask.run) } }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $typing) { ask in
            TypedConfirm(title: ask.title, name: ask.name, button: ask.button) {
                Task { await perform(ask.run) }
            }
        }
    }

    // MARK: What it is

    @ViewBuilder
    private func whatSection(_ c: Manage.Component) -> some View {
        Section {
            fact("Kind", Manage.Words.kindTitle(c.kind))
            fact("Where", Manage.what(c, in: watch.snapshot))
            if c.kind == .vm || c.kind == .host {
                fact("Address", c.address ?? "cannot tell")
            }
        } header: {
            sectionHead(Manage.Words.whatItIs)
        }
    }

    // MARK: How it is

    @ViewBuilder
    private func howSection(_ c: Manage.Component) -> some View {
        Section {
            if let word = Manage.stateWords(c) {
                fact("State", word, tone: manageTone(c.state))
            }
            Text(Manage.numbers(c, in: watch.snapshot))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .frame(minHeight: 44, alignment: .leading)
            if c.kind == .vm {
                ForEach(watch.snapshot.attachedDisks(c.id)) { d in
                    fact(d.name, Manage.diskLine(d, in: watch.snapshot))
                }
            }
        } header: {
            sectionHead(Manage.Words.howItIs)
        } footer: {
            Text(watch.currentLine)
        }
    }

    // MARK: What it can do

    @ViewBuilder
    private func doSection(_ c: Manage.Component) -> some View {
        let methods = watch.methods
        let offered = Manage.offered(c, methods: methods)
        let resize = Manage.canResize(c, methods: methods)
        let needsStopped = Manage.resizeNeedsStopped(c, methods: methods)
        let grow = Manage.growMethod(c, methods: methods)
        let disks = grow == nil ? [] : watch.snapshot.attachedDisks(c.id).filter { $0.size != nil }
        Section {
            if watch.phase != .live {
                note(Manage.Words.lost("this phone is not connected"))
            } else if methods == nil {
                note(Manage.Words.methodsUnknown)
            } else if offered.isEmpty && !resize && !needsStopped && disks.isEmpty {
                note(Manage.Words.nothingOffered)
            } else {
                ForEach(offered) { a in
                    Button(a.label, role: a.cost == .destructive ? ButtonRole.destructive : nil) { tap(a, c) }
                        .disabled(busy)
                        .frame(minHeight: 44)
                }
                if resize {
                    resizeRows(c)
                } else if needsStopped {
                    note(Manage.Words.tuneNeedsStopped)
                }
                ForEach(disks) { d in
                    growRow(d)
                }
            }
            if !message.isBlank {
                Text(message)
                    .fleetType(.label)
                    .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                    .textSelection(.enabled)
            }
        } header: {
            sectionHead(Manage.Words.whatItCanDo)
        } footer: {
            if !offered.isEmpty || resize || !disks.isEmpty {
                Text(disks.isEmpty ? Manage.Words.actionsFooter : "\(Manage.Words.actionsFooter) \(Manage.Words.growNote)")
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .fleetType(.label)
            .foregroundStyle(Design.Palette.inkDim)
    }

    /// vCPUs and memory, for a stopped VM. One tap: a size can be set back.
    @ViewBuilder
    private func resizeRows(_ c: Manage.Component) -> some View {
        Stepper("\(cpus) vCPU\(cpus == 1 ? "" : "s")", value: $cpus, in: 1...64)
            .disabled(busy)
            .frame(minHeight: 44)
        Stepper("\(memoryGiB) GiB of memory", value: $memoryGiB, in: 1...512)
            .disabled(busy)
            .frame(minHeight: 44)
        Button(Manage.Words.resizeButton(cpus: cpus, memoryGiB: memoryGiB)) {
            Task { await perform(.resize(cpus, memoryGiB)) }
        }
        .disabled(busy || unchanged(c))
        .frame(minHeight: 44)
    }

    /// A disk's size, to grow from where it is: a disk is never shrunk here,
    /// so the stepper starts one GiB above it.
    @ViewBuilder
    private func growRow(_ d: Manage.Disk) -> some View {
        let least = smallestGrowth(d)
        let to = Binding(get: { max(growTo[d.id] ?? least, least) }, set: { growTo[d.id] = $0 })
        Stepper("\(d.name): \(to.wrappedValue) GiB", value: to, in: least...max(least, 16_384))
            .disabled(busy)
            .frame(minHeight: 44)
        Button(Manage.Words.growButton(d.name, toGiB: to.wrappedValue)) {
            let ask = Manage.growConfirmation(d, toGiB: to.wrappedValue)
            if case let .ask(title, button) = ask {
                asking = Asking(title: title, name: d.name, button: button, run: .grow(d, to.wrappedValue))
            }
        }
        .disabled(busy)
        .frame(minHeight: 44)
    }

    private func smallestGrowth(_ d: Manage.Disk) -> Int {
        let bytes = d.size ?? 0
        return Int((bytes + Manage.gib - 1) / Manage.gib) + 1
    }

    private func unchanged(_ c: Manage.Component) -> Bool {
        cpus == c.cpus && Int64(memoryGiB) * Manage.gib == c.memory
    }

    /// The size steppers start from what the VM has, once.
    private func takeSize() {
        guard !sized, let c = watch.snapshot.components[id] else { return }
        sized = true
        if let n = c.cpus { cpus = max(1, n) }
        if let bytes = c.memory { memoryGiB = max(1, Int((Double(bytes) / Double(Manage.gib)).rounded())) }
    }

    // MARK: Asking and doing

    /// One tap, a question, or the name typed back, by what it costs.
    private func tap(_ a: Manage.Action, _ c: Manage.Component) {
        switch Manage.confirmation(a, for: c, in: watch.snapshot) {
        case .none:
            Task { await perform(.action(a)) }
        case let .ask(title, button):
            asking = Asking(title: title, name: c.name, button: button, run: .action(a))
        case let .typeName(title, name, button):
            typing = Asking(title: title, name: name, button: button, run: .action(a))
        }
    }

    @MainActor
    private func perform(_ run: Run) async {
        guard let c = watch.snapshot.components[id] else { return }
        busy = true
        defer { busy = false }
        message = ""
        let result: (ok: Bool, text: String)
        switch run {
        case let .action(a):
            result = await watch.run(a.method, Manage.params(a, for: c, now: Date()), done: Manage.done(a, for: c))
        case let .resize(n, gib):
            result = await watch.run("vm.set", Manage.resizeParams(c, cpus: n, memoryGiB: gib),
                                     done: Manage.resized(c, cpus: n, memoryGiB: gib))
        case let .grow(d, gib):
            guard let method = Manage.growMethod(c, methods: watch.methods) else { return }
            result = await watch.run(method, Manage.growParams(d, toGiB: gib), done: Manage.grown(d, toGiB: gib))
        }
        failed = !result.ok
        message = result.text
    }

    // MARK: Words

    private func fact(_ label: String, _ value: String, tone: Color = Design.Palette.ink) -> some View {
        LabeledContent {
            Text(value).fleetType(.label).foregroundStyle(tone).multilineTextAlignment(.trailing)
        } label: {
            Text(label).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
        }
        .frame(minHeight: 44)
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
    }
}

/// A destructive action, asked as its name typed back: forcing a VM off or to
/// restart, or deleting one. In a list of many VMs the wrong one is the mistake
/// worth preventing, and typing the name is what makes it impossible. The
/// button stays off until the name matches.
struct TypedConfirm: View {
    let title: String
    let name: String
    let button: String
    let onConfirm: () -> Void

    @State private var typed = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(title)
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                    TextField(name, text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(minHeight: 44)
                } footer: {
                    Text(Manage.Words.typePrompt(name))
                }
                Section {
                    Button(button, role: .destructive) {
                        onConfirm()
                        dismiss()
                    }
                    .disabled(typed.trimmingCharacters(in: .whitespaces) != name)
                    .frame(minHeight: 44)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Design.Palette.bg)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
