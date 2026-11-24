import SwiftUI

/// Routing: which member a task with no member goes to (docs/routing.md).
///
/// A task somebody gave to a member is that member's. For one given to
/// nobody, the fleet can work it out in a fixed order: the owner's rule for
/// that kind of work, then the only member who takes it, then a pick among
/// several, by the fleet's model or by a person on their phone. It writes
/// down how it decided, and that record is what these screens say.
///
/// THE SENTENCES ARE THE FLEET'S OWN. A decision is said here exactly as
/// `routeWords` says it in src/fleet/protocol/routing.js, head for head, so
/// a person reads one sentence on the phone, in a notification and in a
/// terminal. test/routing-in-apps.test.js imports that file and compares,
/// and reads Android (Routing.kt) for the same words.
///
/// THE PHONE DECIDES NOTHING. It shows the record, sends an admin's
/// setting, asks for a task to be routed, and sends a person's answer to
/// "which member". Who may be chosen, and whether a choice is allowed, are
/// the fleet's to say, and a refusal is shown in the fleet's own sentence.

/// The three modes, in the order they are offered: off first, because it is
/// what a fleet is until an admin says otherwise.
let routingModes = ["off", "manual", "auto"]

/// A mode's name as a choice. One this build has never met is shown as the
/// fleet sent it (C-5).
func routingModeName(_ mode: String) -> String {
    switch mode {
    case "off": return "Off"
    case "manual": return "Ask me"
    case "auto": return "Choose for me"
    default: return mode
    }
}

/// The one line under a mode on the fleet's own setting, where "below" is
/// the list of rules on the same page.
func routingModeLine(_ mode: String) -> String {
    switch mode {
    case "off": return "A task with no member stays with nobody."
    case "manual": return "The rules below place a task. When several members could take it, whoever asked chooses."
    case "auto": return "The same, and the fleet’s model picks among several."
    default: return ""
    }
}

/// Under "Choose for me" on a fleet whose model is not on. The choice stays
/// a choice: the fleet accepts it, and asks a person until its operator
/// turns the model on.
let routingNoModelLine = "This fleet has no model turned on, so a person is asked. Its operator turns the model on."

/// What routing never does, said on the setting whoever is reading it.
let routingAlwaysLine = "A task somebody was given is never moved. Routing chooses only among members the person asking could have assigned by hand."

/// A task's own choice that names no mode: it follows the fleet's setting.
let routingAsFleet = "As your fleet is set"

/// The assignee choice that is not a member and not Nobody. Never a
/// member's id, which is a slug with no colon in it.
let taskFleetChooses = "fleet:chooses"

/// How a decision was reached, as the head of its sentence: the fleet's
/// `HOW_WORDS`, word for word. A way of deciding this build has never met
/// is shown as itself, and no words are made up for it (C-5).
func routeHead(_ how: String?) -> String {
    switch how ?? "" {
    case "pinned": return "Given to its member by hand"
    case "rule": return "Routed by the fleet’s rule"
    case "only": return "Routed to the only member who takes it"
    case "model": return "Routed by the fleet’s model"
    case "person": return "Chosen by a person"
    case "waiting": return "Waiting for a person to choose"
    case "nobody": return "No member takes this kind of work"
    default: return how ?? ""
    }
}

/// A decision as the sentences a person reads on a task: the head, the
/// member it chose after a colon, why, and while it waits, whom to choose
/// among. Members are named where the organization names them and shown by
/// id where it does not.
func routeWords(_ route: Fleet.OrgTask.Route, _ roster: [Fleet.Member]) -> String {
    let chose = taskMemberName(route.member, roster).map { ": " + $0 } ?? ""
    let listed = (route.candidates ?? []).map { taskMemberName($0, roster) ?? $0 }
    var among = ""
    if route.how == "waiting", !listed.isEmpty {
        let more = route.more ?? 0
        among = " Choose among " + listed.joined(separator: ", ") + (more > 0 ? " and \(more) more" : "") + "."
    }
    return "\(routeHead(route.how))\(chose). \(route.why ?? "")\(among)".trimmingCharacters(in: .whitespaces)
}

/// One routing decision in a task's history: the same head, and whom it
/// chose when it chose somebody. Who asked and when are the line under it.
func routedHandoffWords(how: String?, to: String?) -> String {
    guard let to, !to.isEmpty else { return routeHead(how) }
    return "\(routeHead(how)): \(to)"
}

