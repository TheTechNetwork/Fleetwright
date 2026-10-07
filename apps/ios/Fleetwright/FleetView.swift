import AppIntents
import AuthenticationServices
import SwiftUI
import UIKit

/// The whole app: what is running, and the three things you would want to do
/// about it from a phone.
///
/// Every action is an intent to the coordinator. The app never talks to a host
/// directly, so it never has to know which box holds which session — that is
/// exactly what the coordinator is for.
/// The app, as three places rather than one screen with a sheet on top.
///
/// It was a session list with everything else behind a Settings button: hosts,
/// pins, fleet health, credentials, people, shortcuts, devices and the server
/// URL, in one scroll five hundred lines long. Then it was three tabs, two of
/// which were the same settings form filtered by a flag, so one-time setup
/// (the coordinator, the runner repository, the minter key, runner tokens)
/// sat permanently between a person and the machine list they came to read.
///
/// Three places, one job each, the same three on both phones:
///
///   Sessions   what is running, and answering what is asking
///   Machines   is each machine well, and doing something about one
///   You        who you are here, what your sessions may use, and setup
///
/// Setup that is finished takes one row; the screens opened because something
/// is wrong carry none of it.
///
/// The tab bar is iOS 26's, which means it floats over the content, adopts the
/// glass material, and MINIMISES ON SCROLL — the list is what somebody came
/// for, so the navigation gets out of the way as soon as they start reading.
struct FleetApp: View {
    let settings: Settings

    /// Which tab is showing. Held here so an unconfigured app can open on
    /// You, where the fleet's address and the sign-in now sit together.
    @State private var tab: Tabs = .sessions
    private enum Tabs: Hashable { case sessions, machines, you }

    /// The machine a notification or the reassurance line asked to open. The
    /// Machines tab pushes its page once its list has it.
    @State private var openHost: String?

    /// The tab a screenshot run asked for, if this launch is one. The old
    /// names still work, so a screenshot plan written before the rename does
    /// not silently land on the wrong tab.
    private var screenshotTab: Tabs? {
        switch Screenshots.tab {
        case "sessions": return .sessions
        case "machines", "fleet": return .machines
        case "you", "settings": return .you
        default: return nil
        }
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Sessions", systemImage: "square.stack.3d.up", value: Tabs.sessions) {
                FleetView(settings: settings, showMachine: { host in
                    openHost = host
                    tab = .machines
                })
            }
            Tab("Machines", systemImage: "server.rack", value: Tabs.machines) {
                NavigationStack { MachinesView(settings: settings, opening: $openHost) }
            }
            Tab("You", systemImage: "person.crop.circle", value: Tabs.you) {
                NavigationStack { YouView(settings: settings) }
            }
        }
        // A tapped notification lands where it is about: a machine's page for
        // a host event, the sessions for everything else.
        .onReceive(NotificationCenter.default.publisher(for: .notificationOpened)) { note in
            if let host = note.userInfo?["host"] as? String, !host.isEmpty {
                openHost = host
                tab = .machines
            } else {
                tab = .sessions
            }
        }
        // The content is the point; the chrome is not. On the way down the
        // tab bar shrinks to a pill and gives the list its height back.
        .tabBarMinimizeBehavior(.onScrollDown)
        // THE ACCENT, ONCE, AT THE ROOT. Every button, link and selected tab in
        // the app inherits it, which is the difference between an app with a
        // colour and an app wearing whichever blue the system happened to
        // supply. #3866D6 in light, lifted in dark so it clears the ground.
        .tint(Design.Palette.accent)
        // Nowhere to point a coordinator at yet, so start where that is fixed
        // rather than showing an empty session list and a modal about it.
        .onAppear {
            if let t = screenshotTab { tab = t }
            else if !settings.configured { tab = .you }
        }
        // WHETHER THIS PERSON IS AN ADMIN, asked once the app can ask. The
        // admin-only rows (People, revoking a machine or a device) are drawn
        // from this and nothing else, so a member never meets a control that
        // only answers "needs an admin credential".
        .task(id: settings.credential) { await settings.refreshAdmin() }
    }
}

struct FleetView: View {
    let settings: Settings
    /// Open the Machines tab, on one machine's page when there is one to name.
    var showMachine: (String?) -> Void = { _ in }

    @State private var sessions: [Fleet.Session] = []
    /// Hosts, for the bin — which is fleet-wide and therefore needs them all.
    @State private var fleetHosts: [Fleet.FleetHost] = []
    private var binCount: Int { fleetHosts.reduce(0) { $0 + ($1.health?.bin?.count ?? 0) } }
    /// Machines where THIS PERSON has connected Claude. Nil until asked.
    ///
    /// The count a host reports is a fleet-wide fact — how many people can
    /// start something here — and a guest joining a fleet where somebody else
    /// has connected would read as "set up" while being unable to start
    /// anything. Whose account is missing is a question about the person
    /// asking, so it is asked as them.
    @State private var myClaudeHosts: [String]?

    /// Nowhere to run anything yet.
    ///
    /// Distinguished from "nothing is running" because they are different
    /// situations with different next steps, and merging them is what let
    /// somebody new tap Start and be refused for a reason nothing had
    /// mentioned.
    ///
    /// Both halves have to be KNOWN. An empty fleet list is "we have not heard
    /// yet", and a nil answer here is "we have not asked" — neither is
    /// evidence of anything, and claiming setup is needed on the strength of a
    /// missing answer is the benign-looking lie this project keeps refusing.
    private var needsSetup: Bool {
        guard !fleetHosts.isEmpty, let mine = myClaudeHosts else { return false }
        return mine.isEmpty
    }
    @State private var status = ""
    @State private var busy = false
    @State private var showingStart = false
    /// Counted rather than flagged, so the same feedback twice in a row is
    /// still felt twice: `.sensoryFeedback` fires when its trigger changes.
    @State private var accepted = 0
    @State private var refused = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether this person's Claude login is kept for their runners. Nil until
    /// asked; see ClaudeKept for why there are four answers.
    @State private var claude: ClaudeKept?
    @AppStorage("claudeSetupPutOff") private var claudePutOff = false

