import SwiftUI

/// Budgets and approvals: what a member has spent this month, and the starts
/// that wait for a person (docs/budgets.md).
///
/// Your fleet counts what each member's sessions cost. A start that would
/// take a member past its budget, or that an admin named as risky, is
/// refused until somebody who manages that member approves it. Nothing is
/// held: once the approval is given, the same start is sent again.
///
/// THE SENTENCES ARE THE FLEET'S OWN. What a member has spent is `words`, a
/// refusal is `text`, and why a start needs approval is each reason's
/// `text`, drawn exactly as sent. A figure can be a floor ("At least $3.00",
/// when a session reported no cost), and what a member has spent is told
/// only to whoever may see it, so a line this phone rebuilt from a number
/// could say a floor as a total, or a figure to somebody who was not sent
/// one (C-5). No screen here reads a dollar amount.
///
/// THE PHONE DECIDES NOTHING. Who may answer an approval is the fleet's word
/// (`mayAnswer`), who may change the rules is the fleet's word
/// (`you.admin`), and every control is drawn from one of those and nothing
/// else (C-2). A refusal is shown in the fleet's sentence.
///
/// The same words as Android (Budgets.kt), held equal by
/// test/budgets-in-apps.test.js.

/// What happens at a budget, in the order it is offered: off first, because
/// it is what a fleet does until an admin says otherwise.
let budgetModes = ["off", "ask", "refuse"]

/// A choice's name. One this build has never met is shown as the fleet sent
/// it (C-5).
func budgetModeName(_ mode: String) -> String {
    switch mode {
    case "off": return "Count only"
    case "ask": return "Ask first"
    case "refuse": return "Refuse"
    default: return mode
    }
}

/// The one line under a choice.
func budgetModeLine(_ mode: String) -> String {
    switch mode {
    case "off": return "Budgets are shown and stop nothing."
    case "ask": return "A start past a member’s budget waits for approval."
    case "refuse": return "A start past a member’s budget is refused until the month turns or the budget is raised."
    default: return ""
    }
}

/// The switch for a session that runs commands without asking first.
let budgetDangerousLabel = "Ask before a session that skips permission prompts"

/// The switch for a start as a member with an engine on an API key
/// (docs/api-engines.md), and the one line under it: why it starts on.
let budgetPaidApiLabel = "Ask before a session on a paid API key"
let budgetPaidApiLine = "A key is billed by the token and no budget here counts it, so this is on until an admin turns it off."

/// What counting is, and what it never does, said on the rules whoever is
/// reading them.
let budgetCountingLine = "Counting is at API prices, as each session counts its own cost. Sessions already running are not stopped."

/// How many kinds of work an admin may name, as the fleet takes them.
let budgetWorkTypeLimit = 20

/// A note beside a decline, in bytes of UTF-8, as the fleet measures it.
let approvalNoteLimit = 300

/// Whether an approval is asking this person something: it is waiting, and
/// the fleet says it is theirs to answer. Approve and Decline are drawn for
/// these and no others, and these are the ones that come first.
func approvalWaitsOnYou(_ approval: Fleet.Approval) -> Bool {
    approval.state == "waiting" && approval.mayAnswer == true
}

/// What is being asked for: a session, and as whom. The member is named
/// where the fleet named it and shown by id where it did not.
func approvalAskWords(_ approval: Fleet.Approval) -> String {
    let name = approval.memberName ?? approval.member ?? ""
    return name.isEmpty ? "Start a session" : "Start a session as \(name)"
}

/// Who asked, and when the fleet said when.
func approvalAskedLine(by: String?, at: String?) -> String {
    let who = (by ?? "").isEmpty ? "Asked" : "Asked by \(by ?? "")"
    guard let at else { return who }
    return "\(who), \(at)"
}

/// Where an approval stands, in words. A state this build has never met is
/// shown as the fleet sent it, and nobody is named who the fleet did not
/// name (C-5). The same sentences on both phones.
func approvalStateWords(state: String?, decidedBy: String?, mayAnswer: Bool) -> String {
    let who = decidedBy ?? ""
    let by = who.isEmpty ? "" : " by \(who)"
    switch state ?? "" {
    case "waiting": return mayAnswer ? "Waiting on you" : "Waiting for an answer"
    case "approved": return "Approved\(by), for one start within the hour"
    case "declined": return "Declined\(by)"
    case "used": return "Approved\(by) and used"
    case "expired": return who.isEmpty ? "Ran out before it was answered" : "Approved\(by), and ran out before it was used"
    default: return state ?? ""
    }
}

