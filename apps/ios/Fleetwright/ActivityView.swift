import SwiftUI

/// What happened while the app was closed. A notification wakes this phone;
/// this is the rest of it.
///
/// Reached from the session list, beside the bin, because it is news about
/// sessions and machines. It was a section of Settings, which is the last
/// place anybody looks for news.
struct ActivityView: View {
    let settings: Settings

    @State private var events: [Fleet.Event] = []
    @State private var loaded = false

    /// Consecutive identical events, collapsed to one row and a count.
    ///
    /// The coordinator's ring is a LOG, and a screen headed "what happened
    /// while you were away" answered with nine lines reading "asked for
    /// connect" is answering it with the log. CONSECUTIVE ONLY: two bursts of
    /// the same verb an hour apart are two things that happened.
    private var runs: [EventRun] {
        var out: [EventRun] = []
        for e in events.reversed() {
            if let last = out.last, last.event.event == e.event, last.event.name == e.name,
               last.event.hostId == e.hostId, last.event.actor == e.actor {
                out[out.count - 1].count += 1
            } else {
                out.append(EventRun(event: e, count: 1))
            }
        }
        return out
    }

    private struct EventRun: Identifiable {
        let event: Fleet.Event
        var count: Int
        var id: String { event.id }
    }

    var body: some View {
        List {
            if events.isEmpty {
                Text(loaded ? "Nothing recorded yet." : "Loading…")
                    .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            // NEWEST FIRST HERE, oldest-first on the wire: right for a log and
            // wrong for a screen somebody opens to find out what they missed.
            // THE LABEL AND ITS SUBJECT ON THE ROW, THE SENTENCE ON A TAP.
            // The fleet's `text` is its log line: "eli@example.com asked for
            // start reviewer-3 on deb132" is the record, and a screen that
            // printed it per row was the log again (docs/design-system.md,
            // Words). The row says what kind of thing happened and to what;
            // the sentence opens under it for whoever wants the detail. A
            // row with no sentence has nothing to open.
            ForEach(runs) { run in
                if let text = run.event.text, !text.isEmpty {
                    DisclosureGroup {
                        Text(text)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .textSelection(.enabled)
                    } label: {
                        eventRow(run)
                    }
                    .frame(minHeight: 44)
                } else {
                    eventRow(run).frame(minHeight: 44)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .listRowBackground(Design.Palette.card)
        .navigationTitle("Recent activity")
        .refreshable { await load() }
        .task { await load() }
    }

    @MainActor
    private func load() async {
        // A coordinator too old to serve this answers 404, and an empty list
        // is the right way to say so; a failure keeps what was there.
        if let got = try? await Fleet(settings: settings).events() { events = got }
        loaded = true
    }

    /// One row: the kind's label, its subject in mono, a count for a run,
    /// and who and when under it. The label is ReasonWords.activity, which
    /// knows every kind the coordinator records and shows the kind itself
    /// for one it does not (C-5: a word is not made up for news this build
    /// has never met). The subject is what the event names: a session or a
    /// pool by `name`, else the machine.
    private func eventRow(_ run: EventRun) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.insideTight) {
                Text(ReasonWords.activity(run.event.event, verb: run.event.verb)).fleetType(.body)
                if let subject = describeEventSubject(run.event) {
                    Text(subject).fleetType(.labelMono).foregroundStyle(Design.Palette.inkDim)
                }
                if run.count > 1 {
                    Text("×\(run.count)")
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.inkDim)
                }
                Spacer(minLength: 0)
            }
            Text(describeEventWho(run.event))
                .fleetType(.label)
                .foregroundStyle(Design.Palette.inkDim)
        }
    }

    /// What the event is about: its `name` (a session, a pool's address), else
    /// its machine, or nil for news about the fleet as a whole. "coordinator"
    /// is not a machine (describeEventWho says the same).
    private func describeEventSubject(_ e: Fleet.Event) -> String? {
        if let n = e.name, !n.isEmpty { return n }
        if let h = e.hostId, !h.isEmpty, h != "coordinator" { return h }
        return nil
    }

    /// "on deb132 · 20 minutes ago", and who asked when it was not you. The
    /// machine only where the row's subject was something else (a session, a
    /// pool): where the machine is the subject it is already on the row.
    private func describeEventWho(_ e: Fleet.Event) -> String {
        var parts: [String] = []
        // "on coordinator" IS NOT A PLACE. It is where everything happens.
        if let h = e.hostId, !h.isEmpty, h != "coordinator", !(e.name ?? "").isEmpty { parts.append("on \(h)") }
        // NULL ACTOR IS THE FLEET ACTING ON ITS OWN, and your own name is not
        // news on a list where every entry was the same person.
        if let a = e.actor, !a.isEmpty {
            if a != settings.signedInAs { parts.append(a) }
        } else {
            parts.append("the fleet")
        }
        parts.append(relativeTime(e.at))
        return parts.joined(separator: " · ")
    }
}