    var body: some View {
        NavigationStack {
            List {
                // FIRST, ALWAYS, ABOVE THE LIST. docs/psychology.md names
                // "nothing needs you" as the most important state in the
                // system and neither app said it: a list of rows is not that,
                // because reading five rows and concluding none of them is
                // asking anything is work somebody redoes every time they open
                // the app — which is the loop the anxiety runs in.
                //
                // AND IT GOES WHERE IT POINTS. "One machine needs a look · deb132"
                // named the machine and offered no way to it, so the person
                // switched tab and scrolled to find the card it had just named.
                // One unwell machine opens its page; several open the list.
                // SAID WHERE IT IS SEEN. An admin viewing as a member is looking
                // at a smaller fleet than theirs, and a list that quietly shows
                // less is the claim this app keeps refusing to make.
                if settings.viewAsMember {
                    HStack(spacing: Design.Space.insideTight) {
                        Text("Viewing as a member")
                            .fleetType(.bodySmall)
                            .foregroundStyle(Design.Palette.ink)
                        Spacer(minLength: 0)
                        Button("Switch back") { settings.viewAsMember = false }
                            .fleetType(.bodySmall)
                            .frame(minHeight: 44)
                    }
                    .fleetCard(radius: Design.Radius.row, padding: Design.Space.inside, fill: Design.Palette.inner)
                    .fleetRow()
                }
                let summary = Reassurance(sessions: sessions, hosts: fleetHosts)
                if summary.unwell.isEmpty {
                    ReassuranceBanner(summary: summary)
                        .fleetRow()
                } else {
                    Button {
                        showMachine(summary.unwell.count == 1 ? summary.unwell.first : nil)
                    } label: {
                        ReassuranceBanner(summary: summary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(openHint(summary.unwell))
                    .fleetRow()
                }
                // THE ONBOARDING ASK, under the line that says whether anything
                // needs you. A session runs on its starter's own Claude account,
                // and a runner started with none kept refused the session it was
                // started for, with nothing on the way there having asked.
                if !claudePutOff, claude == .missing || claude == .needsGitHub,
                   settings.configured, !Demo.isActive(settings.coordinatorURL) {
                    ClaudeSetupCard(settings: settings) { claudePutOff = true }
                        .fleetRow()
                }
                if !status.isBlank {
                    // THE COORDINATOR'S OWN WORDS, on an inner surface rather
                    // than a card: this is evidence quoted from somewhere else,
                    // and it should not look like something this screen said.
                    Text(status)
                        .fleetType(.labelMono)
                        .foregroundStyle(Design.Palette.ink)
                        .textSelection(.enabled)
                        .fleetCard(radius: Design.Radius.row, padding: Design.Space.inside,
                                   fill: Design.Palette.inner)
                        .fleetRow()
                }
                // WHAT IS WAITING, because a queue nobody can see is not a
                // queue — it is a surprise arriving later. The count is enough:
                // each command says what it is when it lands, and a list of
                // them here would be a second inbox to read.
                if !outbox.held.isEmpty {
                    Label(
                        outbox.held.count == 1
                            ? "1 command is held on this phone and will be sent when the fleet answers."
                            : "\(outbox.held.count) commands are held on this phone and will be sent when the fleet answers.",
                        systemImage: "tray.full"
                    )
                    .fleetType(.bodySmall)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fleetCard(radius: Design.Radius.row, padding: Design.Space.inside,
                               fill: Design.Palette.inner)
                    .fleetRow()
                }
                Group {
                    if sessions.isEmpty && !busy {
                        // ContentUnavailableView rather than a grey sentence:
                        // it is the system's empty state, so it inherits the
                        // spacing, the type and the behaviour every other app
                        // on the phone uses for the same situation.
                        // TWO DIFFERENT EMPTY SCREENS, and they were one.
                        //
                        // Somebody new signs in, sees "Nothing is running" and
                        // a Start button, taps it, and is refused for want of a
                        // Claude account — having been told nothing about
                        // needing one. That is the whole of onboarding
                        // somebody who is not the person who built this: the
                        // first screen is confident and the second one is a
                        // refusal.
                        //
                        // A person with nowhere to run anything is not looking
                        // at an empty list, they are looking at a setup step.
                        if needsSetup {
                            ContentUnavailableView {
                                Label("Nothing set up yet", systemImage: "person.badge.key")
                            } description: {
                                Text("A session runs on YOUR Claude account. Sign in to Claude on one of "
                                     + "these machines and you can start work here.")
                            } actions: {
                                // THE SAME SIGN-IN A MACHINE'S PAGE OFFERS, not a
                                // second credentials screen: it asks which machine
                                // when there is more than one.
                                NavigationLink("Connect Claude") {
                                    CredentialsView(settings: settings, host: nil, onlyClaude: true)
                                }
                            }
                        } else {
                            ContentUnavailableView {
                                Label("No sessions", systemImage: "moon.zzz")
                            } description: {
                                Text("Nothing is running on any machine in this fleet.")
                            } actions: {
                                Button("Start one") { showingStart = true }
                                    .disabled(!settings.configured)
                            }
                        }
                    }
                }
                .fleetRow()
                ForEach(sessions) { session in
                    // FILES, OUTPUT AND FORGET ARE ON THE SESSION'S PAGE, and
                    // only there. The card carried the same row of actions as
                    // the page it opens, so every session was two complete
                    // control surfaces, and Output's answer landed in the box
                    // at the top of the list, off screen for the sixth card
                    // of eight. The card answers, stops, resumes and opens;
                    // the page does the rest, with its reply beside it.
                    SessionRow(session: session, busy: busy, fleet: fleet,
                               stop: { await act { try await fleet.stop(session.name) } },
                               resume: { await act { try await fleet.resume(session.name, choice: "summary") } },
                               answer: { option in
                                   await act {
                                       try await fleet.answer(session.name, option: option,
                                                              promptId: session.prompt?.id)
                                   }
                               },
                               changed: { await refresh(keepStatus: true) })
                        .fleetRow()
                }
            }
            // A STACK OF CARDS, NOT A TABLE. `.plain` drops the grouped
            // list's inset panels and grey separators — every one of which
            // draws a box the design says should not be there — and the rows
            // put themselves on cards instead. The ground is ours rather than
            // the system's, so the cards have something to sit above.
            .listStyle(.plain)
            .listRowSpacing(Design.Space.groupTight)
            .scrollContentBackground(.hidden)
            .background(Design.Palette.bg)
            .refreshable { await refresh() }
            // Asked again when the fleet or this phone's GitHub sign-in changes,
            // and whenever the list comes back into view, which is how a login
            // kept on the setup page takes the card away.
            .task(id: "\(settings.credential)|\(settings.githubSignIn)") { claude = await claudeKept(settings) }
            .onAppear { Task { claude = await claudeKept(settings) } }
            // FELT, NOT ONLY SEEN. Stop, Resume and an answer each say whether
            // the fleet took them, in the hand, because this is read on a phone
            // held at arm's length at night and a quoted reply at the top of a
            // list is easy to miss. A refusal feels different from a yes.
            .sensoryFeedback(.success, trigger: accepted)
            .sensoryFeedback(.error, trigger: refused)
            // The product is called Fleetwright; this said "agent-fleet",
            // which is the repository. A person who installed one app and is
            // looking at another name has to work out whether they are the
            // same thing, and the answer being yes does not make the question
            // free. Android has always said Fleetwright.
            .navigationTitle("Fleetwright")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // THE BIN, IN THE TOOLBAR RATHER THAN OVER THE LIST. It was
                    // a glass capsule pinned to the bottom edge — which is
                    // where the tab bar now lives, so two floating controls
                    // fought for one corner and the bin sat on top of the last
                    // session in the list.
                    //
                    // The toolbar is where a secondary action belongs once
                    // there is somewhere for the primary ones to live, and it
                    // takes the place of the Settings button that a Settings
                    // TAB made redundant.
                    NavigationLink {
                        RecycleBinView(settings: settings, hosts: fleetHosts) {
                            Task { await refresh(keepStatus: true) }
                        }
                    } label: {
                        Label(binCount > 0 ? "Bin (\(binCount))" : "Bin", systemImage: "trash")
                    }
                }
                // WHAT HAPPENED WHILE THE APP WAS CLOSED, beside the bin. It
                // was a section of Settings, which is the last place anybody
                // looks for news about their sessions and machines.
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink {
                        ActivityView(settings: settings)
                    } label: {
                        Label("Recent activity", systemImage: "clock.arrow.circlepath")
                    }
                    .disabled(!settings.configured)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Opens the sheet rather than starting immediately. The
                    // one-tap start is still there — leaving the sheet blank
                    // and pressing Start is the same thing — but a session
                    // nobody described is one nobody recognises in a week.
                    Button("New") { showingStart = true }
                        .disabled(busy || !settings.configured)
                }
            }
            .sheet(isPresented: $showingStart) {
                // The sheet gathers what to start and hands it up. It does not
                // wait for the answer — see startInBackground.
                StartSheet(settings: settings, onStart: startInBackground)
            }
            // Again when the view changes: the same list, answered as somebody else.
            .task(id: settings.viewAsMember) { await refresh() }
            // The list a notification tap lands on should be the list as it is
            // now, not as it was when the phone went in a pocket — AND THE
            // SESSION THE NOTIFICATION WAS ABOUT SHOULD BE OPEN. A buzz says
            // "bigjob is back at its prompt"; landing on a list of twelve and
            // finding bigjob in it is the search the notification existed to
            // save. The name rides on the notification; the page is pushed
            // once the fresh list confirms the session is still there.
            .onReceive(NotificationCenter.default.publisher(for: .notificationOpened)) { note in
                let name = note.userInfo?["name"] as? String
                Task {
                    await refresh()
                    if let name, let session = sessions.first(where: { $0.name == name }) {
                        opened = session
                    }
                }
            }
            .navigationDestination(item: $opened) { session in
                SessionView(fleet: fleet, initial: session, onChange: { await refresh(keepStatus: true) })
            }
        }
    }

    /// What tapping the reassurance line does, for VoiceOver.
    private func openHint(_ unwell: [String]) -> String {
        unwell.count == 1 ? "Opens \(unwell[0])" : "Opens the machines"
    }

    /// The session a notification tap opened, pushed programmatically. Nil
    /// the rest of the time: the rows push their own pages by link.
    @State private var opened: Fleet.Session?

    /// One queue for the screen, not one per computed Fleet — the whole point
    /// is that it outlives the request that failed.
    @State private var outbox = Outbox()
    private var fleet: Fleet { Fleet(settings: settings, outbox: outbox) }

    /// Try everything held, now that the fleet has just answered.
    ///
    /// ON REFRESH, NOT ON A TIMER. A timer retries into an outage; a refresh is
    /// the moment we have just learned the fleet is reachable, and it already
    /// happens when the app opens, is pulled, or comes back to the foreground.
    /// Returns how many were sent, and does NOT refresh.
    ///
    /// The first version called refresh() at the end, and refresh() calls this
    /// — mutual recursion that happened to terminate because the second pass
    /// found an empty queue. "Happens to terminate" is not a property to ship;
    /// the caller re-lists instead.
    @discardableResult
    private func flushOutbox() async -> Int {
        await outbox.flush { entry in
            do {
                let reply = try await fleet.resend(entry)
                // A REFUSAL COUNTS AS DELIVERED. The fleet answered — "that
                // session is gone", "you cannot stop that" — and holding a
                // command it has already judged would retry it forever.
                if reply.ok == false, let text = reply.text { status = text }
                return .success(())
            } catch {
                return .failure(error)
            }
        }
    }

    /// - Parameter keepStatus: keep whatever is already on screen if the list
    ///   call succeeds. Set after an action, whose reply text is the only
    ///   confirmation the coordinator ever gives — a plain refresh would wipe
    ///   "Started cc-brave-otter." a few hundred milliseconds after it appeared.
    /// Start a session without making anybody watch it happen.
    ///
    /// THE SHEET CLOSES IMMEDIATELY. Starting takes the host up to a minute —
    /// a container, a fresh volume, credentials, and the Remote Control check
    /// — and the two previous attempts at this were wrong in the same
    /// direction: first a greyed-out button that looked like a hang, then a
    /// spinner that explained the wait. Explaining a wait is still a wait.
    ///
    /// Nobody needs to be present for it, so the answer arrives as a
    /// notification and the person gets their phone back.
    ///
    /// The task is owned HERE rather than in the sheet, because a task tied to
    /// a dismissed view is one that may not finish — and this is a mutating
    /// request that has already left.
    private func startInBackground(_ request: StartRequest) {
        // ON A MACHINE THAT DOES NOT EXIST YET. The coordinator holds the
        // session with the dispatch and starts it when the runner joins, so
        // this returns long before there is a session, and says so. The
        // session's own notification, with its link, is what arrives later.
        if let platform = request.platform {
            // "New macOS machine" reads as "a new macOS machine" in a
            // sentence: only the first letter changes case.
            let label = request.imageLabel ?? newMachineChoices.first { $0.platform == platform }?.label ?? "New machine"
            let lowered = label.prefix(1).lowercased() + label.dropFirst()
            status = platform == "vm"
                ? "Asking your hypervisor for a \(lowered). The session starts on it when it joins."
                : "Asking GitHub for a \(lowered). The session starts on it when it joins."
            var start: [String: String] = [:]
            if let title = request.title { start["title"] = title }
            if let brief = request.brief { start["brief"] = brief }
            if let mode = request.mode { start["mode"] = mode }
            if let task = request.task { start["task"] = task }
            Task {
                do {
                    let reply = try await Fleet(settings: settings)
                        .provision(platform: platform, minutes: request.minutes, start: start, template: request.template,
                                   network: request.network, group: request.group)
                    let text = reply.text ?? "Asked for it."
                    await MainActor.run { status = text }
                    LocalNotice.post(title: reply.ok == false ? "Could not ask for a machine" : "Machine on its way", body: text)
                } catch {
                    let text = error.localizedDescription
                    await MainActor.run { status = text }
                    LocalNotice.post(title: "Could not ask for a machine", body: text)
                }
                await refresh(keepStatus: true)
            }
            return
        }
        // SAID DIFFERENTLY WHEN IT HAS NOTHING TO DO, because "ready" reads as
        // "working" and only one of these is. A session with no profile is
        // waiting for a person, and somebody who walks away expecting output
        // comes back to an empty prompt.
        status = request.profile == nil && request.task == nil
            ? "Starting a session. It will come up idle, waiting for you."
            : "Starting a session. You will get a notification when it is ready."
        Task {
            do {
                let reply = try await Fleet(settings: settings).start(
                    name: nil,
                    title: request.title,
                    brief: request.brief,
                    mode: request.mode,
                    host: request.host,
                    profile: request.profile,
                    secret: request.secret,
                    task: request.task
                )
                let text = reply.text ?? "Started."
                await MainActor.run { status = text }
                // BY WHAT THE FLEET SAID, not by whether it answered. A refusal
                // is an answer, and "Session ready" over "unknown (connected,
                // no health report yet)" told somebody to go and look at a
                // session that did not exist.
                LocalNotice.post(title: reply.ok == false ? "Could not start a session" : "Session ready", body: text)
            } catch {
                // A TIMEOUT IS NOT A FAILURE: `start` is mutating and carries
                // an idempotency key, so the session may well exist. Saying
                // "failed" would send somebody to start a second one — and the
                // second would be a second session, because a retry mints a
                // new key.
                let timedOut = (error as NSError).code == NSURLErrorTimedOut
                let text = timedOut
                    ? "Still starting, or started — the answer did not come back in time. Pull to refresh to see."
                    : error.localizedDescription
                await MainActor.run { status = text }
                LocalNotice.post(title: timedOut ? "Session may be starting" : "Could not start a session", body: text)
            }
            await refresh(keepStatus: true)
        }
    }

    private func refresh(keepStatus: Bool = false) async {
        guard settings.configured else { return }
        busy = true
        defer { busy = false }
        // THE BIN'S HOSTS DO NOT DEPEND ON THE SESSION LIST, so they are asked
        // for at the same time rather than after it. Started here and awaited
        // below, which is where the answer is used.
        async let reporting = fleet.fleetHosts()
        do {
            let reply = try await fleet.list()
            // A CARD MOVES TO WHERE IT NOW BELONGS. A session that started
            // asking goes to the top, a new one arrives, a forgotten one
            // leaves; with nothing animating, each of those was a list that
            // silently became a different list. Nil under Reduce Motion.
            withAnimation(Design.Motion.settle(reduceMotion)) { sessions = reply.sessions ?? [] }
            // The fleet just answered, so anything held can go now — and if
            // any of it landed, the list we just fetched is already out of
            // date. One extra list, not a second refresh: refresh calls this.
            if reply.ok != false, await flushOutbox() > 0 {
                // `as? [Fleet.Session]` did nothing — the value is already
                // that type, optional — and the compiler said so. Binding it
                // says the same thing and says it once.
                if let fresh = try? await fleet.list().sessions {
                    withAnimation(Design.Motion.settle(reduceMotion)) { sessions = fresh }
                }
            }
            // A failure is shown, never swallowed: "nothing here" and "I could
            // not reach the coordinator" look identical otherwise, and they are
            // completely different problems.
            if reply.ok == false {
                status = reply.text ?? ""
            } else if !keepStatus {
                status = ""
            }
        } catch {
            status = error.localizedDescription
        }
        // THE BIN'S CONTENTS, which `list` does not carry: a bin entry is not
        // a session, it is a session that stopped being one. `try?` and a
        // separate statement on purpose — a fleet call that fails must not
        // blank the session list that already arrived, and an empty bin and an
        // unreachable coordinator are allowed to look the same HERE because
        // the sessions above have already said which it was.
        if let got = try? await reporting { fleetHosts = got }

        // ONLY WHEN THERE IS NOTHING TO SHOW. This is a fan-out across the
        // fleet, and asking it on every refresh would spend a round trip per
        // pull to answer a question that only matters on an empty screen — the
        // one case where nothing else is competing for the time.
        if sessions.isEmpty {
            // NOT `?? []`, AND THIS ONE DECIDES WHAT SCREEN SOMEBODY SEES.
            //
            // `myClaudeHosts` is optional precisely so that "we have not asked"
            // and "asked, and nobody" stay different — needsSetup says so in as
            // many words two hundred lines up. Coalescing a FAILED ask to the
            // empty array collapses them, and the app then tells a person whose
            // fleet is perfectly set up that nothing is set up yet, because one
            // request did not come back.
            if let reply = try? await fleet.connections() {
                myClaudeHosts = reply.connections?.linked("claude")?.hosts ?? []
            }
        }
    }

    /// Run one verb and quote what came back.
    ///
    /// `nothingSaid` is for the verbs whose whole job is to bring text back. A
    /// reply of forty blank lines used to be quoted verbatim — see
    /// `String.isBlank` — and trimming it alone would leave the opposite
    /// problem, a button that does nothing visible when it is pressed. Most
    /// verbs do not need it: their answer is the list refreshing underneath.
    private func act(nothingSaid: String? = nil, _ work: () async throws -> Fleet.Reply) async {
        busy = true
        do {
            // TRIMMED, not merely tested. A host that still pads its reply
            // would otherwise draw its card with a screenful of empty rows
            // above and below the one line worth reading.
            let reply = try await work()
            let said = (reply.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            status = said.isEmpty ? (nothingSaid ?? "") : said
            if reply.ok == false { refused += 1 } else { accepted += 1 }
        } catch {
            status = error.localizedDescription
            refused += 1
        }
        busy = false
        await refresh(keepStatus: true)
    }
}

