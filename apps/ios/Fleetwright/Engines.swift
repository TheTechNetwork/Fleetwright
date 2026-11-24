import SwiftUI

/// Engines: what runs a member, and how a turn ended (docs/engines.md).
///
/// A member names up to three engines in the order to try them. A session
/// starts on the first one its machine runs, and when a turn ends on that
/// account's limit its machine starts the member's next engine in the same
/// workspace. These are the words for all of it, in one file, because six
/// screens say them: the member's page and its form, a member's Credentials,
/// a session's page and its row, a task's page, a machine's page and New
/// session.
///
/// THE SENTENCES ARE THE FLEET'S OWN. How a turn ended is said here exactly
/// as `turnWords` says it in src/fleet/protocol/engines.js, so a person reads
/// one sentence on the phone, in a notification and in a terminal.
/// test/engines-in-apps.test.js imports that file and compares, and reads
/// Android (Engines.kt) for the same words.
///
/// A SESSION THAT NAMES NO ENGINES IS CLAUDE CODE, AS BEFORE, and every
/// function here answers nil for it, so nothing new is drawn. Nil is never
/// turned into a name.

/// One engine a member names, and the model it is asked for, when one is.
/// Each engine is named once in a list, so the engine is the row's identity.
struct EngineChoice: Hashable, Identifiable {
    var engine: String
    var model: String?
    var id: String { engine }
}

/// The engines there are, in the order they were built, as the fleet's own
/// table has them (`ENGINES`).
let engineIds = ["claude-code", "codex", "opencode"]
/// The engine every machine runs, and the one a member has when it names none.
let engineDefault = "claude-code"
/// How many a member names. One of each is all there are.
let engineLimit = 3
/// The vault items an engine other than Claude Code runs on, by the names
/// the vault keeps them under.
let engineVaultItems = ["codex", "copilot"]

/// What an engine is called. One this build has never met is shown as the
/// fleet sent it (C-5).
func engineName(_ id: String) -> String {
    switch id {
    case "claude-code": return "Claude Code"
    case "codex": return "Codex"
    case "opencode": return "OpenCode"
    default: return id.isEmpty ? "an engine" : id
    }
}

/// The vault item an engine runs on, or nil for one this build has not met.
func engineVaultItem(_ id: String) -> String? {
    switch id {
    case "claude-code": return "claude"
    case "codex": return "codex"
    case "opencode": return "copilot"
    default: return nil
    }
}

/// A list as it is said: "Claude Code, then Codex (gpt-5.1-codex)".
func engineListWords(_ engines: [EngineChoice]) -> String {
    engines.map { choice in
        let model = choice.model ?? ""
        return model.isEmpty ? engineName(choice.engine) : "\(engineName(choice.engine)) (\(model))"
    }.joined(separator: ", then ")
}

/// Which of its engines a session is on: "On Codex (2 of 3)". Nil when its
/// machine did not say, or named one that is not in the list.
func engineOnLine(_ engines: [EngineChoice], at: Int?) -> String? {
    guard let at, engines.indices.contains(at) else { return nil }
    let name = engineName(engines[at].engine)
    return engines.count > 1 ? "On \(name) (\(at + 1) of \(engines.count))" : "On \(name)"
}

/// How a turn ended, as a sentence, or nil for one that simply ended: a turn
/// that finished is the ordinary case and says nothing.
///
/// `turnWords` in src/fleet/protocol/engines.js, word for word, with one
/// difference: when a limit lifts is said in this phone's own time format.
/// A reason this build has never met is shown as itself.
func engineTurnWords(engine: String?, reason: String?, detail: String? = nil, model: String? = nil, resetsAt: Double? = nil) -> String? {
    guard let reason, !reason.isEmpty, reason != "done" else { return nil }
    let who = engineName(engine ?? "")
    switch reason {
    case "limit":
        let lifts = taskTime(resetsAt).map { " It says the limit lifts at \($0)." } ?? ""
        return "\(who) stopped at its account’s limit.\(lifts)"
    case "auth":
        return "\(who) is not signed in on this machine, or its sign-in has ended."
    case "model":
        let named = model ?? ""
        let said = named.isEmpty ? ", or did not say which it was on" : ": it said \(named)"
        return "\(who) was not on the model that was asked for\(said), so nothing was asked of it."
    case "refused":
        return "\(who)’s provider declined the work."
    case "cut":
        return "\(who) ran out of room in its turn."
    case "cancelled":
        return "\(who)’s turn was stopped."
    case "error":
        let first = detail ?? ""
        let what = first.isEmpty ? "" : ": \(first)"
        return "\(who) stopped on an error\(what)."
    default:
        return "\(who) stopped: \(reason)."
    }
}

