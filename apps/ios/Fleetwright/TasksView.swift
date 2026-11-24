import SwiftUI

/// Tasks: work that outlives a session (docs/tasks.md).
///
/// A TASK IS A RECORD ABOVE SESSIONS: a title, a brief, one assignee, a
/// branch, the session that holds its lock, what came back, and every change
/// of hands. This screen is the fleet's list of them for this person, and the
/// fleet decides which those are: the ones they made, and the ones assigned
/// to a member they act for.
///
/// THE ONES THAT CAME BACK ARE FIRST, because those are asking a question:
/// accept this, or reopen it. With them come the ones waiting for a member
/// to be chosen (docs/routing.md), which ask one too. Then the ones being
/// worked on, then the open ones. Every row is the same shape, and what
/// state a task is in is said in words on its row; the ones asking also take
/// the attention colour, which the design system keeps for whatever is asking.
///
/// FINISHED TASKS ARE NOT ASKED FOR UNTIL SOMEBODY OPENS Finished. A fleet
/// keeps 500 tasks with their briefs and results, and a list that opened on
/// all of them would bury the three that need a person under everything
/// already settled. So the screen asks a state at a time, and says "No
/// unfinished tasks" when those three come back empty: it has not asked
/// about the finished ones and makes no claim about them (C-5).
///
/// The same words as Android (TasksScreen.kt), held equal by
/// test/tasks-in-apps.test.js.
struct TasksView: View {
    let settings: Settings

    private enum Load { case asking, answered, failed(String) }
    @State private var load = Load.asking
    /// The unfinished tasks, in the order they are drawn: returned, working, open.
    @State private var tasks: [Fleet.OrgTask] = []
    /// Everybody, for an assignee's name and for whom a new task may go to.
    /// Empty when the fleet did not say, and then a row shows the id.
    @State private var members: [Fleet.Member] = []
    @State private var you: Fleet.Members.Standing?
    @State private var finishedOpen = false
    private enum FinishedLoad { case notAsked, asking, answered([Fleet.OrgTask]), failed(String) }
    @State private var finished = FinishedLoad.notAsked
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                    Text("Could not load the tasks.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            case .answered:
                listSection
                finishedSection
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Tasks")
        .task { await reload() }
        .refreshable { await reload() }
        .onChange(of: finishedOpen) { _, now in
            if now { Task { await loadFinished() } }
        }
    }

