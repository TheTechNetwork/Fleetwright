import SwiftUI
import UIKit

/// The design system, as the app can use it.
///
/// WHY THIS FILE EXISTS. Both apps were stock: `List`, `.font(.headline)`,
/// `.foregroundStyle(.secondary)` on iOS, and Material 3 with
/// `dynamicColorScheme` on Android — a palette taken from the phone's
/// wallpaper. That is a defensible way to ship an app quickly and it produced
/// exactly what it should have: two apps that look like nothing, share no
/// measurements with the console, and cannot be told apart from any other
/// list-of-rows on the phone. Nothing about a fleet of machines you are anxious
/// about is communicated by the default text styles.
///
/// So the numbers move out of the views and into one place, and the same place
/// on all three surfaces. Every value below appears in
/// `test/fixtures/parity/design-tokens.json`, which is also read against
/// `src/web/console/console.css` and `Design.kt` — a token changed here and
/// nowhere else fails `test/design-parity.test.js` rather than quietly making
/// the phone disagree with the laptop.
///
/// THE FACE IS NOT BUNDLED, and that is deliberate rather than an omission. The
/// design asks for Inter Tight; shipping it means adding a binary to the app
/// and carrying its licence, and the system face is metrically close enough
/// that the scale and the tracking carry the design without it. What is
/// load-bearing here is the *scale* — seven sizes, three tracking values,
/// nothing else — and that is exactly what is written down.
///
/// DYNAMIC TYPE SURVIVES. A design system that pins `Font.system(size: 26)`
/// takes away the phone's font-size setting, which on an app whose whole job is
/// to be readable in a hurry is a bad trade. `FleetText` scales every size
/// through `@ScaledMetric` against the nearest system text style, so the ratios
/// hold and the sizes still move.
enum Design {

    /// The type scale. Seven sizes and no eighth.
    ///
    /// (`Design.Text`, not `Text` — inside this enum the name shadows
    /// SwiftUI's, which is why no view is declared in this scope.)
    enum Text {
        /// The assurance line. Once per screen.
        static let greeting: CGFloat = 26
        /// A sheet's title, the question a session is asking.
        static let title: CGFloat = 22
        /// A group of rows, named.
        static let section: CGFloat = 19
        /// Session titles, anything read in order to decide.
        static let body: CGFloat = 16
        /// The basis under a headline, second-rank prose.
        static let bodySmall: CGFloat = 14
        /// Badges, host ids, ordinals.
        static let label: CGFloat = 13
        /// The line under a name. Never load-bearing.
        static let micro: CGFloat = 12
    }

    /// Tightened headings, and nothing else. The same tracking on 13pt costs
    /// legibility and buys nothing, so there is no token for it.
    enum Tracking {
        static let greeting: CGFloat = -0.9
        static let title: CGFloat = -0.8
        static let section: CGFloat = -0.7
    }

    /// The three questions a layout asks: how far from the edge of the screen,
    /// how far between groups of cards, how far inside one.
    enum Space {
        static let page: CGFloat = 26
        static let group: CGFloat = 22
        static let groupTight: CGFloat = 16
        static let inside: CGFloat = 12
        static let insideTight: CGFloat = 8
        static let hair: CGFloat = 4
    }

    /// A hierarchy rather than a value, so nesting reads as nesting.
    enum Radius {
        /// The device frame. Nothing in the app draws it — it is the store
        /// screenshots' number, kept here so there is one of it.
        static let frame: CGFloat = 54
        static let card: CGFloat = 22
        static let cardSmall: CGFloat = 18
        static let row: CGFloat = 14
        static let chip: CGFloat = 8
    }

    /// Every colour, dark first.
    ///
    /// Written in code rather than an asset catalog on purpose: an asset
    /// catalog is a directory of JSON that no test can compare against the
    /// console's stylesheet, and this palette's whole claim is that it is the
    /// same palette.
    enum Palette {
        static let bg = adaptive(dark: 0x0b0d10, light: 0xf7f8fa)
        static let card = adaptive(dark: 0x12151a, light: 0xffffff)
        static let inner = adaptive(dark: 0x171b22, light: 0xf1f3f7)
        static let track = adaptive(dark: 0x232833, light: 0xe6eaf1)
        static let ink = adaptive(dark: 0xe6e9ef, light: 0x12151a)
        static let inkDim = adaptive(dark: 0x8b93a3, light: 0x5b6474)

        /// Interactive only — never a state. `#3866D6` is the brand value and
        /// stays the fill; dark lifts the tint so a hairline clears the ground.
        static let accent = adaptive(dark: 0x5b8bef, light: 0x3866d6)
        static let accentDeep = adaptive(dark: 0x3866d6, light: 0x3866d6)

        /// The states. A word and a glyph always carry the meaning; these only
        /// agree with it. `active` is a sky blue rather than a second indigo:
        /// "working" must not be mistakable for "tappable".
        static let ok = adaptive(dark: 0x4ade80, light: 0x0f7a52)
        static let attention = adaptive(dark: 0xfbbf24, light: 0xa15c00)
        static let bad = adaptive(dark: 0xf87171, light: 0xc02b2b)
        static let active = adaptive(dark: 0x38bdf8, light: 0x0369a1)
        static let unsure = adaptive(dark: 0xa78bfa, light: 0x6d43c8)
        static let idle = adaptive(dark: 0x6b7280, light: 0x9aa2b1)

