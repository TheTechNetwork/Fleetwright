import ActivityKit
import SwiftUI
import WidgetKit

/// The Lock Screen and Dynamic Island face of a hypervisor being added.
/// docs/hypervisors.md; the app starts the activity in XOSetupActivities and
/// the coordinator pushes each step to it.
///
/// A WIDGET EXTENSION OF ITS OWN, because that is the only place iOS draws a
/// Live Activity from. It compiles two files from the app beside its own:
/// XOSetupAttributes, so the activity the app starts is the one this draws,
/// and Design.swift, so the Lock Screen is on the same palette and scale as
/// the app and the console (docs/design-system.md). Nothing else, because
/// nothing else is wanted on a Lock Screen.
///
/// WHAT IT SAYS. The headline is the step's words, from XOSetupWords, so the
/// app's screen and this say the same sentence about the same moment; under
/// it a determinate bar for step N of M, and the machine's name, which a
/// notification about a machine already shows. The pool's address is not
/// drawn: the push does not carry it, and a Lock Screen is read by whoever is
/// holding the phone.
///
/// MOTION 2, as the rest of the product: a change of state crossfades the
/// words (`contentTransition(.opacity)`) and swaps the mark in place, the bar
/// moves to its new value, and nothing loops or pulses. A crossfade has no
/// travel, so Reduce Motion changes nothing here.
@main
struct FleetwrightActivityBundle: WidgetBundle {
    var body: some Widget {
        XOSetupActivityWidget()
    }
}

struct XOSetupActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: XOSetupAttributes.self) { context in
            // The Lock Screen follows the phone's appearance, and so does the
            // tint under it, so both resolve in the same scheme.
            XOSetupLockScreen(hostId: context.attributes.hostId, state: context.state, stale: context.isStale, purpose: context.attributes.purpose)
                .padding(Design.Space.groupTight)
                .activityBackgroundTint(Design.Palette.card)
                .activitySystemActionForegroundColor(Design.Palette.ink)
        } dynamicIsland: { context in
            // THE ISLAND IS ALWAYS BLACK, whatever the phone's appearance, so
            // everything in it is drawn in the dark palette, the one tuned for
            // a dark ground. Left to the environment, a light-mode phone would
            // resolve `ink` to near-black on black.
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    XOSetupMark(state: context.state, purpose: context.attributes.purpose)
                        .padding(.leading, Design.Space.insideTight)
                        .environment(\.colorScheme, .dark)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let ordinal = XOSetupWords.ordinal(context.state) {
                        Text(ordinal)
                            .fleetType(.label)
                            .foregroundStyle(Design.Palette.inkDim)
                            .contentTransition(.opacity)
                            .padding(.trailing, Design.Space.insideTight)
                            .environment(\.colorScheme, .dark)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    XOSetupLines(hostId: context.attributes.hostId, state: context.state, stale: context.isStale, purpose: context.attributes.purpose)
                        .padding(.horizontal, Design.Space.insideTight)
                        .environment(\.colorScheme, .dark)
                }
            } compactLeading: {
                XOSetupMark(state: context.state, purpose: context.attributes.purpose)
                    .environment(\.colorScheme, .dark)
            } compactTrailing: {
                // A ratio, where there is room for a ratio and not a sentence.
                if let compact = XOSetupMarks.compact(context.state) {
                    Text(compact)
                        .fleetType(.label)
                        .foregroundStyle(Design.Palette.ink)
                        .contentTransition(.opacity)
                        .environment(\.colorScheme, .dark)
                }
            } minimal: {
                XOSetupMark(state: context.state, purpose: context.attributes.purpose)
                    .environment(\.colorScheme, .dark)
            }
            .keylineTint(Design.Palette.active)
        }
    }
}

/// The glyph for the state. THE SHAPE SAYS IT, so the tone never has to on
/// its own: the stack of machines while it works, a check when it is done, a
/// cross when it stopped, a dash when the person stopped it. The same stack
/// is on the row in Machines that started it.
struct XOSetupMark: View {
    let state: XOSetupAttributes.ContentState
    /// `policy` for a change to what the fleet may use (XOSetupAttributes).
    var purpose: String? = nil