    @ViewBuilder private var listSection: some View {
        Section {
            if tasks.isEmpty {
                Text("No unfinished tasks. New task makes one.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            ForEach(tasks) { task in
                NavigationLink {
                    page(task)
                } label: {
                    TaskRow(task: task, roster: members, me: taskMe(settings))
                }
            }
            NavigationLink("New task") {
                NewTaskView(settings: settings, members: members, you: you) {
                    Task { await reload() }
                }
            }
        }
    }

    /// Done and cancelled, behind one row, asked for when it is opened.
    @ViewBuilder private var finishedSection: some View {
        Section {
            DisclosureGroup("Finished", isExpanded: $finishedOpen) {
                switch finished {
                case .notAsked, .asking:
                    Text("Loading…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                case .failed(let why):
                    Text("Could not load the finished tasks.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(why)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await loadFinished() } }
                case .answered(let list):
                    if list.isEmpty {
                        Text("No finished tasks.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                    ForEach(list) { task in
                        NavigationLink {
                            page(task)
                        } label: {
                            TaskRow(task: task, roster: members, me: taskMe(settings))
                        }
                    }
                }
            }
        }
    }

    private func page(_ task: Fleet.OrgTask) -> TaskView {
        TaskView(settings: settings, id: task.id, initial: task, members: members, you: you) {
            Task { await reload() }
        }
    }

    @MainActor
    private func reload() async {
        let fleet = Fleet(settings: settings)
        do {
            var unfinished: [Fleet.OrgTask] = []
            // RETURNED, THEN WORKING, THEN OPEN: the order they are drawn in.
            // One state that did not answer fails the whole list, because
            // two thirds of a list drawn as the list would hide the tasks
            // that are waiting on somebody (C-5).
            for state in taskUnfinishedStates {
                let got = try await fleet.tasks(state: state)
                // Only an answer that carries the list is one: a fleet older
                // than tasks answers without it, and that is not "none".
                guard got.ok != false, let list = got.tasks else {
                    load = .failed(got.text ?? "Your fleet did not send its tasks. It may need an update.")
                    return
                }
                unfinished += list
            }
            // THE ONES ASKING SOMETHING COME FORWARD, in the order they were
            // asked for: what came back, then the open ones waiting for a
            // member to be chosen. The rest keep their order under them.
            let asking = unfinished.filter { taskAsks($0) }
            let rest = unfinished.filter { !taskAsks($0) }
            // A task that came back moves to the top, and one that was
            // accepted leaves. Under Reduce Motion it is simply there.
            withAnimation(Design.Motion.settle(reduceMotion)) { tasks = asking + rest }
            load = .answered
        } catch {
            load = .failed(error.localizedDescription)
            return
        }
        // NAMES ARE THE ORGANIZATION'S. Without them every row still says
        // whose it is, by id.
        if let org = try? await fleet.members(), org.ok != false {
            members = org.members ?? []
            you = org.you
        }
        if finishedOpen { await loadFinished() }
    }

    @MainActor
    private func loadFinished() async {
        if case .answered = finished {} else { finished = .asking }
        let fleet = Fleet(settings: settings)
        do {
            var list: [Fleet.OrgTask] = []
            for state in taskFinishedStates {
                let got = try await fleet.tasks(state: state)
                guard got.ok != false, let part = got.tasks else {
                    finished = .failed(got.text ?? "Your fleet did not send its tasks. It may need an update.")
                    return
                }
                list += part
            }
            finished = .answered(list)
        } catch {
            finished = .failed(error.localizedDescription)
        }
    }
}

/// One task in a list: the title, its id and whose it is, and its state in
/// words. Every row is this shape whatever the state, so a row that looks
/// different means something: the attention colour is on a task that is
/// asking (it came back, or it waits for a member to be chosen) and on
/// nothing else, and the words under it say the same thing to somebody who
/// cannot see the colour.
private struct TaskRow: View {
    let task: Fleet.OrgTask
    let roster: [Fleet.Member]
    /// This person's fleet address, so a question put to them says "you".
    var me = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            Text(task.title ?? task.id)
                .fleetType(.body)
                .foregroundStyle(Design.Palette.ink)
            Text(taskRowFacts(task, roster))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
            // A CHANGE OF STATE IS NEWS, and reads as a change: the words
            // crossfade, which is the one movement Reduce Motion keeps.
            Text(taskStateWords(task, me: me))
                .fleetType(.label)
                .foregroundStyle(taskAsks(task) ? Design.Palette.attention : Design.Palette.inkDim)
                .animation(Design.Motion.change, value: taskStateWords(task, me: me))
        }
        .frame(minHeight: 44)
    }
}

/// New task, and then that task's page in the same place.
///
/// The form becomes the page of the task it made, where it stands: going
/// back from there is the list, and never a filled form that would make the
/// same task twice.
struct NewTaskView: View {
    let settings: Settings
    let members: [Fleet.Member]
    let you: Fleet.Members.Standing?
    /// Told when a task was made or changed, so the list behind this asks again.
    var onChanged: () -> Void = {}

    @State private var made: Fleet.OrgTask?

    var body: some View {
        if let made {
            TaskView(settings: settings, id: made.id, initial: made, members: members, you: you, onChanged: onChanged)
        } else {
            TaskForm(settings: settings, existing: nil, members: members, you: you) { reply in
                withAnimation(Design.Motion.change) { made = reply.task }
                onChanged()
            }
        }
    }
}

/// One task: what it is, where it stands, and what this person may do next.
///
/// THE PAGE ASKS THE TASK'S OWN ROUTE THE MOMENT IT OPENS, whatever the list
/// handed it, because only that route says whether the task can be started
/// now (`start`) and Start is drawn from that answer and nothing else (C-2).
/// Opened from a session, it has only the id and asks for everything.
///
/// EVERY ACTION IS DRAWN ONLY WHERE THE FLEET WOULD TAKE IT (docs/tasks.md,
/// the table of changes): Start with something to sign, Reassign on an open
/// task nobody holds, Release with a lock to end, Accept on a task that came
/// back, Reopen on one that came back or is done, Cancel and Edit until it is
/// finished. A refusal is still possible, since somebody else can act first,
/// and then the fleet's own sentence is what the page shows.
///
/// HOW IT WAS ROUTED IS THE FLEET'S SENTENCE (docs/routing.md), under whose
/// it is. While the fleet waits for a person to say which member, the
/// members it is choosing among are buttons under the task's head, before
/// the brief, because that is the question the page is asking. Route it is
/// drawn only for an open task nobody holds, with no member, that is not
/// already waiting and whose own routing is not off.
///
/// WHAT A SESSION SAID IS SHOWN AS WHAT A SESSION SAID. The branch is what
/// sessions are told, never a link: nothing checks that it exists. The result
/// is the session's own account, and the page says so under it.
struct TaskView: View {
    let settings: Settings
    let id: String
    /// Told when the task changed, so the list behind this page asks again.
    var onChanged: () -> Void = {}

    /// The task as the fleet last sent it. Nil until it answers, when the
    /// page was opened with only an id, and after the fleet says there is no
    /// such task for this person.
    @State private var task: Fleet.OrgTask?
    /// What to sign to start a session on it, exactly as the fleet sent it.
    /// Nil when nobody can start it now, and until the fleet has answered.
    @State private var start: [String: String]?
    @State private var loadFailed: String?
    @State private var roster: [Fleet.Member]
    @State private var standing: Fleet.Members.Standing?
    /// The session that holds the lock, when this phone's own list has it.
    @State private var lockSession: Fleet.Session?
    @State private var hosts: [Fleet.FleetHost] = []
    @State private var busy = false
    @State private var result = ""
    @State private var failed = false
    @State private var startResult = ""
    @State private var startFailed = false
    /// A start your fleet refused at a budget or for want of approval
    /// (docs/budgets.md), and what was sent, so the same start can be sent
    /// again: the parameters as the fleet gave them, and the machine.
    @State private var refusedStart: RefusedStart?
    @State private var lastStart: (params: [String: String], host: String?)?
    /// Release and Cancel are each waiting on their question.
    @State private var confirmingRelease = false
    @State private var confirmingCancel = false

    init(settings: Settings, id: String, initial: Fleet.OrgTask? = nil, members: [Fleet.Member] = [],
         you: Fleet.Members.Standing? = nil, onChanged: @escaping () -> Void = {}) {
        self.settings = settings
        self.id = id
        self.onChanged = onChanged
        _task = State(initialValue: initial)
        _roster = State(initialValue: members)
        _standing = State(initialValue: you)
    }

    var body: some View {
        Form {
            if let task {
                headSection(task)
                // WHICH MEMBER, while the fleet waits for a person to say:
                // offered where Reassign is, on an open task nobody holds,
                // since an answer is an assignment by hand (C-2).
                if let route = task.route, route.how == "waiting", (task.assignee ?? "").isEmpty, task.lock == nil, task.state == "open" {
                    chooseSection(task, route)
                }
                if let brief = task.brief, !brief.isEmpty { briefSection(brief) }
                if let lock = task.lock { lockSection(lock) }
                if let returned = task.result { resultSection(returned) }
                // In the order it happened: the brief, what came back, and
                // then why that was not the end of it.
                if let note = task.note, !note.isEmpty { noteSection(note) }
                if task.state != "cancelled" || !result.isBlank { actionsSection(task) }
                if let handoffs = task.handoffs, !handoffs.isEmpty { historySection(handoffs) }
            } else if let loadFailed {
                Section {
                    Text("Could not load this task.")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.bad)
                    Text(loadFailed)
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .textSelection(.enabled)
                    Button("Try again") { Task { await reload() } }
                }
            } else {
                Section {
                    Text("Loading…")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Task \(id)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func headSection(_ task: Fleet.OrgTask) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Design.Space.hair) {
                Text(task.title ?? task.id)
                    .fleetType(.title)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                // THE STATE, IN WORDS, under the title and before anything
                // else. A change crossfades (Reduce Motion keeps that one).
                Text(taskStateWords(task, me: taskMe(settings)))
                    .fleetType(.body)
                    .foregroundStyle(taskAsks(task) ? Design.Palette.attention : Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .animation(Design.Motion.change, value: taskStateWords(task, me: taskMe(settings)))
            }
            .padding(.vertical, Design.Space.hair)
            LabeledContent("Assigned to") {
                Text(taskMemberName(task.assignee, roster) ?? "Nobody").fleetType(.label)
            }
            // HOW IT CAME TO BE WHOSE IT IS, or why it is nobody's: the
            // fleet's last routing decision, in the fleet's own sentence.
            // Stacked, because the sentence is long and wraps.
            if let route = task.route {
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text("Routing")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                    Text(routeWords(route, roster))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let kind = task.workType, !kind.isEmpty {
                LabeledContent("Kind of work") { Text(kind).fleetType(.label) }
            }
            if let parent = task.parent, !parent.isEmpty {
                LabeledContent("Delegated from") { Text(parent).fleetType(.label) }
            }
            // WHAT ITS SESSIONS ARE TOLD, never a link and never a fact: a
            // session's workspace is its own, and nothing looks for the
            // branch (docs/tasks.md, "The branch").
            if let branch = task.branch, !branch.isEmpty {
                Text(taskBranchLine(branch: branch, repo: task.repo))
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            // THE FLEET WAS NOT REACHED JUST NOW, so this is the task as the
            // list last had it, and the page says so instead of passing an
            // old record off as the present one (C-5).
            if let loadFailed {
                Text("Could not reach your fleet. This is the task as the list last had it.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.bad)
                    .fixedSize(horizontal: false, vertical: true)
                Text(loadFailed)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .textSelection(.enabled)
                Button("Try again") { Task { await reload() } }
            }
        }
    }

    /// Which member: the ones the fleet is choosing among, each a button
    /// with the member's name and its role under it, and Somebody else,
    /// which opens the Reassign picker for anybody the list does not have.
    ///
    /// A PRESS IS THE ANSWER. It is an assignment by hand, which Reassign
    /// can change again, so it asks nothing first. What the fleet says of it
    /// is the line where every action's answer is, and a refusal is its
    /// sentence there. The name takes the accent, which the design keeps
    /// for what can be pressed, so the row reads as a button and not a fact.
    @ViewBuilder private func chooseSection(_ task: Fleet.OrgTask, _ route: Fleet.OrgTask.Route) -> some View {
        Section {
            ForEach(route.candidates ?? [], id: \.self) { candidate in
                Button { sendRoute(member: candidate) } label: {
                    VStack(alignment: .leading, spacing: Design.Space.hair) {
                        Text(taskMemberName(candidate, roster) ?? candidate)
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.accent)
                        if let role = roster.first(where: { $0.id == candidate })?.role, !role.isEmpty {
                            Text(role)
                                .fleetType(.label)
                                .foregroundStyle(Design.Palette.inkDim)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .disabled(busy)
                .accessibilityHint("Gives this task to them")
            }
            NavigationLink("Somebody else") {
                TaskReassignView(settings: settings, task: task, members: roster, you: standing) { reply in
                    apply(reply)
                }
            }
            .disabled(busy)
        } header: {
            taskSectionHead("Choose a member")
        }
    }

    /// The brief, in a frame of its own that scrolls: 2400 bytes of it would
    /// otherwise push the result and every action off the screen.
    private func briefSection(_ brief: String) -> some View {
        Section {
            ScrollView {
                Text(brief)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 240)
        } header: {
            taskSectionHead("Brief")
        }
    }

    private func noteSection(_ note: String) -> some View {
        Section {
            Text(note)
                .fleetType(.label)
                .foregroundStyle(Design.Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } header: {
            taskSectionHead("Why it was reopened")
        } footer: {
            Text("The next session is told this.")
        }
    }

    /// The lock: which session holds the task, on which machine, since when
    /// and started by whom.
    ///
    /// A MACHINE THAT IS NOT CONNECTED IS CANNOT TELL, which the page says as
    /// "unknown" (docs/design-system.md, Words) and keeps the lock: the fleet
    /// does, too, and Release is how a person overrides it. Back at its prompt with no result is said
    /// as that, and never as a result.
    @ViewBuilder private func lockSection(_ lock: Fleet.OrgTask.Lock) -> some View {
        Section {
            if let name = lock.session, !name.isEmpty {
                // THE SESSION'S OWN PAGE, when this phone's list has the
                // session. The fleet lists a person only what they may see,
                // so a session it left out is named here and opens nothing.
                if let session = lockSession {
                    NavigationLink {
                        SessionView(fleet: Fleet(settings: settings), initial: session,
                                    resumeKept: hosts.first { $0.hostId == session.hostId }?.resumeKept,
                                    opensPorts: hosts.first { $0.hostId == session.hostId }?.opensSessionPorts == true)
                            .id(session.id)
                    } label: {
                        Text(taskSessionPlace(session: name, host: lock.hostId))
                            .fleetType(.body)
                            .foregroundStyle(Design.Palette.ink)
                            .frame(minHeight: 44)
                    }
                } else {
                    Text(taskSessionPlace(session: name, host: lock.hostId))
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                }
            } else {
                Text("A session is starting on \(lock.hostId ?? "a machine"). The machine has not answered yet.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let since = taskLockSince(lock) {
                Text(since)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if lock.connected == false {
                Text("\(lock.hostId ?? "Its machine") is not connected, so whether the session is still working is unknown.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if lock.readyAt != nil {
                Text("The session is back at its prompt and wrote no result.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // WHY IT STOPPED, when its engine said and the turn did not
            // simply end (docs/engines.md): at a limit with no engine left,
            // say, which is why the task has not come back.
            if let stopped = lock.stopped,
               let why = engineTurnWords(engine: stopped.engine, reason: stopped.reason, resetsAt: stopped.resetsAt) {
                Text(why)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            taskSectionHead("Session")
        }
    }

    /// What came back, as the session wrote it.
    private func resultSection(_ returned: Fleet.OrgTask.Returned) -> some View {
        Section {
            Text(taskOutcomeWord(returned.outcome))
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
            ScrollView {
                Text(returned.summary ?? "")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 320)
            if returned.truncated == true {
                Text("Cut at 4000 bytes. The rest is in RESULT.md in the session's workspace.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let from = taskResultFrom(returned) {
                Text(from)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            taskSectionHead("Result")
        } footer: {
            Text("This is the session's own account. Nothing checked it.")
        }
    }

    @ViewBuilder private func actionsSection(_ task: Fleet.OrgTask) -> some View {
        Section {
            // START, only with something to sign: the fleet sends `start`
            // when the task is open, assigned and unlocked, and nil otherwise.
            if let start {
                NavigationLink("Start a session") {
                    TaskStartView(settings: settings, taskId: task.id, start: start,
                                  assigneeName: taskMemberName(start["member"], roster) ?? "its assignee") { host in
                        startSession(start, host: host)
                    }
                }
                .disabled(busy)
            }
            // A START THAT WAITS FOR APPROVAL, OR STOPPED AT A BUDGET: the
            // fleet's sentence, and what can be done about it from here
            // (RefusedStartView). Any other answer is the line it always was.
            if let refusedStart, let lastStart {
                RefusedStartView(settings: settings, refused: refusedStart) {
                    startSession(lastStart.params, host: lastStart.host)
                }
            } else if !startResult.isBlank {
                Text(startResult)
                    .fleetType(.label)
                    .foregroundStyle(startFailed ? Design.Palette.bad : Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            // REASSIGN, only on an open task nobody holds: work in flight
            // is released or comes back first.
            if task.lock == nil, task.state == "open" {
                NavigationLink("Reassign") {
                    TaskReassignView(settings: settings, task: task, members: roster, you: standing) { reply in
                        apply(reply)
                    }
                }
                .disabled(busy)
            }
            // ROUTE IT, only where the fleet would route one: an open task
            // nobody holds, with no member, that is not already waiting on
            // a person, and whose own routing is not off, which the fleet
            // refuses whatever its setting is. Edit is where that is turned
            // back on. Whether the fleet's own routing is on is its to say.
            if task.lock == nil, task.state == "open", (task.assignee ?? "").isEmpty, task.route?.how != "waiting", task.routing != "off" {
                Button("Route it") { sendRoute(member: nil) }
                    .disabled(busy)
                    .frame(minHeight: 44)
            }
            // ACCEPT is a person's judgement of a result, so it is offered
            // only where there is one waiting.
            if task.state == "returned" {
                Button("Accept the result") { act("accept") }
                    .disabled(busy)
                    .frame(minHeight: 44)
            }
            if task.state == "returned" || task.state == "done" {
                NavigationLink("Reopen") {
                    TaskReopenView(settings: settings, taskId: task.id) { reply in
                        apply(reply)
                    }
                }
                .disabled(busy)
            }
            // RELEASE ASKS FIRST, and says what it does not do: the lock
            // ends, the session carries on until somebody stops it.
            if task.lock != nil {
                Button("Release") { confirmingRelease = true }
                    .disabled(busy)
                    .frame(minHeight: 44)
                    .confirmationDialog("Release \(task.id)?", isPresented: $confirmingRelease, titleVisibility: .visible) {
                        Button("Release") { act("release") }
                    } message: {
                        Text("Ends the lock, so another session can be started on it. This does not stop the session that holds it.")
                    }
            }
            if task.state != "done", task.state != "cancelled" {
                NavigationLink("Edit") {
                    TaskForm(settings: settings, existing: task, members: roster, you: standing) { reply in
                        apply(reply)
                    }
                }
                .disabled(busy)
                // CANCEL ASKS FIRST. Its own dismissal is "Keep it", since a
                // sheet offering Cancel task beside Cancel says nothing.
                Button("Cancel task", role: .destructive) { confirmingCancel = true }
                    .disabled(busy)
                    .frame(minHeight: 44)
                    .confirmationDialog("Cancel \(task.id)?", isPresented: $confirmingCancel, titleVisibility: .visible) {
                        Button("Cancel task", role: .destructive) { act("cancel") }
                        Button("Keep it", role: .cancel) {}
                    } message: {
                        Text("Closes the task. A session still working on it is not stopped.")
                    }
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

    /// Every change of hands, oldest first, each a sentence with when and who.
    private func historySection(_ handoffs: [Fleet.OrgTask.Handoff]) -> some View {
        Section {
            ForEach(handoffs.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text(taskHandoffWords(handoffs[index], roster))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(taskHandoffWho(handoffs[index]))
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            taskSectionHead("History")
        }
    }

    @MainActor
    private func reload() async {
        let fleet = Fleet(settings: settings)
        do {
            let got = try await fleet.task(id: id)
            // THE FLEET SAYS THERE IS NO SUCH TASK FOR THIS PERSON, in its
            // own sentence. Whatever the list handed this page is dropped
            // with it: a task somebody may not see is not drawn from memory.
            guard got.ok != false, let now = got.task else {
                task = nil
                start = nil
                loadFailed = got.text ?? "Your fleet did not send this task. It may need an update."
                return
            }
            withAnimation(Design.Motion.change) { task = now }
            start = got.start
            loadFailed = nil
        } catch {
            // NOT REACHED. What the list had stays, said as that, and Start
            // goes: it is drawn only from an answer.
            start = nil
            loadFailed = error.localizedDescription
            return
        }
        if standing == nil, let org = try? await fleet.members(), org.ok != false {
            roster = org.members ?? []
            standing = org.you
        }
        await findLockSession()
    }

    /// Whether this phone can open the session that holds the lock: only if
    /// the fleet lists that session, on that machine, for this person.
    @MainActor
    private func findLockSession() async {
        guard let lock = task?.lock, let name = lock.session, !name.isEmpty else {
            lockSession = nil
            return
        }
        let fleet = Fleet(settings: settings)
        let listed = (try? await fleet.list())?.sessions ?? []
        lockSession = listed.first { $0.name == name && $0.hostId == lock.hostId }
        // What the session's page reads off its machine: whether Resume is
        // kept from it, and whether its ports open here.
        if lockSession != nil, hosts.isEmpty {
            hosts = (try? await fleet.fleetHosts()) ?? []
        }
    }

    /// What the fleet answered a change with. Its sentence is the line on the
    /// page either way, and a refusal's is all there is: the page adds
    /// nothing of its own to an answer that came.
    @MainActor
    private func apply(_ reply: Fleet.TaskReply) {
        failed = reply.ok != true
        result = reply.text ?? (reply.ok == true ? "Saved." : "Your fleet refused that.")
        guard reply.ok == true, let now = reply.task else { return }
        withAnimation(Design.Motion.change) { task = now }
        start = reply.start
        startResult = ""
        refusedStart = nil
        onChanged()
        Task { await findLockSession() }
    }

    /// Release, accept or cancel, and show what the fleet said.
    private func act(_ action: String) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                apply(try await Fleet(settings: settings).actOnTask(id: id, action: action))
            } catch {
                failed = true
                result = error.localizedDescription
            }
        }
    }

    /// Ask for the task to be routed now, or, with a member, answer which
    /// one it goes to. Either way what the fleet said is the page's line.
    private func sendRoute(member: String?) {
        Task { @MainActor in
            busy = true
            result = ""
            defer { busy = false }
            do {
                apply(try await Fleet(settings: settings).routeTask(id: id, member: member))
            } catch {
                failed = true
                result = error.localizedDescription
            }
        }
    }

    /// Sign and send the start the fleet described, with the machine chosen
    /// beside it. The page it was confirmed on has closed by now and nobody
    /// waits: the answer is a line on this page and a notification, as it is
    /// from a member's page.
    private func startSession(_ params: [String: String], host: String?) {
        startResult = "Starting a session on \(id). You will get a notification when it is ready."
        startFailed = false
        refusedStart = nil
        lastStart = (params: params, host: host)
        Task {
            do {
                let reply = try await Fleet(settings: settings).startOnTask(params, host: host)
                let text = reply.text ?? "Started."
                let refused = reply.ok == false
                await MainActor.run {
                    startResult = text
                    startFailed = refused
                    refusedStart = RefusedStart(reply)
                }
                LocalNotice.post(title: refused ? reply.refusedStartTitle : "Session ready", body: text)
            } catch {
                // A timeout is not a failure: the start carries an id the
                // fleet honours, so the session may well exist.
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                let text = timedOut ? "Not sure it started. Look under Sessions." : error.localizedDescription
                await MainActor.run {
                    startResult = text
                    startFailed = !timedOut
                }
                LocalNotice.post(title: timedOut ? "Session may be starting" : "Could not start a session", body: text)
            }
            // The lock, or its absence, is the fleet's to say.
            await reload()
            await MainActor.run { onChanged() }
        }
    }
}

/// What a session on this task will be told, shown before it is signed.
///
/// THE WORDS ARE THE FLEET'S AND THE PHONE SIGNS EXACTLY THEM (docs/tasks.md,
/// "Starting on a task"). So they are on the screen first, whole, and the
/// button under them says what pressing it does. Where it runs is a choice
/// beside the start, never part of what is signed, and is asked only when
/// there is more than one machine to choose from.
struct TaskStartView: View {
    let settings: Settings
    let taskId: String
    /// `start`'s own parameters, as the fleet sent them.
    let start: [String: String]
    let assigneeName: String
    /// Sends the start: the machine chosen, or nil for wherever fits.
    let onStart: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var hosts: [String] = []
    @State private var host = ""

    var body: some View {
        Form {
            Section {
                ScrollView {
                    Text(start["task"] ?? "")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 320)
            } header: {
                taskSectionHead("What the session is told")
            } footer: {
                Text("Your phone signs these words. The session gets them after \(assigneeName)'s instructions.")
            }

            Section {
                LabeledContent("As") { Text(assigneeName).fleetType(.label) }
                if let branch = start["taskBranch"], !branch.isEmpty {
                    Text(taskBranchLine(branch: branch, repo: start["taskRepo"]))
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("Runs on \(assigneeName)'s sign-ins, on a machine its custodians approved.")
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Only when there is a choice to make. One machine is not a
            // decision, and a picker with one entry is furniture.
            if hosts.count > 1 {
                Section {
                    Picker("Machine", selection: $host) {
                        Text("Wherever fits").tag("")
                        ForEach(hosts, id: \.self) { h in Text(h).tag(h) }
                    }
                }
            }

            Section {
                Button("Sign and start") {
                    onStart(host.isEmpty ? nil : host)
                    dismiss()
                }
                .disabled(!settings.configured)
                .frame(minHeight: 44)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Start \(taskId)")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Only the machines a start would reach, as New session offers
            // them: none offline, none degraded, never a pool's own machine.
            hosts = ((try? await Fleet(settings: settings).fleetHosts()) ?? [])
                .filter { $0.holder != true && ($0.takesSessions ?? ($0.state == "healthy")) }
                .map(\.hostId)
        }
    }
}

/// Hand an open task to somebody else, or to nobody, with a note for the
/// record. A reassignment is a change of hands and the task's history keeps
/// it, with who did it and what they wrote.
///
/// WHO IS OFFERED IS WHO THE FLEET WILL TAKE from this person (C-2): the
/// members they manage and the ones they may start a session as, and Nobody.
struct TaskReassignView: View {
    let settings: Settings
    let task: Fleet.OrgTask
    let members: [Fleet.Member]
    let you: Fleet.Members.Standing?
    let onDone: (Fleet.TaskReply) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var assignee: String
    @State private var note = ""
    @State private var busy = false
    @State private var result = ""

    init(settings: Settings, task: Fleet.OrgTask, members: [Fleet.Member], you: Fleet.Members.Standing?,
         onDone: @escaping (Fleet.TaskReply) -> Void) {
        self.settings = settings
        self.task = task
        self.members = members
        self.you = you
        self.onDone = onDone
        _assignee = State(initialValue: task.assignee ?? "")
    }

    private var noteBytes: Int { taskBytes(note.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        Form {
            Section {
                choice(id: "", name: "Nobody", role: nil)
                ForEach(taskAssignable(members, you)) { member in
                    choice(id: member.id, name: member.name, role: member.role)
                }
            } header: {
                taskSectionHead("Assign to")
            }

            Section {
                TextField("Why, for the task's history", text: $note, axis: .vertical)
                    .lineLimit(2...5)
                    .accessibilityLabel("Note")
                if let line = taskCountLine(noteBytes, limit: taskNoteLimit, unit: "bytes") {
                    countLine(line, over: noteBytes > taskNoteLimit)
                }
            } header: {
                taskSectionHead("Note")
            }

            Section {
                Button(busy ? "Reassigning…" : "Reassign") { Task { await send() } }
                    .disabled(busy || assignee == (task.assignee ?? "") || noteBytes > taskNoteLimit)
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
        .navigationTitle("Reassign \(task.id)")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// One choice of several: the name, the role under it, and a mark on the
    /// one chosen, said to VoiceOver as well as drawn.
    private func choice(id: String, name: String, role: String?) -> some View {
        Button { assignee = id } label: {
            HStack(spacing: Design.Space.insideTight) {
                VStack(alignment: .leading, spacing: Design.Space.hair) {
                    Text(name)
                        .fleetType(.body)
                        .foregroundStyle(Design.Palette.ink)
                    if let role, !role.isEmpty {
                        Text(role)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                    }
                }
                Spacer(minLength: 0)
                if assignee == id {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Design.Palette.accent)
                        .accessibilityLabel("Chosen")
                }
            }
            .contentShape(Rectangle())
            .frame(minHeight: 44)
        }
    }

    @MainActor
    private func send() async {
        busy = true
        defer { busy = false }
        result = ""
        // An empty assignee is nobody, which the fleet reads as that.
        var fields: [String: Any] = ["assignee": assignee]
        let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !said.isEmpty { fields["note"] = said }
        do {
            let reply = try await Fleet(settings: settings).changeTask(id: task.id, fields: fields)
            if reply.ok == true {
                onDone(reply)
                dismiss()
            } else {
                result = reply.text ?? "Your fleet refused that."
            }
        } catch {
            result = error.localizedDescription
        }
    }
}

/// Reopen a task that came back or is done, and say why.
///
/// THE NOTE IS NOT OPTIONAL, because it is not for the record: it is what
/// the next session is told, after the brief. A task reopened without one
/// would send that session back to the same brief with no idea what was
/// wrong the first time. So the button waits for a note, and nothing is sent
/// without one.
struct TaskReopenView: View {
    let settings: Settings
    let taskId: String
    let onDone: (Fleet.TaskReply) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var busy = false
    @State private var result = ""

    private var noteBytes: Int { taskBytes(note.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        Form {
            Section {
                TextField("What is wrong, or what is left", text: $note, axis: .vertical)
                    .lineLimit(3...8)
                    .accessibilityLabel("Note")
                if let line = taskCountLine(noteBytes, limit: taskNoteLimit, unit: "bytes") {
                    countLine(line, over: noteBytes > taskNoteLimit)
                }
            } header: {
                taskSectionHead("Note")
            } footer: {
                Text("Say why. The note is what the next session is told.")
            }

            Section {
                Button(busy ? "Reopening…" : "Reopen") { Task { await send() } }
                    .disabled(busy || note.isBlank || noteBytes > taskNoteLimit)
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
        .navigationTitle("Reopen \(taskId)")
        .navigationBarTitleDisplayMode(.inline)
    }

    @MainActor
    private func send() async {
        let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
        // NEVER WITHOUT A NOTE, whatever called this.
        guard !said.isEmpty else { return }
        busy = true
        defer { busy = false }
        result = ""
        do {
            let reply = try await Fleet(settings: settings).actOnTask(id: taskId, action: "reopen", note: said)
            if reply.ok == true {
                onDone(reply)
                dismiss()
            } else {
                result = reply.text ?? "Your fleet refused that."
            }
        } catch {
            result = error.localizedDescription
        }
    }
}

/// Make a task, or change what one says.
///
/// THE BRIEF IS ALL THE SESSION GETS, and it is short on purpose: 2400 bytes,
/// counted as the fleet counts them, in UTF-8. The count is said once it
/// matters, from four fifths of the limit, and Save waits while a field is
/// over: a brief the fleet would refuse is not sent to find that out.
///
/// WHOSE IT IS, when it is made, is chosen from the members this person may
/// hand work to, or Nobody, or left to the fleet (docs/routing.md). After
/// that it changes hands under Reassign, which is refused while a session
/// holds the task, so Edit does not offer it.
///
/// LET THE FLEET CHOOSE asks how, once it is picked: as the fleet is set,
/// which sends nothing about routing, or this task's own mode. Edit has the
/// task's own mode as a choice of its own, with Off beside the other two.
///
/// NOBODY MEANS NOBODY. A fleet whose routing is on routes every task made
/// with no member, so a task made for Nobody is sent with its own routing
/// off, which holds whatever the fleet is set to, and the form says what
/// that means under the choice.
struct TaskForm: View {
    let settings: Settings
    let existing: Fleet.OrgTask?
    let members: [Fleet.Member]
    let you: Fleet.Members.Standing?
    let onSaved: (Fleet.TaskReply) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var brief: String
    @State private var assignee = ""
    /// The task's own routing mode, or empty to follow the fleet's setting.
    @State private var routing: String
    @State private var repo: String
    @State private var workType: String
    @State private var busy = false
    @State private var result = ""

    init(settings: Settings, existing: Fleet.OrgTask?, members: [Fleet.Member], you: Fleet.Members.Standing?,
         onSaved: @escaping (Fleet.TaskReply) -> Void) {
        self.settings = settings
        self.existing = existing
        self.members = members
        self.you = you
        self.onSaved = onSaved
        _title = State(initialValue: existing?.title ?? "")
        _brief = State(initialValue: existing?.brief ?? "")
        _repo = State(initialValue: existing?.repo ?? "")
        _workType = State(initialValue: existing?.workType ?? "")
        _routing = State(initialValue: existing?.routing ?? "")
    }

    private var creating: Bool { existing == nil }
    /// Counted as the fleet counts: a title in characters, a brief in bytes.
    private var titleCount: Int { title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count }
    private var briefBytes: Int { taskBytes(brief.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        Form {
            Section {
                TextField("One line that says what it is", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .accessibilityLabel("Title")
                if let line = taskCountLine(titleCount, limit: taskTitleLimit, unit: "characters") {
                    countLine(line, over: titleCount > taskTitleLimit)
                }
            } header: {
                taskSectionHead("Title")
            }

            Section {
                TextField("What to do, where, and what to bring back", text: $brief, axis: .vertical)
                    .lineLimit(5...14)
                    .accessibilityLabel("Brief")
                if let line = taskCountLine(briefBytes, limit: taskBriefLimit, unit: "bytes") {
                    countLine(line, over: briefBytes > taskBriefLimit)
                }
            } header: {
                taskSectionHead("Brief")
            } footer: {
                Text("It is all the session gets.")
            }

            if creating {
                Section {
                    Picker("Assignee", selection: $assignee) {
                        Text("Nobody").tag("")
                        Text("Let the fleet choose").tag(taskFleetChooses)
                        ForEach(taskAssignable(members, you)) { member in
                            Text(member.name).tag(member.id)
                        }
                    }
                    // WHAT NOBODY MEANS, while it is the choice: the task is
                    // sent with its own routing off.
                    if assignee.isEmpty {
                        Text("It stays with nobody until somebody assigns it or changes its routing.")
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // HOW, only once the fleet is to choose. Off is not
                    // here: a task nobody is to be chosen for is Nobody.
                    if assignee == taskFleetChooses {
                        Picker("How", selection: $routing) {
                            Text(routingAsFleet).tag("")
                            Text(routingModeName("manual")).tag("manual")
                            Text(routingModeName("auto")).tag("auto")
                        }
                    }
                }
            } else {
                // THE TASK'S OWN MODE, which holds for this task whatever
                // the fleet's is. Changing it routes nothing by itself.
                Section {
                    Picker("Routing", selection: $routing) {
                        Text(routingAsFleet).tag("")
                        ForEach(routingModes, id: \.self) { mode in
                            Text(routingModeName(mode)).tag(mode)
                        }
                        // A mode from a newer fleet stays what it is (C-5).
                        if !routing.isEmpty, !routingModes.contains(routing) {
                            Text(routing).tag(routing)
                        }
                    }
                } footer: {
                    Text("This task’s own setting, used when it is routed.")
                }
            }

            Section {
                LabeledContent("Repository") {
                    TextField("owner/repo", text: $repo)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("Kind of work") {
                    TextField("Optional", text: $workType)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } footer: {
                Text("Both optional. A kind of work is a short word, like backend or review.")
            }

            Section {
                Button(busy ? "Saving…" : (creating ? "Make the task" : "Save")) { Task { await save() } }
                    .disabled(busy || title.isBlank || brief.isBlank || titleCount > taskTitleLimit || briefBytes > taskBriefLimit)
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
        .navigationTitle(existing.map { "Edit \($0.id)" } ?? "New task")
        .navigationBarTitleDisplayMode(.inline)
    }

    @MainActor
    private func save() async {
        busy = true
        defer { busy = false }
        result = ""
        var fields: [String: Any] = [
            "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
            "brief": brief.trimmingCharacters(in: .whitespacesAndNewlines),
            // Sent empty as well as filled: on a change, empty is how a
            // repository or a kind of work is taken off again.
            "repo": repo.trimmingCharacters(in: .whitespacesAndNewlines),
            "workType": workType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
        ]
        do {
            let fleet = Fleet(settings: settings)
            let reply: Fleet.TaskReply
            if let existing {
                // Sent empty as well as set: empty is how a task follows
                // the fleet's setting again.
                fields["routing"] = routing
                reply = try await fleet.changeTask(id: existing.id, fields: fields)
            } else {
                // WHAT IS SENT ABOUT ROUTING, by whose it is to be. The
                // fleet choosing: the mode that was named, and nothing for
                // "As your fleet is set". Nobody: off, always, so the task
                // stays with nobody on a fleet whose routing is on; a fleet
                // from before routing passes the field over. A member: the
                // member, and no mode.
                if assignee == taskFleetChooses {
                    if !routing.isEmpty { fields["routing"] = routing }
                } else if assignee.isEmpty {
                    fields["routing"] = "off"
                } else {
                    fields["assignee"] = assignee
                }
                reply = try await fleet.createTask(fields: fields)
            }
            if reply.ok == true, reply.task != nil {
                onSaved(reply)
                // A changed task goes back to its page. A new one has no
                // page behind this form: NewTaskView becomes it.
                if !creating { dismiss() }
            } else {
                result = reply.text ?? "Your fleet refused that."
            }
        } catch {
            result = error.localizedDescription
        }
    }
}

private func taskSectionHead(_ text: String) -> some View {
    Text(text).fleetType(.section).foregroundStyle(Design.Palette.ink).textCase(nil)
}

/// A field's count, once it is worth saying. Over the limit it takes the
/// error colour, and the line itself says how far over: never the colour alone.
private func countLine(_ line: String, over: Bool) -> some View {
    Text(line)
        .fleetType(.micro)
        .foregroundStyle(over ? Design.Palette.bad : Design.Palette.inkDim)
}

/// The states the Tasks screen opens on, in the order it draws them, and the
/// two it asks for only under Finished.
let taskUnfinishedStates = ["returned", "working", "open"]
let taskFinishedStates = ["done", "cancelled"]

/// What the fleet takes of each field (src/fleet/protocol/tasks.js): a title
/// in characters, a brief and a note in bytes of UTF-8. The same numbers as
/// Android, held to the fleet's by test/tasks-in-apps.test.js.
let taskTitleLimit = 120
let taskBriefLimit = 2400
let taskNoteLimit = 300

/// A text's size as the fleet measures a brief and a note: bytes of UTF-8.
func taskBytes(_ text: String) -> Int { text.utf8.count }

/// The count under a field, or nil while there is room to spare: it is said
/// from four fifths of the limit, and past the limit it says by how much.
func taskCountLine(_ count: Int, limit: Int, unit: String) -> String? {
    guard count * 5 >= limit * 4 else { return nil }
    if count > limit { return "\(count) of \(limit) \(unit), \(count - limit) too many" }
    return "\(count) of \(limit) \(unit)"
}

/// A task's state, in words. The same sentences on both phones.
///
/// AN OUTCOME OR A STATE THIS BUILD HAS NEVER MET IS SHOWN AS ITSELF, and a
/// task that came back with no result attached says only that it came back:
/// nothing is put in the place of an answer the fleet did not send (C-5).
///
/// A TASK WAITING FOR A MEMBER TO BE CHOSEN says who is being asked: "you",
/// when the fleet asked this person (`me`, their fleet address), and nobody
/// by name otherwise, since anybody who could assign it can answer.
func taskStateWords(_ task: Fleet.OrgTask, me: String = "") -> String {
    switch task.state {
    case "returned":
        switch task.result?.outcome {
        case .some("done"): return "Came back: done"
        case .some("blocked"): return "Came back: blocked"
        case .some("failed"): return "Came back: failed"
        case .some("unstated"): return "Came back, outcome not stated"
        case .some(let other): return "Came back: \(other)"
        case .none: return "Came back"
        }
    case "working":
        guard let session = task.lock?.session, !session.isEmpty, let host = task.lock?.hostId, !host.isEmpty else { return "Working" }
        return "Working, \(session) on \(host)"
    case "open":
        // A start has been sent and its machine has not answered yet.
        if let host = task.lock?.hostId, !host.isEmpty { return "Open, a session is starting on \(host)" }
        if taskWaitsForMember(task) {
            let asked = (task.route?.asked ?? "").lowercased()
            if !me.isEmpty, asked == me { return "Open, waiting for you to choose a member" }
            return "Open, waiting for a member to be chosen"
        }
        if (task.assignee ?? "").isEmpty { return "Open, assigned to nobody" }
        return "Open"
    case "done": return "Done"
    case "cancelled": return "Cancelled"
    default: return task.state
    }
}

/// What a result's first line said of the work, as a word. The session
/// wrote it; "Outcome not stated" is a first line that began with none of
/// DONE, BLOCKED or FAILED.
func taskOutcomeWord(_ outcome: String?) -> String {
    switch outcome {
    case .some("done"): return "Done"
    case .some("blocked"): return "Blocked"
    case .some("failed"): return "Failed"
    case .some("unstated"): return "Outcome not stated"
    case .some(let other): return other
    case .none: return "Outcome not sent"
    }
}

/// A member's name for an id: the name the organization gives it, the id
/// itself where the list does not have it, and nil for nobody. A name is
/// never made up for an id this phone cannot place (C-5).
func taskMemberName(_ id: String?, _ roster: [Fleet.Member]) -> String? {
    guard let id, !id.isEmpty else { return nil }
    return roster.first { $0.id == id }?.name ?? id
}

/// The line under a row's title: the task's id, and whose it is.
func taskRowFacts(_ task: Fleet.OrgTask, _ roster: [Fleet.Member]) -> String {
    guard let name = taskMemberName(task.assignee, roster) else { return task.id }
    return "\(task.id) · \(name)"
}

/// The branch, said as what its sessions are told.
func taskBranchLine(branch: String, repo: String?) -> String {
    let place = (repo ?? "").isEmpty ? "" : " in " + (repo ?? "")
    return "Sessions are told to work on \(branch)\(place); nothing checks that it exists."
}

/// "cc-x on deb132", or as much of it as there is.
func taskSessionPlace(session: String?, host: String?) -> String {
    let name = session ?? ""
    let machine = host ?? ""
    if name.isEmpty { return machine }
    if machine.isEmpty { return name }
    return "\(name) on \(machine)"
}

/// A time the fleet sent, as a date and a time, or nil when it sent none.
func taskTime(_ at: Double?) -> String? {
    guard let at, at > 0 else { return nil }
    return Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened)
}

/// Since when the lock has been held, and who started it.
func taskLockSince(_ lock: Fleet.OrgTask.Lock) -> String? {
    let by = lock.by ?? ""
    guard let since = taskTime(lock.at) else { return by.isEmpty ? nil : "Started by \(by)." }
    return by.isEmpty ? "Since \(since)." : "Since \(since), started by \(by)."
}

/// Which session a result came from, and when.
func taskResultFrom(_ returned: Fleet.OrgTask.Returned) -> String? {
    let place = taskSessionPlace(session: returned.session, host: returned.hostId)
    let when = taskTime(returned.at) ?? ""
    if place.isEmpty { return when.isEmpty ? nil : when }
    return when.isEmpty ? "From \(place)" : "From \(place), \(when)"
}

/// One change of hands as a sentence. Who did it and when are the line under
/// it (taskHandoffWho). A kind this build has never met is shown as itself.
func taskHandoffWords(_ handoff: Fleet.OrgTask.Handoff, _ roster: [Fleet.Member]) -> String {
    let to = taskMemberName(handoff.to, roster) ?? "nobody"
    let from = taskMemberName(handoff.from, roster) ?? "nobody"
    let said = handoff.note ?? ""
    let note = said.isEmpty ? "" : ": " + said
    let place = taskSessionPlace(session: handoff.session, host: handoff.hostId)
    let fromPlace = place.isEmpty ? "" : " from " + place
    switch handoff.kind ?? "" {
    case "created":
        let parent = handoff.task ?? ""
        return "Made, assigned to \(to)" + (parent.isEmpty ? "" : ", delegated from " + parent)
    case "assigned": return "Reassigned from \(from) to \(to)\(note)"
    case "started": return place.isEmpty ? "A session started as \(to)" : "\(place) started as \(to)"
    // The note on a return is the outcome the result's first line gave.
    case "returned": return "Came back\(fromPlace)" + (said.isEmpty ? "" : ": " + taskOutcomeWord(said).lowercased())
    case "released": return "Released\(fromPlace)\(note)"
    case "accepted": return "Accepted\(note)"
    case "reopened": return "Reopened\(note)"
    case "cancelled": return "Cancelled\(note)"
    case "delegated": return "Delegated \(handoff.task ?? "a task") to \(to)"
    // Its session moved to the member's next engine: here `from` and `to`
    // are engines and the note is why the first one stopped.
    case "engine": return engineMoveWords(from: handoff.from, to: handoff.to, reason: handoff.note)
    // A routing decision: the note is how it was decided, and `to` is whom
    // it chose, when it chose somebody (docs/routing.md).
    case "routed": return routedHandoffWords(how: handoff.note, to: taskMemberName(handoff.to, roster))
    default: return handoff.kind ?? "A change with no name"
    }
}

/// When a change of hands happened and who made it.
func taskHandoffWho(_ handoff: Fleet.OrgTask.Handoff) -> String {
    [taskTime(handoff.at), handoff.by].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
}

/// Whom this person may hand a task to: the members they manage and the
/// ones they may start a session as, in the organization's order. The fleet
/// refuses anybody else, so nobody else is offered (C-2).
func taskAssignable(_ members: [Fleet.Member], _ you: Fleet.Members.Standing?) -> [Fleet.Member] {
    let allowed = Set((you?.manages ?? []) + (you?.startAs ?? []))
    return members.filter { allowed.contains($0.id) }
}

/// The name a notification gives a task's page among the pages under You:
/// "task:t12".
let taskPagePrefix = "task:"

/// The task a page name asks for, or nil when it names something else.
///
/// THE ID CAME FROM A NOTIFICATION'S PAYLOAD and ends up in a request's
/// path, so it is held to what a task's id is: a few letters and digits,
/// and nothing that could name another path.
func taskPageId(_ page: String) -> String? {
    guard page.hasPrefix(taskPagePrefix) else { return nil }
    let id = String(page.dropFirst(taskPagePrefix.count))
    guard !id.isEmpty, id.count <= 24, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
    return id
}

/// This person's fleet address, as the fleet writes whom it asked.
func taskMe(_ settings: Settings) -> String {
    settings.signedInAs.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

/// The row under You: how many tasks have come back and are waiting on
/// somebody. Nil when none have, and then the row says nothing beside its
/// name: calm recedes.
func describeTasks(returned: Int) -> String? {
    returned == 0 ? nil : "\(returned) came back"
}
