import SwiftUI

/// The line that says nothing needs you, and why it is confident of that.
///
/// docs/psychology.md names this as the product's real job and neither app was
/// doing it:
///
/// > The product's real job is to convert unbounded anxiety into bounded
/// > knowledge — and the important consequence is that *"nothing needs you"* is
/// > the most important state in the system, not the least. It is the state a
/// > person is in ninety-five percent of the time, and a surface that only
/// > becomes useful when something is wrong leaves the anxiety exactly where it
/// > was.
///
/// A list of rows is not that. Reading five rows and concluding that none of
/// them is asking anything is work, and it is work a person does again every
/// time they open the app — which is exactly the loop the anxiety runs in.
///
/// SILENCE HAS TO BE TRUSTWORTHY BEFORE IT IS COMFORTABLE (§7). So this never
/// says "all good" from an absence. It counts what it can see and NAMES WHAT IT
/// CANNOT: a host that is degraded, or that has stopped reporting, is the
/// difference between "nothing is happening" and "I have lost the ability to
/// tell you", and a summary that cannot tell them apart is worse than no
/// summary at all.
///
/// No badge, no streak, no number that moves for its own sake — see the end of
/// that document. Everything here is a fact somebody would act on.
struct Reassurance {
    let waiting: Int
    let running: Int
    let quiet: Int
    /// Hosts that are reporting something other than health, with their own
    /// words for it.
    let unwell: [String]
    /// True when we have no host report at all — which is not the same as a
    /// healthy fleet with nothing running.
    let blind: Bool
    /// Machines reporting normally.
    let healthy: Int

    init(sessions: [Fleet.Session], hosts: [Fleet.FleetHost]) {
        waiting = sessions.filter { $0.prompt != nil }.count
        running = sessions.filter { $0.isRunning }.count
        // Only the ones that look STALLED. Counting finished sessions as
        // "quiet a while" told somebody three things needed attention on a
        // fleet where everything had gone perfectly.
        quiet = sessions.filter { $0.looksStalled }.count
        unwell = hosts.filter { $0.state != "healthy" }.map { $0.hostId }
        blind = hosts.isEmpty
        healthy = hosts.count - hosts.filter { $0.state != "healthy" }.count
    }

    /// The headline. One clause, and the most urgent true one.
    var headline: String {
        if waiting > 0 { return waiting == 1 ? "One session is waiting for you" : "\(waiting) sessions are waiting for you" }
        if !unwell.isEmpty { return unwell.count == 1 ? "One machine needs a look" : "\(unwell.count) machines need a look" }
        if blind { return "No machines are reporting" }
        if running == 0 { return "Nothing is running" }
        return "Nothing needs you"
    }

    /// WHY it is confident, which is the half that does the work. A headline
    /// with no basis is a reassurance somebody has to take on faith, and the
    /// whole argument for this line is that they should not have to.
    var basis: String {
        if blind {
            return "The coordinator has no health from any machine, so this cannot say whether anything is running."
        }
        var parts: [String] = []
        if running > 0 { parts.append(running == 1 ? "1 session running" : "\(running) sessions running") }
        if quiet > 0 { parts.append(quiet == 1 ? "1 of them quiet a while" : "\(quiet) of them quiet a while") }
        if !unwell.isEmpty { parts.append(unwell.joined(separator: ", ")) }
        else { parts.append(hostsPhrase) }
        return parts.joined(separator: " · ")
    }

    private var hostsPhrase: String { healthy == 1 ? "1 machine healthy" : "\(healthy) machines healthy" }

    /// Worth a colour — and never colour alone (§5). The word above always
    /// carries the meaning; this only agrees with it.
    var tint: Color {
        if waiting > 0 { return .orange }
        if blind || !unwell.isEmpty { return .red }
        return .secondary
    }

    var symbol: String {
        if waiting > 0 { return "hand.raised" }
        if blind || !unwell.isEmpty { return "exclamationmark.triangle" }
        if running == 0 { return "moon.zzz" }
        return "checkmark.circle"
    }
}

/// The view. Deliberately one line and a second smaller one — this is the thing
/// somebody reads before deciding whether to read anything else, and a summary
/// that takes as long to read as the list it summarises has failed.
struct ReassuranceBanner: View {
    let summary: Reassurance

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: summary.symbol)
                .foregroundStyle(summary.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.headline).font(.subheadline.weight(.medium))
                Text(summary.basis).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        // One announcement rather than four fragments, because this is the one
        // line on the screen worth hearing first.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(summary.headline). \(summary.basis)")
    }
}