/// What approving does, said before it is done: the reasons, each in the
/// fleet's own sentence, and that it is for one start.
func approvalConfirmWords(_ approval: Fleet.Approval) -> String {
    let reasons = (approval.reasons ?? []).compactMap(\.text).filter { !$0.isEmpty }
    return (reasons + ["Approving is for this one start, within the hour."]).joined(separator: " ")
}

/// The row under Organization: how many approvals wait on this person. Nil
/// when none do, and then the row says nothing beside its name.
func describeApprovals(waitingOnYou count: Int) -> String? {
    count == 0 ? nil : "\(count) waiting on you"
}

/// A member's spend as the line under "This month": the fleet's sentence,
/// and "Over budget" in words before it when the fleet says so. Never the
/// colour alone.
func memberSpendLine(over: Bool, words: String) -> String {
    over ? "Over budget. \(words)" : words
}

/// The names a notification gives two pages among the pages under You:
/// "approvals", and "member:" with a member's id.
let approvalsPage = "approvals"
let memberPagePrefix = "member:"

/// The member a page name asks for, or nil when it names something else.
///
/// THE ID CAME FROM A NOTIFICATION'S PAYLOAD, so it is held to what a
/// member's id is: lowercase letters, digits and hyphens, at most 40.
func memberPageId(_ page: String) -> String? {
    guard page.hasPrefix(memberPagePrefix) else { return nil }
    let id = String(page.dropFirst(memberPagePrefix.count))
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
    guard !id.isEmpty, id.count <= 40, id.allSatisfy({ allowed.contains($0) }) else { return nil }
    return id
}

/// A start your fleet refused at a budget or for want of approval: its
/// sentence, and the approval it waits on when there is one.
///
/// Nil for every other answer, so a screen draws this only for the two
/// refusals it is about, by the fleet's own code and never by its wording.
struct RefusedStart: Equatable {
    let text: String
    /// "needs_approval" or "over_budget".
    let code: String
    let approval: Fleet.Approval?

    init?(_ reply: Fleet.Reply) {
        guard reply.ok == false, let code = reply.error?.code, code == "needs_approval" || code == "over_budget" else { return nil }
        self.code = code
        text = reply.text ?? ""
        approval = code == "needs_approval" ? reply.approval : nil
    }

    /// The approval this person may give themselves, when the fleet says so.
    var mine: Fleet.Approval? {
        guard let approval, approval.mayAnswer == true, !approval.id.isEmpty else { return nil }
        return approval
    }
}

/// A refused start, where the start's answer is drawn: the fleet's sentence,
/// and what this person can do about it.
///
/// THREE SHAPES, FROM THE FLEET'S ANSWER (C-2). Where it says the approval
/// is this person's to give: Approve and start. Where somebody else must
/// give it: nothing to approve, since the sentence already says who can,
/// and Try again for once they have. At a budget the fleet refuses outright:
/// the sentence, and nothing to press, because nothing pressed here changes
/// a month or a budget.
///
/// ONE APPROVE, ONE RETRY. Approve and start sends the approval, and when
/// the fleet took it, sends the same start again, once. Whatever that second
/// answer is, the screen behind this shows it as it shows any start's
/// answer. Nothing here sends a third request.
struct RefusedStartView: View {
    let settings: Settings
    let refused: RefusedStart
    /// Sends the same start again. The screen that sent the first one owns
    /// it, and shows the answer.
    let again: () -> Void