/// Whether a task is waiting on a person to say which member it goes to:
/// the fleet's last decision was to ask, and nobody has it yet.
func taskWaitsForMember(_ task: Fleet.OrgTask) -> Bool {
    task.state == "open" && task.route?.how == "waiting" && (task.assignee ?? "").isEmpty
}

/// Whether a task is asking somebody something: it came back with a result
/// to judge, or it waits for a member to be chosen. These are the rows that
/// come forward in the list, and the only ones that take the attention colour.
func taskAsks(_ task: Fleet.OrgTask) -> Bool {
    task.state == "returned" || taskWaitsForMember(task)
}

/// Who last set the fleet's routing, and when the fleet said when.
func routingSetLine(by: String, at: String?) -> String {
    guard let at else { return "Last set by \(by)" }
    return "Last set by \(by), \(at)"
}

/// The fleet's routing: the mode in three plain choices, and the rules by
/// kind of work. Reached from Organization.
///
/// EVERYBODY READS IT AND AN ADMIN EDITS IT. Whether this person is an admin
/// is the fleet's answer (`you.admin`), and every control here is drawn from
/// that answer and nothing else (C-2). Somebody who is not one sees the same
/// page, with the mode marked and the rules listed, no control, and one line
/// saying who sets it.
///
/// NOTHING IS SENT UNTIL Save, AND THEN ALL OF IT. The fleet replaces its
/// list of rules with the one it is given, so the page keeps a draft and
/// sends the mode and the whole list together. A draft that differs from
/// what the fleet has says so. What the fleet refuses, it says why: a second
/// rule for one kind of work is its refusal to make, in its own sentence,
/// and the draft stays as it was so the rule can be taken out.
///
/// FOUR STATES: loading, could not load, loaded, and a fleet that answered
/// with no routing record and no sentence, which is one from before routing.
struct RoutingView: View {
    let settings: Settings
    /// Everybody, for the name of the member a rule goes to and for whom a
    /// new rule may name. The Organization behind this page loaded them.
    let members: [Fleet.Member]

    private enum Load { case asking, answered, absent, failed(String) }
    @State private var load = Load.asking
    /// The record as the fleet last sent it. The draft is held against it.
    @State private var saved: Fleet.Routing?
    /// Whether a pick among several can be the fleet's model's.
    @State private var modelOn = false
    @State private var isAdmin = false
    /// The draft: what Save would send.
    @State private var mode = "off"
    @State private var rules: [Fleet.Routing.Rule] = []
    @State private var newKind = ""
    @State private var newMember = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    /// Whether the draft differs from what the fleet has.
    private var changed: Bool {
        mode != (saved?.mode ?? "off") || rules != (saved?.rules ?? [])
    }