/// Why one engine gave way to the next, as the words after the colon. The
/// three endings another engine is the answer to, in `turnWords`' own words;
/// anything else is shown as the fleet sent it.
func engineMoveWhy(_ reason: String?) -> String {
    switch reason ?? "" {
    case "limit": return "stopped at its account’s limit"
    case "auth": return "not signed in on this machine, or its sign-in has ended"
    case "model": return "not on the model that was asked for"
    default: return reason ?? ""
    }
}

/// One move from an engine to the member's next, as a sentence: "Moved from
/// Claude Code to Codex: stopped at its account’s limit".
func engineMoveWords(from: String?, to: String?, reason: String?) -> String {
    let moved = "Moved from \(engineName(from ?? "")) to \(engineName(to ?? ""))"
    let why = engineMoveWhy(reason)
    return why.isEmpty ? moved : "\(moved): \(why)"
}

/// The engines a machine runs, Claude Code first: every machine runs it, and
/// one that names no engines is from before this and runs it alone.
func machineEngines(_ reported: [String]?) -> [String] {
    var out = [engineDefault]
    for id in reported ?? [] where !id.isEmpty && !out.contains(id) { out.append(id) }
    return out
}

/// "Runs: Claude Code, Codex", for a machine's page. Nil when the machine
/// has reported nothing about itself: that is unknown, and not "Claude Code".
func machineRunsLine(_ health: Fleet.HostHealth?) -> String? {
    guard let health else { return nil }
    return "Runs: " + machineEngines(health.engines).map(engineName).joined(separator: ", ")
}

/// What New session says before a start as a member is sent to a machine
/// that does not run the member's first engine: which engines the session
/// will have there. Nil when the first engine runs there, when the member
/// names none, and when the machine has reported nothing to judge by.
///
/// SAID, NOT ENFORCED. Your fleet cuts the list to what the machine runs and
/// refuses a start with none left, and its sentence is shown after the start.
func engineStartNote(member: Fleet.Member, host: Fleet.FleetHost) -> String? {
    guard let health = host.health else { return nil }
    let wanted = member.engineChoices
    guard let first = wanted.first else { return nil }
    let runs = machineEngines(health.engines)
    guard !runs.contains(first.engine) else { return nil }
    let kept = wanted.filter { runs.contains($0.engine) }
    if kept.isEmpty {
        let has = runs.map(engineName).joined(separator: ", ")
        return "\(host.hostId) runs \(has). \(member.name) has \(engineListWords(wanted)), so a session there has no engine to run on."
    }
    return "\(host.hostId) does not run \(engineName(first.engine)). A session as \(member.name) there runs on \(engineListWords(kept))."
}

/// Which of the two engine sign-ins a vault's screen offers: the ones an
/// engine in this list runs on, and any the vault already keeps, so a kept
/// one can always be forgotten. A Codex row for a member with no Codex
/// engine would be a button for nothing (C-2).
func engineItemsOffered(engines: [EngineChoice], kept: [String]) -> [String] {
    engineVaultItems.filter { item in
        kept.contains(item) || engines.contains { engineVaultItem($0.engine) == item }
    }
}

/// Which machine holds a kept Codex sign-in. It is given to one machine and
/// no other, so the row says which, or that none has asked for it yet.
func codexHeldLine(_ heldBy: String?) -> String {
    guard let heldBy, !heldBy.isEmpty else { return "Not handed to a machine yet" }
    return "Held by \(heldBy)"
}

extension Fleet.Member {
    /// Its engines, in the order to try them. Empty from a fleet older than
    /// engines, and then nothing is drawn about them.
    var engineChoices: [EngineChoice] {
        (engines ?? []).map { EngineChoice(engine: $0.engine, model: $0.model) }
    }
}

extension Fleet.Session {
    /// The engines it was started with, in order, or nil for a session whose
    /// machine named none: that one is Claude Code, as before, and shows
    /// nothing new.
    var engineChoices: [EngineChoice]? {
        let named = (engines ?? []).compactMap { choice -> EngineChoice? in
            guard let id = choice.engine, !id.isEmpty else { return nil }
            return EngineChoice(engine: id, model: choice.model)
        }
        return named.isEmpty ? nil : named
    }