private struct SessionRow: View {
    let session: Fleet.Session
    let busy: Bool
    /// The client, for the one action that is a DESTINATION rather than a
    /// closure: browsing pushes a screen, and a screen needs something to call
    /// while it is open.
    let fleet: Fleet
    let stop: () async -> Void
    let resume: () async -> Void
    let answer: (Int) async -> Void
    /// Called when the session's own page changed something the list should
    /// know about — a stop, an answer — so the row moves with it.
    let changed: () async -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The question unfolds from under the title it belongs to; under Reduce
    /// Motion it fades in where it will sit.
    private var questionArrives: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }

    /// A session that is asking something wears the attention ring, and it is
    /// the only card on the screen that ever wears anything but the hairline.
    private var ring: Color {
        session.prompt != nil ? Design.Palette.attention.opacity(0.55) : Design.Palette.ring
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            // THE TITLE IS THE WAY IN. A session is a subject and has a page
            // (SessionView) — the pane, the state sentence, Files, Output and
            // Forget. The row keeps answering and stopping, so the list stays
            // the place to act on what is asking; the page is where to look.
            NavigationLink {
                SessionView(fleet: fleet, initial: session, onChange: changed)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                    Text(session.label)
                        .fleetType(.bodyStrong)
                        .foregroundStyle(Design.Palette.ink)
                    Image(systemName: "chevron.right")
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .accessibilityHidden(true)
                    Spacer(minLength: 0)
                    StatusBadge(status: session.status)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Both are shown when they differ: the title is what a person
            // recognises, the name is what everything else keys on.
            if session.label != session.name {
                Text(session.name).fleetType(.microMono).foregroundStyle(Design.Palette.inkDim)
            }
            // Where, how long, and whose account — the three questions about a
            // session somebody started yesterday. One line, secondary, because
            // they are context rather than the point.
            HStack(spacing: Design.Space.hair) {
                if let host = session.hostId { Text("on \(host)") }
                if let workspace = session.workspace { Text("· \(workspace)") }
                if let age = session.age { Text("· \(age)") }
                if let account = session.account, account != "shared" {
                    // Only when it is NOT the shared account: on a fleet where
                    // nobody has linked one, this line would say the same
                    // thing on every row and mean nothing.
                    Text("· \(account)")
                }
                // How full its window is, when the host read it. A count,
                // not a bar: the window's size is not something the host
                // knows, and a bar needs one.
                if let context = session.contextLine { Text("· \(context)") }
            }
            .fleetType(.micro)
            .foregroundStyle(Design.Palette.inkDim)
            // HOW LONG IT HAS BEEN QUIET. "Running" was doing two jobs: a
            // session mid-build and one that has not moved since Tuesday
            // looked identical, and the difference is the whole question
            // somebody opens this app to ask. Nil under five minutes, so a
            // working session never wears it.
            if let quiet = session.quietFor {
                Label(quiet, systemImage: "pause.circle")
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // WHAT IT IS ASKING, and the answer as a row of buttons.
            //
            // This is the whole point of a notification that carries the
            // question: reading it on a phone and being unable to answer is
            // the shape of the problem, not a smaller version of it. The
            // options are the ones the HOST published — an ordinal is sent,
            // never text.
            if let prompt = session.prompt, let options = prompt.options, !options.isEmpty {
                VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                    if let question = prompt.question, !question.isEmpty {
                        // THE QUESTION IS THE TITLE HERE. It is why the
                        // notification arrived and why this row is at the top
                        // of the list; setting it in the same size as the row's
                        // own metadata was the app burying its own headline.
                        Text(question)
                            .fleetType(.title)
                            .foregroundStyle(Design.Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(options) { option in
                        Button {
                            Task { await answer(option.index) }
                        } label: {
                            HStack(spacing: Design.Space.insideTight) {
                                // The ordinal, because an ordinal is what is
                                // sent — the label never leaves the box.
                                Text("\(option.index)")
                                    .fleetType(.labelMono)
                                    .foregroundStyle(Design.Palette.inkDim)
                                    .padding(.horizontal, Design.Space.insideTight)
                                    .padding(.vertical, Design.Space.hair)
                                    .background(
                                        Design.Palette.track,
                                        in: RoundedRectangle(cornerRadius: Design.Radius.chip,
                                                             style: .continuous)
                                    )
                                Text(option.label)
                                    .fleetType(.bodySmall)
                                    .foregroundStyle(Design.Palette.ink)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            // 44pt, whatever the label's length: this is the
                            // control the whole notification exists to offer.
                            .frame(minHeight: 44)
                            .padding(.horizontal, Design.Space.inside)
                            .background(
                                Design.Palette.inner,
                                in: RoundedRectangle(cornerRadius: Design.Radius.row,
                                                     style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: Design.Radius.row, style: .continuous)
                                    .strokeBorder(Design.Palette.ring, lineWidth: 1)
                            )
                        }
                        .disabled(busy)
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, Design.Space.insideTight)
                .transition(questionArrives)
            } else if session.prompt != nil {
                // A permission dialog names a command, so without the fleet
                // switch its labels do not leave the box. Saying so beats
                // showing nothing.
                Text("Waiting for an answer. The options are not shown because this fleet does not send prompt text off the box.")
                    .fleetType(.bodySmall)
                    .foregroundStyle(Design.Palette.inkDim)
            }

            // ONE PRIMARY ACTION, at the height a thumb can hit. These were
            // borderless buttons in the small type with no minimum height, so
            // the row under 44pt was the one control on the card a person
            // could miss.
            HStack(spacing: Design.Space.groupTight) {
                if session.isRunning {
                    Button("Stop") { Task { await stop() } }.disabled(busy)
                    if let url = session.rcUrl, let link = URL(string: url) {
                        // The button that turns a notification into actually
                        // driving the session. The same words as its page.
                        Link("Continue in Remote Control", destination: link)
                    }
                } else if session.isResumable {
                    Button("Resume") { Task { await resume() } }.disabled(busy)
                }
            }
            .fleetType(.bodySmall)
            .buttonStyle(.borderless)
            .frame(minHeight: 44)
        }
        .fleetCard(radius: Design.Radius.cardSmall, ring: ring)
        // THE RING TAKES ON THE TONE as the question arrives, rather than
        // being swapped for it: the one card asking something comes forward.
        .animation(Design.Motion.change, value: session.prompt != nil)
    }
}

/// A session's state, as a symbol AND a word.
///
/// Never colour alone. The symbol is a shape and the word is a word; the tint
/// only reinforces what both already say. That is what "differentiate without
/// colour" asks for, and it is also the difference between a glanceable list
/// and a pretty one — colour vision deficiency affects around one man in
/// twelve, and everybody loses colour in bright sun.
private struct StatusBadge: View {
    let status: String

    private var symbol: String {
        switch status {
        case "running": return "play.circle.fill"
        case "awaiting-input": return "exclamationmark.bubble.fill"
        case "stopped": return "pause.circle"
        // A stop sign, not a tick: an ended session may have crashed.
        case "ended": return "stop.circle"
        default: return "questionmark.circle"
        }
    }

    /// The tone, which only ever agrees with the word beside it.
    ///
    /// `running` is the design system's `active` — a sky blue — rather than the
    /// app's accent. The accent means "you can tap this"; a status is not an
    /// action, and a badge that borrows the accent teaches the accent to mean
    /// two things.
    private var tint: Color {
        switch status {
        case "running": return Design.Palette.active
        case "awaiting-input": return Design.Palette.attention
        // NOT `ok`. A crash and a success both end as "ended", and green
        // would claim the one this badge cannot know (C-5).
        //
        // AND NOT `idle`, which is a tone for a mark rather than for words:
        // as 13pt text on the inner surface it is 3.6:1 in dark and 2.3:1 in
        // light, under the 4.5:1 a word this size needs. `inkDim` is the
        // palette's own colour for "stopped" and clears it in both themes.
        default: return Design.Palette.inkDim
        }
    }

    var body: some View {
        HStack(spacing: Design.Space.hair) {
            // Decorative: the word beside it is the label, and VoiceOver
            // announcing "play circle fill, running" is worse than "running".
            Image(systemName: symbol)
                // The symbol becomes the next one rather than being swapped
                // for it: a play mark turning into a hand is the news.
                .contentTransition(.symbolEffect(.replace))
                .accessibilityHidden(true)
            Text(status)
                .contentTransition(.opacity)
        }
        .fleetType(.label)
        .foregroundStyle(tint)
        .animation(Design.Motion.change, value: status)
        .padding(.horizontal, Design.Space.insideTight)
        .padding(.vertical, Design.Space.hair)
        .background(
            Design.Palette.inner,
            in: RoundedRectangle(cornerRadius: Design.Radius.chip, style: .continuous)
        )
    }
}


/// Editing the words Siri will recognise.
///
/// Deliberately plain. This is a list somebody visits twice — once to add
/// "dev", once more a month later — and anything cleverer than a list and a
/// text field is design nobody asked for on a screen nobody looks at.
struct SessionKindsView: View {
    /// Passed in only so the task picker can ask the fleet what profiles exist.
    /// A TEXT FIELD WOULD HAVE BEEN SMALLER AND WRONG: a mistyped profile name
    /// saves fine, pre-fills nothing, and the kind quietly starts idle sessions
    /// forever — a setting that looks applied and is not, which is the exact
    /// shape this app keeps paying for.
    let settings: Settings

    @State private var kinds: [SessionKind] = SessionKinds.all()
    @State private var newWord = ""
    @State private var profiles: [Fleet.Profile] = []

    var body: some View {
        Form {
            Section {
                ForEach($kinds) { $kind in
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("Word", text: $kind.word)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        TextField("Title prefix (optional)", text: $kind.titlePrefix)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                        // Only when the fleet has answered with something. A
                        // picker whose only entry is "Nothing" is furniture,
                        // and on a fleet with no profiles it would be furniture
                        // that implies a feature is broken.
                        if !profiles.isEmpty {
                            Picker("Task", selection: $kind.profile) {
                                Text("Nothing — I will drive it").tag("")
                                ForEach(uniqueProfiles, id: \.self) { name in Text(name).tag(name) }
                            }
                            .fleetType(.label)
                        }
                    }
                }
                .onDelete { idx in
                    idx.map { kinds[$0].id }.forEach(SessionKinds.remove)
                    kinds.remove(atOffsets: idx)
                }
                HStack {
                    TextField("Add a word", text: $newWord)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Add") {
                        let word = newWord.trimmingCharacters(in: .whitespaces)
                        guard !word.isEmpty else { return }
                        kinds.append(SessionKind(word: word))
                        newWord = ""
                        SessionKinds.save(kinds)
                    }
                    .disabled(newWord.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("Words")
                    .fleetType(.section)
                    .foregroundStyle(Design.Palette.ink)
                    .textCase(nil)
            } footer: {
                // Said, because otherwise the first thing anybody does is add a
                // word and then wonder why Siri has not heard of it.
                Text("""
                Say "start a dev session on my fleet". A new word can take a moment before \
                Siri recognises it. A prefix groups sessions in the list: "dev: refactor auth". \
                A task makes the word do something: spoken, that is the only way a session gets \
                one, because there is no screen to drive it from afterwards.
                """)
            }
        }
        // The design's ground, and the rows on the card colour, so this screen
        // belongs to the same app as the one that pushed it.
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Session kinds")
        .task { profiles = (try? await Fleet(settings: settings).profiles()) ?? [] }
        // Saved on the way out rather than on every keystroke: this writes the
        // whole list, and doing that per character would rewrite it a hundred
        // times while somebody types one word.
        .onDisappear { SessionKinds.save(kinds) }
    }

    /// By NAME, deduplicated across hosts.
    ///
    /// A kind is a word somebody says, not a placement: two boxes may both have
    /// a profile called "reviewer", and a kind that pinned one of them would
    /// send "start a reviewer session" at a machine that happens to be busy.
    /// The start sheet resolves the host from where the file actually is.
    private var uniqueProfiles: [String] {
        Array(Set(profiles.map(\.name))).sorted()
    }
}


/// "signed in as a@b.com · max · Example Org", built a piece at a time.
///
/// A plain function rather than an expression in the view: a chain of `+`
/// with optional maps inside it is what made the Swift type checker give up
/// in #125, and that failure only appears on CI.
private func describeAccount(_ account: Fleet.HostHealth.Account) -> String {
    var parts: [String] = ["signed in as \(account.email ?? "unknown")"]
    if let plan = account.plan, !plan.isEmpty { parts.append(plan) }
    if let org = account.org, !org.isEmpty { parts.append(org) }
    return parts.joined(separator: " · ")
}

/// "forgotten · 3 days left", built a piece at a time rather than inline: a
/// chain of `+` over optionals is what made the Swift type checker give up in
/// #125, and that failure only shows up on CI.
private func describeBinned(_ item: Fleet.Binned) -> String {
    var parts: [String] = ["forgotten"]
    if item.title != nil { parts.append(item.name) }
    if let remaining = item.remaining { parts.append(remaining) }
    return parts.joined(separator: " · ")
}

/// "2 people · eli@example.com · max", or the fault when it is one.
///
/// ONE LINE OUT OF TWO THAT OVERLAPPED. The row used to print "signed in as
/// eli@example.com · max · eli@example.com's Organization" and, below it, "2
/// people can start sessions here" — the org repeating the address with a
/// suffix, and the count repeating the point in a full sentence.
///
/// The org is dropped when it is only the address again. Google and Anthropic
/// both name a personal organisation that way, so on a single-person account it
/// is guaranteed noise.
// NOT file-private: HostView renders the same sentence, and a second copy of
// it is how two screens start describing one fact differently.
func describeWhoCanStart(_ accounts: Int, account: Fleet.HostHealth.Account?,
                         runnerAuth: String? = nil, runner: Bool = false) -> String {
    // A RUNNER IS ASKED A DIFFERENT QUESTION. Nobody links an account on a
    // GitHub job; its sessions run on the login its owner keeps for runners or
    // on the runner repository's key, and the host says which. This line said
    // "Nobody has connected a Claude account here — sessions will not start"
    // on a runner whose sessions would start, beside the word "healthy".
    if accounts == 0 {
        switch runnerAuth {
        case "owner": return "Sessions run on the Claude login its owner keeps for runners"
        case "key": return "Sessions run on the runner repository's API key"
        case "none":
            return "No Claude login is kept for this runner's owner and its repository has no API key — sessions will not start"
        default:
            // Cannot tell yet, which is not a fault (C-5).
            if runner { return "Fetching the Claude login its sessions will run on" }
        }
    }
    // THE ZERO CASE KEEPS ITS WORDS. It is the only real fault here, and
    // "Nobody" alone says what is wrong without saying what to do about it —
    // naming the Claude account is what makes it actionable. The other cases
    // are not faults and do not need a sentence.
    if accounts == 0 { return "Nobody has connected a Claude account here — sessions will not start" }
    var parts: [String] = ["\(accounts) \(accounts == 1 ? "person" : "people")"]
    if let email = account?.email, !email.isEmpty { parts.append(email) }
    if let plan = account?.plan, !plan.isEmpty { parts.append(plan) }
    if let org = account?.org, !org.isEmpty, !org.hasPrefix(account?.email ?? "\u{0}") {
        parts.append(org)
    }
    return parts.joined(separator: " · ")
}

/// Where this person's machines come from, in one sentence. The same words
/// on both phones; test/runner-repo-in-apps.test.js holds them together.
func describeRunnerRepoSetting(saved: String?, fleet: String?) -> String {
    if let saved { return "Your machines come from \(saved)." }
    if let fleet { return "Your machines come from the fleet's repository, \(fleet). Set your own to use your free Actions minutes." }
    return "Make a public repository from github.com/TheTechNetwork/Fleetwright-Runners-Template, install the Fleetwright GitHub App on it, and your machines come from there."
}

/// What a runner repository check found, one answer per fact. "can't tell"
/// is kept apart from "no" (C-5): a personal GitHub token cannot see whether
/// the app is installed, and that is not the same as it not being installed.
func describeRunnerCheck(_ check: Fleet.RunnerRepoCheck) -> String {
    func word(_ value: Bool?) -> String { value.map { $0 ? "yes" : "no" } ?? "can't tell" }
    let machines = check.platforms.isEmpty ? "none" : check.platforms.joined(separator: ", ")
    return "Public: \(word(check.isPublic)) · GitHub app: \(word(check.installed)) · "
        + "Actions write: \(word(check.actionsWrite)) · Machines: \(machines)"
}

/// "5h 42% · resets in 2h · 7d 12%", or the reason there is no number.
///
/// EVERY FIGURE IS THE ENDPOINT'S. The percentages are what the account's own
/// usage endpoint said, the reset is its timestamp with the phone doing the
/// arithmetic, and a report with no answer says so in the host's words rather
/// than drawing 0% — which would be the one reading worse than nothing. Drawn
/// under "connected as you@…" on the credentials screen: an account's fact,
/// on the account's row, once. Same words as Android, held equal by
/// test/context-and-usage-in-apps.test.js.
func describeUsage(_ report: Fleet.Connections.UsageReport, now: Date = Date()) -> String {
    guard let windows = report.windows else {
        var line = "usage not reported"
        if let why = report.why, !why.isEmpty { line += " — \(why)" }
        return line
    }
    var parts: [String] = []
    if let used = windows.fiveHour?.used {
        parts.append("5h \(Int(used.rounded()))%")
        if let at = windows.fiveHour?.resetsAt, at > 0 { parts.append("resets in \(describeUntil(at, now: now))") }
    }
    if let used = windows.sevenDay?.used { parts.append("7d \(Int(used.rounded()))%") }
    if let used = windows.sevenDayOpus?.used { parts.append("Opus 7d \(Int(used.rounded()))%") }
    if let used = windows.sevenDaySonnet?.used { parts.append("Sonnet 7d \(Int(used.rounded()))%") }
    if parts.isEmpty { return "usage not reported" }
    return parts.joined(separator: " · ")
}

/// "now" / "9m" / "2h" / "3d" until an epoch-millisecond instant. Coarse: the
/// question is whether to wait, not when to set an alarm.
func describeUntil(_ epochMs: Double, now: Date = Date()) -> String {
    let seconds = epochMs / 1000 - now.timeIntervalSince1970
    if seconds <= 0 { return "now" }
    if seconds < 3600 { return "\(max(1, Int(seconds / 60)))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    return "\(Int(seconds / 86_400))d"
}

/// "0223f94 · 1 commit behind · rolling", or as much of it as is known.
///
/// THREE LINES COLLAPSED INTO ONE, in the order somebody asks the questions:
/// what is it running, is that current, and what will it take next. The channel
/// had a line of its own on every row — eleven words repeated per machine,
/// saying the same thing on all of them.
func describeRunning(_ host: Fleet.FleetHost) -> String {
    var parts: [String] = []
    if let head = host.health?.version?.head, !head.isEmpty { parts.append(head) }
    let behind = host.health?.updates?.appBehind ?? 0
    if let waiting = host.health?.version?.restartWaitingFor {
        // FIRST, because it is the one thing on this line somebody can act on
        // right now, and because every branch below it is about downloads.
        // A box can have nothing left to fetch and still be running an old
        // release: the fleet said "main-88 · up to date" about exactly that.
        parts.append("\(waiting) installed, restart waiting")
    } else if behind > 0 {
        parts.append("\(behind) commit\(behind == 1 ? "" : "s") behind")
    } else if let waiting = host.health?.updates?.release?.available {
        parts.append("\(waiting) waiting")
    } else if host.health?.updates?.appUpdatePending == true {
        // A migratable checkout is offered a move onto packaged releases. It
        // counts no commits and names no release version, so both branches
        // above are silent on it and it read as current with an Apply button —
        // a row contradicting its own button.
        parts.append("update waiting")
    } else if host.health?.updates?.appStatusKnown == false {
        // "UP TO DATE" IS A CLAIM AND THIS IS WHERE IT WAS BEING INVENTED.
        // Every packaged box reports `appBehind: nil`, and a box that has never
        // reached GitHub reports `release.available: nil` — so the else below
        // fired on both, and a host nobody had successfully checked rendered as
        // current. Not knowing is its own state and it gets its own words.
        parts.append("update status unknown")
    } else if host.health?.version?.head != nil {
        parts.append("up to date")
    }
    if host.health?.version?.rootHalfBehind == true {
        // BESIDE THE BRANCH ABOVE, NOT INSTEAD OF IT. A box can be up to date
        // on what it downloads and runs, and still be taking every update
        // with a helper the installer never refreshed, so nothing root owns
        // follows the release. Both are true at once and the row says both.
        parts.append("update helper out of date")
    }
    if let channel = host.health?.channel, !channel.isEmpty {
        // Pinned is worth a word, because it is why the picker is missing.
        parts.append(host.health?.channelPinned == true ? "\(channel), set on the box" : channel)
    }
    return parts.isEmpty ? "version not reported" : parts.joined(separator: " · ")
}

/// Whether that line is a fault: nobody can start a session here. A runner
/// with its owner's login or its repository's key can, and one that has not
/// heard back yet cannot be judged.
func whoCanStartIsFault(_ accounts: Int, runnerAuth: String?, runner: Bool) -> Bool {
    guard accounts == 0 else { return false }
    switch runnerAuth {
    case "owner", "key": return false
    case "none": return true
    default: return !runner
    }
}

/// "Nobody has connected a Claude account here", or how many people have.
///
/// A function rather than a nested ternary inside the view, and NOT a style
/// preference: the host row's body grew past what the Swift type checker will
/// spend on one expression, and it failed here — on code that had not changed
/// — because this was the expression it happened to run out of time on. The
/// error names a line nobody edited, which is the whole difficulty with it.
private func describeAccounts(_ accounts: Int) -> String {
    if accounts == 0 { return "Nobody has connected a Claude account here — sessions will not start" }
    if accounts == 1 { return "1 person can start sessions here" }
    return "\(accounts) people can start sessions here"
}

/// "running abc1234 · 3 commits behind", or "· up to date".
private func describeVersion(_ head: String, behind: Int) -> String {
    if behind <= 0 { return "running \(head) · up to date" }
    let plural = behind == 1 ? "commit" : "commits"
    return "running \(head) · \(behind) \(plural) behind"
}