    var body: some View {
        Image(systemName: XOSetupMarks.symbol(state))
            .foregroundStyle(XOSetupMarks.tone(state))
            .contentTransition(.symbolEffect(.replace))
            .accessibilityLabel(XOSetupWords.headline(state, purpose: purpose))
    }
}

/// The headline, the bar and the machine, for the Lock Screen and the
/// expanded Island alike.
struct XOSetupLines: View {
    let hostId: String
    let state: XOSetupAttributes.ContentState
    /// Past the content's stale date: nothing has been heard for long enough
    /// that the step shown is no longer a claim about now.
    var stale: Bool = false
    /// `policy` for a change to what the fleet may use (XOSetupAttributes).
    var purpose: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.insideTight) {
            Text(XOSetupWords.headline(state, purpose: purpose))
                .fleetType(.bodyStrong)
                .foregroundStyle(Design.Palette.ink)
                .contentTransition(.opacity)
            // What the minutes are going on, while a build in parts runs:
            // without it the step's name sits still for ten minutes and only
            // the percentage moves, and a percentage of what is not said.
            if !stale, let detail = XOSetupWords.detail(state) {
                Text(detail)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
                    .contentTransition(.opacity)
            }
            if stale, XOSetupWords.isLive(state.state) {
                Text(XOSetupWords.silence(state))
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.inkDim)
            }
            // Only once the machine has said how many steps there are. A bar
            // with no length is a claim; no bar is not.
            if XOSetupWords.isLive(state.state), state.of > 0 {
                // The build's own progress while it says how far it has got
                // (XOSetupWords.bar), so the bar moves during the minutes the
                // edge router takes instead of resting on a step.
                let (value, total) = XOSetupWords.bar(state)
                ProgressView(value: value, total: total)
                    .tint(Design.Palette.active)
            }
            // A change to what the fleet may use is not a setup.
            Text(purpose == "policy" ? "What the fleet may use, on \(hostId)" : "Hypervisor setup on \(hostId)")
                .fleetType(.micro)
                .foregroundStyle(Design.Palette.inkDim)
        }
    }
}

/// The Lock Screen banner: the mark, the lines, and the ordinal where the
/// eye lands first on a banner, the top right.
struct XOSetupLockScreen: View {
    let hostId: String
    let state: XOSetupAttributes.ContentState
    var stale: Bool = false
    var purpose: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: Design.Space.inside) {
            XOSetupMark(state: state, purpose: purpose)
                .fleetType(.title)
                .padding(.top, Design.Space.hair)
            XOSetupLines(hostId: hostId, state: state, stale: stale, purpose: purpose)
            if let ordinal = XOSetupWords.ordinal(state) {
                Text(ordinal)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .contentTransition(.opacity)
            }
        }
    }
}

enum XOSetupMarks {
    static func symbol(_ s: XOSetupAttributes.ContentState) -> String {
        switch s.state {
        case "done": return "checkmark"
        case "failed": return "xmark"
        case "cancelled": return "minus"
        default: return "square.stack.3d.up"
        }
    }

    /// The tone agrees with the word (docs/design-system.md, "never colour
    /// alone"): finished is `ok`, stopped is `bad`, working is `active`, and
    /// a job the person stopped is neither good nor bad news.
    static func tone(_ s: XOSetupAttributes.ContentState) -> Color {
        switch s.state {
        case "done": return Design.Palette.ok
        case "failed": return Design.Palette.bad
        case "cancelled": return Design.Palette.inkDim
        default: return Design.Palette.active
        }
    }

    /// "3/8" for the compact Island, nil once it is over or before a count
    /// has been reported.
    static func compact(_ s: XOSetupAttributes.ContentState) -> String? {
        guard XOSetupWords.isLive(s.state), s.of > 0 else { return nil }
        if let fill = s.fill { return "\(fill / 10)%" }
        return "\(min(s.step + 1, s.of))/\(s.of)"
    }
}