    /// The engine's name for the session's row, only when it is not Claude
    /// Code: every row would otherwise say the same thing and mean nothing.
    var engineOnRow: String? {
        guard let list = engineChoices, let at = engineAt, list.indices.contains(at) else { return nil }
        let id = list[at].engine
        return id == engineDefault ? nil : engineName(id)
    }
}

/// The engine a session is on, for its page: which one, the list in order,
/// each move from one to the next with its time, and how its last turn ended
/// when it did not simply end.
struct SessionEngineLines: View {
    let session: Fleet.Session

    var body: some View {
        if let list = session.engineChoices {
            if let on = engineOnLine(list, at: session.engineAt) {
                Text(on)
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
            }
            if list.count > 1 {
                Text(engineListWords(list))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let moves = session.engineLog ?? []
            ForEach(moves.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text(engineMoveWords(from: moves[index].from, to: moves[index].to, reason: moves[index].reason))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let when = taskTime(moves[index].at) {
                        Text(when)
                            .fleetType(.micro)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if let turn = session.turn,
               let ended = engineTurnWords(engine: turn.engine, reason: turn.reason, detail: turn.detail, model: turn.model, resetsAt: turn.resetsAt) {
                Text(ended)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }
}

/// One engine's sign-in in a vault: the Codex sign-in or the GitHub Copilot
/// token. Whether it is kept and since when, the way to keep or replace it
/// by pasting, and Forget, which asks first on the screen around this.
///
/// WHAT IS PASTED IS NEVER SHOWN AGAIN. The field is emptied when the vault
/// took it and when this row leaves the screen, and nothing here reads a
/// kept value back: a vault answers with names and never with values.
///
/// THE CODEX SIGN-IN GOES TO ONE MACHINE, because Codex renews it there and
/// a renewal ends every other copy. So the row says which machine holds it,
/// that pasting it again moves it, and, where it is pasted, that the paste
/// is itself a copy of a file still on somebody's computer.
struct EngineSignInRow: View {
    /// "codex" or "copilot", as the vault names it.
    let name: String
    /// The kept item, or nil when the vault keeps none.
    let item: PhoneVault.Item?
    let busy: Bool
    /// Keep what was pasted. True when the vault took it.
    let keep: (String) async -> Bool
    let forget: () -> Void

    @State private var pasting = false
    @State private var pasted = ""

    private var title: String { PhoneVault.label(name) }
    /// What the first button does, said with the thing it does it to.
    private var keepLabel: String { item == nil ? "Keep \(title)" : "Replace \(title)" }

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(spacing: Design.Space.insideTight) {
                Text(title)
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                Spacer()
                Text(item == nil ? "Not kept" : "Kept")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                Button(item == nil ? "Keep" : "Replace") { pasting.toggle() }
                    .accessibilityLabel(keepLabel)
                    .disabled(busy)
                if item != nil {
                    Button("Forget", role: .destructive) { forget() }
                        .accessibilityLabel("Forget \(title)")
                        .disabled(busy)
                }
            }
            .frame(minHeight: 44)
            .buttonStyle(.borderless)
            if let item, !sinceAndWhere(item).isEmpty {
                Text(sinceAndWhere(item))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if name == "codex" {
                Text("Goes to one machine. Pasting it again moves it.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if pasting { pasteStep }
        }
        // LEAVING THE SCREEN EMPTIES THE FIELD, so a sign-in pasted and not
        // sent is not waiting there for the next person to open this page.
        .onDisappear { pasted = "" }
    }

    /// When it was kept and, for Codex, which machine holds it.
    private func sinceAndWhere(_ item: PhoneVault.Item) -> String {
        let since = taskTime(item.at).map { "Since \($0)" }
        let held = name == "codex" ? codexHeldLine(item.heldBy) : nil
        return [since, held].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private var pasteStep: some View {
        if name == "codex" {
            Text("Paste the whole of ~/.codex/auth.json, the file codex login leaves.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text("What you paste is a copy. Whichever of the two renews first ends the other.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            // Many lines, because the file is: a one-line field would show
            // its first forty characters and hide whether the rest arrived.
            TextField("auth.json", text: $pasted, axis: .vertical)
                .lineLimit(3...8)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .fleetType(.labelMono)
                .accessibilityLabel("The auth.json file")
        } else {
            Text("Paste one GitHub Copilot token. OpenCode runs on it.")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            SecureField("GitHub Copilot token", text: $pasted)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        Button(item == nil ? "Keep it" : "Replace it") {
            Task {
                // Emptied only once the vault took it: a file it refused is
                // still there to be looked at and pasted again whole.
                if await keep(pasted) {
                    pasted = ""
                    pasting = false
                }
            }
        }
        .frame(minHeight: 44)
        .buttonStyle(.borderless)
        .disabled(busy || pasted.isBlank)
    }
}

/// A member's engines, on its form: an ordered list to add to, remove from
/// and reorder, with a model beside each.
///
/// MOVE UP AND MOVE DOWN ARE BUTTONS, not a drag alone, so a keyboard and a
/// switch control can reorder the list, and each says what it moves. Remove
/// is not drawn for the last engine, because a member has at least one, and
/// Add offers only an engine the list does not have yet (C-2).
struct MemberEnginesEditor: View {
    @Binding var engines: [EngineChoice]

    /// The engines the list does not name yet. Empty at three.
    private var addable: [String] {
        engines.count >= engineLimit ? [] : engineIds.filter { id in !engines.contains { $0.engine == id } }
    }

    var body: some View {
        // BY THE ENGINE AND NOT BY ITS PLACE. Each engine is named once, so
        // it is the row's identity: a row keeps its field as it moves, and
        // a row that was just removed is never asked for a place that is
        // no longer in the list.
        ForEach(engines) { choice in
            row(choice.engine)
        }
        ForEach(addable, id: \.self) { id in
            Button("Add \(engineName(id))") {
                withAnimation(Design.Motion.change) { engines.append(EngineChoice(engine: id, model: nil)) }
            }
            .frame(minHeight: 44)
        }
    }

    private func row(_ id: String) -> some View {
        let index = engines.firstIndex { $0.engine == id } ?? 0
        let name = engineName(id)
        // OpenCode's model also says whose account pays, so it is required
        // and the field shows the form it takes.
        let prompt: String = id == "opencode" ? "github-copilot/<model>" : "Optional"
        return VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text("\(index + 1). \(name)")
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            LabeledContent("Model") {
                TextField(prompt, text: model(id))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Model for \(name)")
            }
            if id == "opencode" {
                Text("OpenCode needs a model, written github-copilot/<model>.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if engines.count > 1 {
                HStack(spacing: Design.Space.insideTight) {
                    Button("Up") { move(id, by: -1) }
                        .accessibilityLabel("Move \(name) up")
                        .disabled(index == 0)
                        .frame(minWidth: 44, minHeight: 44)
                    Button("Down") { move(id, by: 1) }
                        .accessibilityLabel("Move \(name) down")
                        .disabled(index == engines.count - 1)
                        .frame(minWidth: 44, minHeight: 44)
                    Spacer(minLength: 0)
                    Button("Remove", role: .destructive) {
                        withAnimation(Design.Motion.change) { engines.removeAll { $0.engine == id } }
                    }
                    .accessibilityLabel("Remove \(name)")
                    .frame(minHeight: 44)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    /// The model beside one engine, as the field edits it. Empty is no model.
    private func model(_ id: String) -> Binding<String> {
        Binding(
            get: { engines.first { $0.engine == id }?.model ?? "" },
            set: { now in
                guard let index = engines.firstIndex(where: { $0.engine == id }) else { return }
                let named = now.trimmingCharacters(in: .whitespacesAndNewlines)
                engines[index].model = named.isEmpty ? nil : named
            }
        )
    }

    /// Move one engine a place up or down. Nothing happens at either end.
    private func move(_ id: String, by step: Int) {
        guard let index = engines.firstIndex(where: { $0.engine == id }) else { return }
        let to = index + step
        guard engines.indices.contains(to) else { return }
        withAnimation(Design.Motion.change) { engines.swapAt(index, to) }
    }
}

/// What a member's engines are sent as: the list in its order, each with its
/// model when one is named. Nil when the list cannot be sent as it stands,
/// with the sentence to show: a member has at least one engine, and OpenCode
/// is not sent without a model. Every other rule is your fleet's to refuse.
func memberEnginesToSend(_ engines: [EngineChoice]) -> (list: [[String: String]]?, problem: String?) {
    guard !engines.isEmpty else { return (nil, "A member has at least one engine.") }
    var list: [[String: String]] = []
    for choice in engines {
        let model = (choice.model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if choice.engine == "opencode", model.isEmpty {
            return (nil, "OpenCode needs a model, written github-copilot/<model>.")
        }
        list.append(model.isEmpty ? ["engine": choice.engine] : ["engine": choice.engine, "model": model])
    }
    return (list, nil)
}