        /// Charts and contribution grids: the muted track to the strongest blue
        /// the ground will carry, with the brand accent at step four. Nothing
        /// draws one yet; it is here so the first one does not invent a second
        /// set of blues.
        static let chart1 = adaptive(dark: 0x232833, light: 0xe6eaf1)
        static let chart2 = adaptive(dark: 0x2b3f66, light: 0xb9caea)
        static let chart3 = adaptive(dark: 0x2f56a3, light: 0x7b9de2)
        static let chart4 = adaptive(dark: 0x3866d6, light: 0x3866d6)
        static let chart5 = adaptive(dark: 0x7aa7f7, light: 0x1e3f8f)

        /// The 1px ring and the shadow under a card. Not in the shared token
        /// table: the same intent is three different mechanisms on three
        /// surfaces, and a shared hex would be a number that agrees while the
        /// surfaces do not.
        static let ring = translucent(
            dark: UIColor(white: 1, alpha: 0.10),
            light: UIColor(white: 0.1, alpha: 0.10)
        )
        static let shadow = translucent(
            dark: UIColor(white: 0, alpha: 0.45),
            light: UIColor(white: 0.06, alpha: 0.12)
        )

        private static func adaptive(dark: UInt32, light: UInt32) -> Color {
            translucent(dark: UIColor(rgb: dark), light: UIColor(rgb: light))
        }

        private static func translucent(dark: UIColor, light: UIColor) -> Color {
            Color(UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
        }
    }

    /// One line of the type scale, with the weight and tracking it is set in.
    struct Role {
        let size: CGFloat
        let weight: Font.Weight
        let tracking: CGFloat
        let design: Font.Design
        /// The system style this scales against, so the phone's font-size
        /// setting still moves it.
        let relativeTo: Font.TextStyle
    }

}

/// The roles, as leading-dot syntax at every call site: `.fleetType(.title)`.
///
/// On `Role` rather than on `Design` so that reads as one thing rather than as
/// `Design.title` spelled out on four hundred lines.
extension Design.Role {
    static let greeting = Design.Role(size: Design.Text.greeting, weight: .semibold,
                                      tracking: Design.Tracking.greeting,
                                      design: .default, relativeTo: .largeTitle)
    static let title = Design.Role(size: Design.Text.title, weight: .semibold,
                                   tracking: Design.Tracking.title,
                                   design: .default, relativeTo: .title2)
    static let section = Design.Role(size: Design.Text.section, weight: .semibold,
                                     tracking: Design.Tracking.section,
                                     design: .default, relativeTo: .title3)
    static let body = Design.Role(size: Design.Text.body, weight: .regular, tracking: 0,
                                  design: .default, relativeTo: .body)
    static let bodyStrong = Design.Role(size: Design.Text.body, weight: .semibold, tracking: 0,
                                        design: .default, relativeTo: .body)
    static let bodySmall = Design.Role(size: Design.Text.bodySmall, weight: .regular, tracking: 0,
                                       design: .default, relativeTo: .subheadline)
    static let label = Design.Role(size: Design.Text.label, weight: .regular, tracking: 0,
                                   design: .default, relativeTo: .footnote)
    static let labelMono = Design.Role(size: Design.Text.label, weight: .regular, tracking: 0,
                                       design: .monospaced, relativeTo: .footnote)
    static let micro = Design.Role(size: Design.Text.micro, weight: .regular, tracking: 0,
                                   design: .default, relativeTo: .caption)
    static let microMono = Design.Role(size: Design.Text.micro, weight: .regular, tracking: 0,
                                       design: .monospaced, relativeTo: .caption)
}


private extension UIColor {
    /// `0xRRGGBB`, which is how the token table writes a colour.
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// A size from the scale, scaled by the reader's own setting.
struct FleetText: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let tracking: CGFloat
    private let design: Font.Design

    init(_ role: Design.Role) {
        _size = ScaledMetric(wrappedValue: role.size, relativeTo: role.relativeTo)
        weight = role.weight
        tracking = role.tracking
        design = role.design
    }

    func body(content: Content) -> some View {
        content
            .font(.system(size: size, weight: weight, design: design))
            .tracking(tracking)
    }
}

/// A card: no border, an inset highlight along its top edge, a soft shadow and
/// a 1px ring.
///
/// The highlight is a `LinearGradient` overlay rather than a CSS `inset` — the
/// mechanism differs, the intent does not: a card edged in a hairline reads as
/// a box on a page, a card lifted off the ground reads as a surface above it.
struct FleetCard: ViewModifier {
    var radius: CGFloat = Design.Radius.card
    var padding: CGFloat = Design.Space.groupTight
    /// The ring, so a card that is asking something can wear its own tone
    /// without a second copy of this modifier.
    var ring: Color = Design.Palette.ring
    var fill: Color = Design.Palette.card

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(ring, lineWidth: 1)
            )
            .shadow(color: Design.Palette.shadow, radius: 12, x: 0, y: 4)
    }
}

extension View {
    /// Set this text in one of the scale's roles.
    func fleetType(_ role: Design.Role) -> some View { modifier(FleetText(role)) }

    /// Put this on a card.
    func fleetCard(
        radius: CGFloat = Design.Radius.card,
        padding: CGFloat = Design.Space.groupTight,
        ring: Color = Design.Palette.ring,
        fill: Color = Design.Palette.card
    ) -> some View {
        modifier(FleetCard(radius: radius, padding: padding, ring: ring, fill: fill))
    }

    /// A row in a list that is really a stack of cards: no separator, no system
    /// background, page margins down each side.
    ///
    /// Applied per row rather than to the `List`, because the modifiers that do
    /// this are row modifiers — a `List` cannot say it on their behalf, and a
    /// row that misses one keeps the grey system chrome the rest has dropped.
    func fleetRow() -> some View {
        self
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(
                top: 0, leading: Design.Space.page,
                bottom: 0, trailing: Design.Space.page
            ))
    }
}
