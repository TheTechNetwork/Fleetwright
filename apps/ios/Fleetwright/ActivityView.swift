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
                Text(loaded ? "Nothing recorded yet." : "Asking the fleet…")
                    .fleetType(.label).foregroundStyle(Design.Palette.inkDim)
            }
            // NEWEST FIRST HERE, oldest-first on the wire: right for a log and
            // wrong for a screen somebody opens to find out what they missed.
            ForEach(runs) { run in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(describeEvent(run.event)).fleetType(.body)
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

    /// The sentence for one event, with its subject named. The fleet records
    /// `text` for the events that have something to say, so this falls back
    /// to the event's own name rather than to an empty row.
    private func describeEvent(_ e: Fleet.Event) -> String {
        if let t = e.text, !t.isEmpty { return t }
        if let n = e.name, !n.isEmpty { return "\(e.event) — \(n)" }
        return e.event
    }

    /// "on deb132 · 20 minutes ago", and who asked when it was not you.
    private func describeEventWho(_ e: Fleet.Event) -> String {
        var parts: [String] = []
        // "on coordinator" IS NOT A PLACE. It is where everything happens.
        if let h = e.hostId, !h.isEmpty, h != "coordinator" { parts.append("on \(h)") }
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