    @State private var busy = false
    @State private var problem = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text(refused.text)
                .fleetType(.bodySmall)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let approval = refused.mine {
                Button(busy ? "Approving…" : "Approve and start") { approveAndStart(approval) }
                    .disabled(busy)
                    .frame(minHeight: 44)
                Text("Approves this one start and sends it again.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if refused.code == "needs_approval" {
                Button("Try again") { again() }
                    .frame(minHeight: 44)
                    .accessibilityHint("Sends the same start again")
            }
            if !problem.isBlank {
                Text(problem)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.bad)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .buttonStyle(.borderless)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Give the approval, then send the same start once. A refusal to
    /// approve is the fleet's sentence here, and then no start is sent.
    private func approveAndStart(_ approval: Fleet.Approval) {
        Task { @MainActor in
            busy = true
            problem = ""
            defer { busy = false }
            do {
                let reply = try await Fleet(settings: settings).answerApproval(id: approval.id, answer: "approve")
                guard reply.ok == true else {
                    problem = reply.text ?? "Your fleet refused that."
                    return
                }
                again()
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// What the fleet said of a member's spending: on its way, answered (with
/// this member's line, or nil when the answer does not list it), or failed.
enum MemberSpendLoad {
    case asking
    case answered(Fleet.MemberSpend?)
    case failed(String)
}

/// Ask what one member has spent this month. Never throws: a failure is a
/// state the page says.
func memberSpend(_ settings: Settings, _ memberId: String) async -> MemberSpendLoad {
    do {
        let got = try await Fleet(settings: settings).budgets()
        guard got.ok != false, let listed = got.members else {
            // A refusal has a sentence. An answer with neither is a fleet
            // from before budgets, which has nothing to say here.
            if let text = got.text, !text.isBlank { return .failed(text) }
            return .answered(nil)
        }
        return .answered(listed.first { $0.member == memberId })
    } catch {
        return .failed(error.localizedDescription)
    }
}

/// "This month" on a member's page: what the fleet counted against its
/// budget, in the fleet's sentence.
///
/// ONLY WHEN THE FLEET LISTED THIS MEMBER. Its answer holds the members this
/// person may see the spending of, so a member who is not in it gets no
/// line at all, never "$0.00", which would be a figure nobody sent (C-5).
/// While the answer is on its way there is nothing to say and nothing is
/// drawn; a load that failed says so. A fleet from before budgets answers
/// with no list and no sentence, and that draws nothing either.
///
/// The member's page asks, because a section that draws nothing while it
/// waits has nothing on screen to start the asking from.
struct MemberSpendSection: View {
    let load: MemberSpendLoad

    var body: some View {
        switch load {
        case .asking:
            EmptyView()
        case .failed(let why):
            Section {
                Text("Spending could not be loaded.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                Text(why)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .textSelection(.enabled)
            }
        case .answered(let spend):
            if let spend, let words = spend.words, !words.isBlank {
                Section {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text("This month")
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                        // THE PAGE'S ONE ATTENTION COLOUR, and only past the
                        // budget. The words say it first.
                        Text(memberSpendLine(over: spend.over == true, words: words))
                            .fleetType(.label)
                            .foregroundStyle(spend.over == true ? Design.Palette.attention : Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// Approvals: the starts waiting on this person, then this person's own
/// asks, then the ones that are over. Reached from Organization.
///
/// WAITING ON YOU IS FIRST, because those are asking a question, and they
/// are the only ones whose state takes the attention colour. Every approval
/// is the same shape: what is asked, who asked, each reason in the fleet's
/// sentence, the task when there is one, and where it stands in words.
///
/// APPROVE AND DECLINE ONLY WHERE THE FLEET WOULD TAKE THEM (C-2): on one
/// that is waiting and that the fleet says is this person's to answer.
/// Approve asks once, with the reasons in front of it. Decline opens a page
/// for a note, which is optional and is told to whoever asked.
///
/// FOUR STATES: loading, could not load, loaded (which may be empty, and
/// says so), and a fleet that answered with no list and no sentence, which
/// is one from before approvals.
struct ApprovalsView: View {
    let settings: Settings

    private enum Load { case asking, answered, absent, failed(String) }
    @State private var load = Load.asking
    @State private var approvals: [Fleet.Approval] = []
    @State private var finishedOpen = false
    /// Approve is waiting on its dialog for this one.
    @State private var approving: Fleet.Approval?
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    private var onYou: [Fleet.Approval] { approvals.filter { approvalWaitsOnYou($0) } }
    /// Waiting, and somebody else's to answer: this person's own asks.
    private var asked: [Fleet.Approval] { approvals.filter { $0.state == "waiting" && $0.mayAnswer != true } }
    private var finished: [Fleet.Approval] { approvals.filter { $0.state != "waiting" } }

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
                Section {
                    Text("Could not load the approvals.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            case .absent:
                // NOT A FAILURE, AND NOT "NONE". The fleet answered with no
                // list and nothing to say about it, which is what one from
                // before approvals does (C-5).
                Section {
                    Text("Approvals are not on this fleet yet. It may need an update.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .answered:
                if approvals.isEmpty {
                    Section {
                        Text("No approvals yet. A start that needs one is listed here.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    waitingSections
                    askedSections
                    if !finished.isEmpty { finishedSection }
                }
                if !result.isBlank {
                    Section {
                        Text(result)
                            .fleetType(.label)
                            .foregroundStyle(failed ? Design.Palette.bad : Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                rulesSection
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        // APPROVE ASKS ONCE, with the reasons in front of it and what an
        // approval is good for.
        .confirmationDialog(
            approving.map { approvalAskWords($0) + "?" } ?? "",
            isPresented: Binding(get: { approving != nil }, set: { if !$0 { approving = nil } }),
            titleVisibility: .visible,
            presenting: approving
        ) { approval in
            Button("Approve") { approve(approval) }
        } message: { approval in
            Text(approvalConfirmWords(approval))
        }
    }

    /// The ones asking this person, each a section of the same shape with
    /// its two answers under it. With none, the page says so in the calm
    /// colour: nothing waiting is the answer most people open this for.
    @ViewBuilder private var waitingSections: some View {
        if onYou.isEmpty {
            Section {
                Text("Nothing is waiting on you.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            } header: {
                approvalsSectionHead("Waiting on you")
            }
        }
        ForEach(Array(onYou.enumerated()), id: \.element.id) { index, approval in
            Section {
                facts(approval)
                taskLink(approval)
                if approvalWaitsOnYou(approval) {
                    Button("Approve") { approving = approval }
                        .disabled(busy)
                        .frame(minHeight: 44)
                    NavigationLink("Decline") {
                        ApprovalDeclineView(settings: settings, approval: approval) { reply in
                            show(reply)
                        }
                    }
                    .disabled(busy)
                }
            } header: {
                if index == 0 { approvalsSectionHead("Waiting on you") }
            }
        }
    }

    /// This person's own asks that somebody else has still to answer.
    @ViewBuilder private var askedSections: some View {
        ForEach(Array(asked.enumerated()), id: \.element.id) { index, approval in
            Section {
                facts(approval)
                taskLink(approval)
            } header: {
                if index == 0 { approvalsSectionHead("Your asks") }
            }
        }
    }

    /// Approved, declined, used and run out, behind one row.
    @ViewBuilder private var finishedSection: some View {
        Section {
            DisclosureGroup("Finished", isExpanded: $finishedOpen) {
                ForEach(finished) { approval in
                    facts(approval)
                    taskLink(approval)
                }
            }
        }
    }

    /// WHAT NEEDS APPROVAL, one tap away, as Routing is from Organization.
    /// The row is for everybody, and its page draws a control only for an
    /// admin.
    @ViewBuilder private var rulesSection: some View {
        Section {
            NavigationLink("What needs approval") {
                BudgetSettingsView(settings: settings)
            }
        }
    }

    /// One approval, the same shape wherever it is listed.
    private func facts(_ approval: Fleet.Approval) -> some View {
        let asksYou = approvalWaitsOnYou(approval)
        return VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(approvalAskWords(approval))
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            Text(approvalAskedLine(by: approval.askedBy, at: taskTime(approval.askedAt)))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            // EACH REASON IS THE FLEET'S SENTENCE, as sent.
            ForEach(approval.reasons ?? [], id: \.self) { reason in
                if let text = reason.text, !text.isEmpty {
                    Text(text)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let note = approval.note, !note.isEmpty {
                Text("Note: \(note)")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // WHERE IT STANDS, IN WORDS. The attention colour is on the
            // ones asking this person and on nothing else here.
            Text(approvalStateWords(state: approval.state, decidedBy: approval.decidedBy, mayAnswer: approval.mayAnswer == true))
                .fleetType(.label)
                .foregroundStyle(asksYou ? Design.Palette.attention : Design.Palette.inkDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// The task a start is on, which opens that task's page. The id is read
    /// as a task's id or not at all.
    @ViewBuilder private func taskLink(_ approval: Fleet.Approval) -> some View {
        if let task = approval.task, let id = taskPageId(taskPagePrefix + task) {
            NavigationLink("Task \(id)") {
                TaskView(settings: settings, id: id)
            }
        }
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).approvals()
            guard got.ok != false, let list = got.approvals else {
                // A REFUSAL HAS A SENTENCE, and that is a failure to load.
                // An answer with no list and no sentence is a fleet from
                // before approvals.
                if let text = got.text, !text.isBlank {
                    load = .failed(text)
                } else {
                    load = .absent
                }
                return
            }
            withAnimation(Design.Motion.change) { approvals = list }
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    /// What the fleet said of an answer is the page's line, a refusal's
    /// sentence included, and then the list as the fleet has it now.
    @MainActor
    private func show(_ reply: Fleet.ApprovalReply) {
        failed = reply.ok != true
        result = reply.text ?? (reply.ok == true ? "Answered." : "Your fleet refused that.")
        Task { await reload() }
    }

    /// Send the approval, after its dialog. Decline is sent from its own
    /// page, where the note is.
    private func approve(_ approval: Fleet.Approval) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                show(try await Fleet(settings: settings).answerApproval(id: approval.id, answer: "approve"))
            } catch {
                failed = true
                result = error.localizedDescription
            }
        }
    }
}

/// Decline one start, with a note or without.
///
/// THE NOTE IS OPTIONAL AND IT IS NOT PRIVATE: the fleet tells it to
/// whoever asked, and the page says so before anything is typed. It is
/// counted as the fleet counts it, in bytes of UTF-8, and Decline waits
/// while it is over: a note the fleet would refuse is not sent to find out.
struct ApprovalDeclineView: View {
    let settings: Settings
    let approval: Fleet.Approval
    let onAnswered: (Fleet.ApprovalReply) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var busy = false
    @State private var result = ""

    private var noteBytes: Int { taskBytes(note.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        Form {
            Section {
                TextField("Why, if you want to say", text: $note, axis: .vertical)
                    .lineLimit(3...8)
                    .accessibilityLabel("Note")
                // Over the limit it takes the error colour, and the line
                // itself says by how much: never the colour alone.
                Text(noteBytes > approvalNoteLimit
                    ? "\(noteBytes) of \(approvalNoteLimit) bytes, \(noteBytes - approvalNoteLimit) too many"
                    : "\(noteBytes) of \(approvalNoteLimit) bytes")
                    .fleetType(.micro)
                    .foregroundStyle(noteBytes > approvalNoteLimit ? Design.Palette.bad : Design.Palette.inkDim)
            } header: {
                approvalsSectionHead("Note")
            } footer: {
                Text("Optional. The note is told to the person who asked.")
            }

            Section {
                Button(busy ? "Declining…" : "Decline") { Task { await send() } }
                    .disabled(busy || noteBytes > approvalNoteLimit)
                    .frame(minHeight: 44)
                if !result.isBlank {
                    Text(result)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle(approvalAskWords(approval))
        .navigationBarTitleDisplayMode(.inline)
    }

    @MainActor
    private func send() async {
        let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        defer { busy = false }
        result = ""
        do {
            let reply = try await Fleet(settings: settings).answerApproval(id: approval.id, answer: "decline", note: said)
            // A refusal keeps the page open with the fleet's sentence on it.
            guard reply.ok == true else {
                result = reply.text ?? "Your fleet refused that."
                return
            }
            onAnswered(reply)
            dismiss()
        } catch {
            result = error.localizedDescription
        }
    }
}

/// What needs approval: what your fleet does at a member's budget, and what
/// else it asks a person about before a start. One tap from Approvals.
///
/// EVERYBODY READS IT AND AN ADMIN EDITS IT, as Routing is read and edited.
/// Whether this person is an admin is the fleet's answer (`you.admin`), and
/// every control here is drawn from that answer and nothing else (C-2).
/// Somebody who is not one sees the same page: the choice marked, the switch
/// as a word, the kinds of work listed, no control, and one line saying who
/// sets it.
///
/// NOTHING IS SENT UNTIL Save, AND THEN ALL OF IT: the page keeps a draft,
/// says when the draft differs from what the fleet has, and shows what the
/// fleet said of a save, a refusal's sentence included.
///
/// FOUR STATES: loading, could not load, loaded, and a fleet that answered
/// with no setting and no sentence, which is one from before budgets.
///
/// THE PAID-KEY SWITCH IS DRAWN ONLY FOR A FLEET THAT SENT IT
/// (docs/api-engines.md). One from before the guard sends no `paidApi`, and
/// that is unknown, never off: no switch, no word, and nothing about it in
/// what Save sends (C-5).
struct BudgetSettingsView: View {
    let settings: Settings

    private enum Load { case asking, answered, absent, failed(String) }
    @State private var load = Load.asking
    /// The setting as the fleet last sent it. The draft is held against it.
    @State private var saved: Fleet.BudgetSettings?
    @State private var isAdmin = false
    /// The draft: what Save would send.
    @State private var mode = "off"
    @State private var dangerous = false
    /// Nil when the fleet sent no such switch, and then none is drawn.
    @State private var paidApi: Bool?
    @State private var workTypes: [String] = []
    @State private var newKind = ""
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false

    /// Whether the draft differs from what the fleet has.
    private var changed: Bool {
        mode != (saved?.budgets ?? "off") || dangerous != (saved?.dangerous ?? false) || workTypes != (saved?.workTypes ?? [])
            || paidApi != saved?.paidApi
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
                Section {
                    Text("Could not load what needs approval.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            case .absent:
                // NOT A FAILURE, AND NOT "COUNT ONLY". No choice is drawn
                // that nobody sent (C-5).
                Section {
                    Text("Budgets are not on this fleet yet. It may need an update.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .answered:
                modeSection
                alsoSection
                kindsSection
                // AN ADMIN'S CONTROLS, and nobody else's: naming a kind of
                // work, and sending the draft.
                if isAdmin {
                    addSection
                    saveSection
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("What needs approval")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
    }

    /// What happens at a budget, as three choices of the same shape, each
    /// with what it does under its name. For an admin each is a button; for
    /// anybody else the same rows are text, with the mark on the one the
    /// fleet is set to.
    @ViewBuilder private var modeSection: some View {
        Section {
            ForEach(budgetModes, id: \.self) { id in
                if isAdmin {
                    Button { mode = id } label: { modeRow(id) }
                        .disabled(busy)
                } else {
                    modeRow(id)
                        .accessibilityElement(children: .combine)
                }
            }
            if !isAdmin {
                Text("A fleet admin sets these. Anybody can read them.")
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
            approvalsSectionHead("When a member is past its budget")
        } footer: {
            Text(budgetCountingLine)
        }
    }

    /// One choice: its name, its line, and a mark on the one chosen, said
    /// to VoiceOver as well as drawn. Never the colour alone.
    private func modeRow(_ id: String) -> some View {
        HStack(spacing: Design.Space.insideTight) {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(budgetModeName(id))
                    .fleetType(.body)
                    .foregroundStyle(Design.Palette.ink)
                Text(budgetModeLine(id))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
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

    /// A session that runs commands without asking first: a switch for an
    /// admin, and for anybody else the same words with On or Off beside them.
    @ViewBuilder private var alsoSection: some View {
        Section {
            if isAdmin {
                Toggle(budgetDangerousLabel, isOn: $dangerous)
                    .disabled(busy)
                    .frame(minHeight: 44)
            } else {
                HStack(spacing: Design.Space.insideTight) {
                    Text(budgetDangerousLabel)
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(dangerous ? "On" : "Off")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
            }
            // A PAID API KEY, in the same two shapes, and only when the
            // fleet sent the switch: `on` is its answer or the draft made
            // from it, never a default of this phone's.
            if let on = paidApi {
                if isAdmin {
                    Toggle(budgetPaidApiLabel, isOn: Binding(get: { on }, set: { paidApi = $0 }))
                        .disabled(busy)
                        .frame(minHeight: 44)
                } else {
                    HStack(spacing: Design.Space.insideTight) {
                        Text(budgetPaidApiLabel)
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Text(on ? "On" : "Off")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                }
                Text(budgetPaidApiLine)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            approvalsSectionHead("Before a start")
        }
    }

    /// The kinds of work whose tasks are asked about, every one a row of the
    /// same shape. Remove is an admin's.
    @ViewBuilder private var kindsSection: some View {
        Section {
            if workTypes.isEmpty {
                Text("No kinds of work yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            ForEach(workTypes, id: \.self) { kind in
                HStack(spacing: Design.Space.insideTight) {
                    Text(kind)
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                    Spacer(minLength: 0)
                    if isAdmin {
                        Button("Remove", role: .destructive) { remove(kind) }
                            .accessibilityLabel("Remove \(kind)")
                            .disabled(busy)
                            .frame(minHeight: 44)
                    }
                }
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
        } header: {
            approvalsSectionHead("Kinds of work that need approval")
        } footer: {
            Text("A start on a task of one of these kinds waits for approval.")
        }
    }

    /// A new kind of work, as a short word. Not offered past the twenty the
    /// fleet takes, and the line says why.
    @ViewBuilder private var addSection: some View {
        Section {
            if workTypes.count < budgetWorkTypeLimit {
                LabeledContent("Kind of work") {
                    TextField("deploy", text: $newKind)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Button("Add the kind") { add() }
                    .disabled(busy || newKind.isBlank)
                    .frame(minHeight: 44)
            } else {
                Text("That is all \(budgetWorkTypeLimit). Remove one to add another.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } footer: {
            Text("A kind of work is a short word, like deploy or billing. At most \(budgetWorkTypeLimit).")
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

    /// Put the new kind on the draft, once. Whether the word is one the
    /// fleet takes is its to say when the draft is saved.
    private func add() {
        let kind = newKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !kind.isEmpty, workTypes.count < budgetWorkTypeLimit else { return }
        if !workTypes.contains(kind) {
            withAnimation(Design.Motion.change) { workTypes.append(kind) }
        }
        newKind = ""
        result = ""
    }

    private func remove(_ kind: String) {
        withAnimation(Design.Motion.change) { workTypes.removeAll { $0 == kind } }
        result = ""
    }

    /// The fleet's setting becomes the draft.
    private func take(_ now: Fleet.BudgetSettings) {
        saved = now
        mode = now.budgets ?? "off"
        dangerous = now.dangerous ?? false
        paidApi = now.paidApi
        workTypes = now.workTypes ?? []
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).budgets()
            guard got.ok != false, let now = got.settings else {
                // A REFUSAL HAS A SENTENCE, and that is a failure to load. An
                // answer with no setting and no sentence is a fleet from
                // before budgets, which is a different thing to say.
                if let text = got.text, !text.isBlank {
                    load = .failed(text)
                } else {
                    load = .absent
                }
                return
            }
            take(now)
            isAdmin = got.you?.admin == true
            result = ""
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    /// Send the choice, the switch and every kind of work, then the paid-key
    /// switch where there is one, and show what the fleet said. Its sentence
    /// is the line either way, and a refusal's is all there is.
    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        result = ""
        do {
            var reply = try await Fleet(settings: settings).setBudgetSettings(budgets: mode, dangerous: dangerous, workTypes: workTypes)
            // THE PAID-KEY SWITCH GOES IN A REQUEST OF ITS OWN, after the
            // three, and only when the fleet sent the switch and the draft
            // moved it. The three are the fleet's by then, so they stop
            // being a draft whatever it says of the switch, and its answer
            // carries the whole setting and is the one shown.
            if reply.ok == true, let kept = reply.settings, let wanted = paidApi, wanted != kept.paidApi {
                saved = kept
                reply = try await Fleet(settings: settings).setPaidApiApproval(wanted)
            }
            failed = reply.ok != true
            result = reply.text ?? (reply.ok == true ? "Saved." : "Your fleet refused that.")
            guard reply.ok == true, let now = reply.settings else { return }
            take(now)
        } catch {
            failed = true
            result = error.localizedDescription
        }
    }
}

/// A member's page, asked for by id from a notification about its budget.
///
/// The page needs the member's record and everybody else's, so this asks
/// for the organization first, as the Organization screen does, and then
/// draws the page that screen would have opened. A member the fleet no
/// longer lists is said as that.
struct MemberPageByID: View {
    let settings: Settings
    let id: String

    private enum Load { case asking, answered(Fleet.Members), failed(String) }
    @State private var load = Load.asking

    var body: some View {
        switch load {
        case .asking:
            Text("Loading…")
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
                .task { await reload() }
        case .failed(let why):
            VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                Text("Could not load the organization.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.bad)
                Text(why)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .textSelection(.enabled)
                Button("Try again") { Task { await reload() } }
                    .frame(minHeight: 44)
            }
            .padding(Design.Space.page)
        case .answered(let got):
            if let member = (got.members ?? []).first(where: { $0.id == id }) {
                MemberView(settings: settings, member: member, roster: got.members ?? [], you: got.you)
            } else {
                Text("\(id) is not a member of this organization any more.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .padding(Design.Space.page)
            }
        }
    }

    @MainActor
    private func reload() async {
        do {
            let got = try await Fleet(settings: settings).members()
            guard got.ok != false, got.members != nil else {
                load = .failed(got.text ?? "Your fleet did not send its members. It may need an update.")
                return
            }
            load = .answered(got)
        } catch {
            load = .failed(error.localizedDescription)
        }
    }
}

private func approvalsSectionHead(_ text: String) -> some View {
    Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
}