    var body: some View {
        Form {
            switch load {
            case .asking:
                Section {
                    Text("Loading…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            case .failed(let why):
                // The result, then the reason smaller under it, as the
                // Organization says it: the reason is there to be copied.
                Section {
                    Text("Could not load the routing.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            case .absent:
                // NOT A FAILURE, AND NOT "OFF". The fleet answered, with no
                // routing record and nothing to say about it, which is what
                // one from before routing does. Said as that, in the calm
                // colour, with no mode drawn that nobody sent (C-5).
                Section {
                    Text("Routing is not on this fleet yet. It may need an update.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .answered:
                modeSection
                rulesSection
                // AN ADMIN'S CONTROLS, and nobody else's: adding a rule, and
                // sending the draft.
                if isAdmin {
                    addSection
                    saveSection
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Routing")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
    }

    /// The mode, as three choices of the same shape, each with what it does
    /// under its name. For an admin each is a button; for anybody else the
    /// same rows are text, with the mark on the one the fleet is set to.
    @ViewBuilder private var modeSection: some View {
        Section {
            ForEach(routingModes, id: \.self) { id in
                if isAdmin {
                    Button { mode = id } label: { modeRow(id) }
                        .disabled(busy)
                } else {
                    modeRow(id)
                        .accessibilityElement(children: .combine)
                }
            }
            if !isAdmin {
                Text("An admin sets this. Anybody can read it.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let who = saved?.updatedBy, !who.isEmpty {
                Text(routingSetLine(by: who, at: taskTime(saved?.updatedAt)))
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            routingSectionHead("When a task has no member")
        } footer: {
            Text(routingAlwaysLine)
        }
    }

    /// One mode: its name, its line, and a mark on the one chosen, said to
    /// VoiceOver as well as drawn. Never the colour alone.
    private func modeRow(_ id: String) -> some View {
        HStack(spacing: Design.Space.insideTight) {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(routingModeName(id))
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                Text(routingModeLine(id))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
                // SAID, AND STILL A CHOICE: the fleet takes this mode with
                // no model on, and asks a person until there is one.
                if id == "auto", !modelOn {
                    Text(routingNoModelLine)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if mode == id {
                Image(systemName: "checkmark")
                    .foregroundStyle(Design.Palette.accent)
                    .accessibilityLabel("Chosen")
            }
        }
        .contentShape(Rectangle())
        .frame(minHeight: 44)
    }

    /// The rules, every one a row of the same shape: the kind of work, and
    /// whom it goes to under it. Remove is an admin's.
    @ViewBuilder private var rulesSection: some View {
        Section {
            if rules.isEmpty {
                Text("No rules yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // BY PLACE, because a draft can hold two rules for one kind of
            // work until the fleet refuses it, and a kind is then no
            // identity. Each row carries its own rule, so a row that was
            // just removed is never read from a place that has gone.
            ForEach(Array(rules.enumerated()), id: \.offset) { index, rule in
                HStack(spacing: Design.Space.insideTight) {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(rule.workType)
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                        Text("Goes to \(taskMemberName(rule.member, members) ?? rule.member)")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 0)
                    if isAdmin {
                        Button("Remove", role: .destructive) { remove(index) }
                            .accessibilityLabel("Remove the rule for \(rule.workType)")
                            .disabled(busy)
                            .frame(minHeight: 44)
                    }
                }
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
        } header: {
            routingSectionHead("Rules")
        }
    }

    /// A new rule: a kind of work as a short word, and a member.
    @ViewBuilder private var addSection: some View {
        Section {
            LabeledContent("Kind of work") {
                TextField("backend", text: $newKind)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Picker("Goes to", selection: $newMember) {
                Text("Nobody yet").tag("")
                ForEach(members) { member in
                    Text(member.name).tag(member.id)
                }
            }
            Button("Add the rule") { add() }
                .disabled(busy || newKind.isBlank || newMember.isEmpty)
                .frame(minHeight: 44)
        } header: {
            routingSectionHead("Add a rule")
        } footer: {
            Text("A kind of work is a short word, like backend or review. Each kind goes to one member.")
        }
    }

    @ViewBuilder private var saveSection: some View {
        Section {
            Button(busy ? "Saving…" : "Save") { Task { await save() } }
                .disabled(busy || !changed)
                .frame(minHeight: 44)
            // A DRAFT IS NOT THE FLEET'S SETTING, and the page says which
            // one is on the screen.
            if changed {
                Text("Not saved yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            if !result.isBlank {
                Text(result)
                    .fleetType(.label)
                    .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    /// Put the new rule on the draft. Whether a kind may have it is the
    /// fleet's to say when the draft is saved.
    private func add() {
        let kind = newKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !kind.isEmpty, !newMember.isEmpty else { return }
        withAnimation(Design.Motion.change) {
            rules.append(Fleet.Routing.Rule(workType: kind, member: newMember))
        }
        newKind = ""
        newMember = ""
        result = ""
    }

    private func remove(_ index: Int) {
        guard rules.indices.contains(index) else { return }
        withAnimation(Design.Motion.change) { _ = rules.remove(at: index) }
        result = ""
    }

    /// The fleet's record becomes the draft.
    private func take(_ now: Fleet.Routing) {
        saved = now
        mode = now.mode ?? "off"
        rules = now.rules ?? []
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).routing()
            guard got.ok != false, let now = got.routing else {
                // A REFUSAL HAS A SENTENCE, and that is a failure to load. An
                // answer with no record and no sentence is a fleet from
                // before routing, which is a different thing to say.
                if let text = got.text, !text.isBlank {
                    load = .failed(text)
                } else {
                    load = .absent
                }
                return
            }
            take(now)
            modelOn = got.model == true
            isAdmin = got.you?.admin == true
            result = ""
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    /// Send the mode and every rule, and show what the fleet said. Its
    /// sentence is the line either way, and a refusal's is all there is.
    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        result = ""
        do {
            let reply = try await Fleet(settings: settings).setRouting(mode: mode, rules: rules)
            failed = reply.ok != true
            result = reply.text ?? (reply.ok == true ? "Saved." : "Your fleet refused that.")
            guard reply.ok == true, let now = reply.routing else { return }
            take(now)
            if let model = reply.model { modelOn = model }
        } catch {
            failed = true
            result = error.localizedDescription
        }
    }
}

private func routingSectionHead(_ text: String) -> some View {
    Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
}
