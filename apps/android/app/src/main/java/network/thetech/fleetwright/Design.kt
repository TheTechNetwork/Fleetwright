package network.thetech.fleetwright

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The design system, as Compose can use it.
 *
 * WHY THIS FILE EXISTS. This app took its palette from the phone's wallpaper —
 * `dynamicDarkColorScheme(context)` — which is a real Android feature and was
 * the wrong call here. It means the app has no colour of its own: the same
 * screen is teal on one phone and mauve on another, none of it agrees with the
 * console, and "amber means something is waiting for you" cannot be true when
 * amber is whatever the wallpaper had. Everything else was Material defaults,
 * so the app looked like a settings screen for a product nobody has named.
 *
 * Every value below appears in `test/fixtures/parity/design-tokens.json`, which
 * is also read against `src/web/console/console.css` and `Design.swift`. A
 * token changed here and nowhere else fails `test/design-parity.test.js` rather
 * than quietly making this phone disagree with the other one.
 *
 * THE FACE IS NOT BUNDLED. The design asks for Inter Tight; shipping it means a
 * binary in the APK and its licence to carry, and the platform face is close
 * enough that the scale and the tracking carry the design without it. The
 * scale is what is load-bearing, and the scale is written down.
 *
 * SP, NOT DP, FOR TYPE — so the phone's font-size setting still moves it. A
 * design system that pins text in dp takes that away, on an app whose whole job
 * is to be readable in a hurry.
 */
object Design {

    /** The type scale. Seven sizes and no eighth. */
    object Text {
        /** The assurance line. Once per screen. */
        val greeting = 26.sp
        /** A sheet's title, the question a session is asking. */
        val title = 22.sp
        /** A group of rows, named. */
        val section = 19.sp
        /** Session titles, anything read in order to decide. */
        val body = 16.sp
        /** The basis under a headline, second-rank prose. */
        val bodySmall = 14.sp
        /** Chips, host ids, ordinals. */
        val label = 13.sp
        /** The line under a name. Never load-bearing. */
        val micro = 12.sp
    }

    /**
     * Tightened headings, and nothing else. The same tracking on 13sp costs
     * legibility and buys nothing, so there is no token for it.
     */
    object Tracking {
        val greeting = (-0.9).sp
        val title = (-0.8).sp
        val section = (-0.7).sp
    }

    /**
     * The three questions a layout asks: how far from the edge of the screen,
     * how far between groups of cards, how far inside one.
     */
    object Space {
        val page = 26.dp
        val group = 22.dp
        val groupTight = 16.dp
        val inside = 12.dp
        val insideTight = 8.dp
        val hair = 4.dp
    }

    /** A hierarchy rather than a value, so nesting reads as nesting. */
    object Radius {
        /**
         * The device frame. Nothing in the app draws it — it is the store
         * screenshots' number, kept here so there is one of it.
         */
        val frame = 54.dp
        val card = 22.dp
        val cardSmall = 18.dp
        val row = 14.dp
        val chip = 8.dp
    }

    /**
     * Every colour, as a pair. Dark first, because dark is the default and the
     * one tuned for a dark room.
     */
    object Palette {
        val bg = Tone(dark = 0xFF0b0d10, light = 0xFFf7f8fa)
        val card = Tone(dark = 0xFF12151a, light = 0xFFffffff)
        val inner = Tone(dark = 0xFF171b22, light = 0xFFf1f3f7)
        val track = Tone(dark = 0xFF232833, light = 0xFFe6eaf1)
        val ink = Tone(dark = 0xFFe6e9ef, light = 0xFF12151a)
        val inkDim = Tone(dark = 0xFF8b93a3, light = 0xFF5b6474)

        /**
         * Interactive only — never a state. `#3866D6` is the brand value and
         * stays the fill; dark lifts the tint so a hairline clears the ground.
         */
        val accent = Tone(dark = 0xFF5b8bef, light = 0xFF3866d6)
        val accentDeep = Tone(dark = 0xFF3866d6, light = 0xFF3866d6)

        /**
         * The states. The word always carries the meaning; these only agree
         * with it. `active` is a sky blue rather than a second indigo:
         * "working" must not be mistakable for "tappable".
         */
        val ok = Tone(dark = 0xFF4ade80, light = 0xFF0f7a52)
        val attention = Tone(dark = 0xFFfbbf24, light = 0xFFa15c00)
        val bad = Tone(dark = 0xFFf87171, light = 0xFFc02b2b)
        val active = Tone(dark = 0xFF38bdf8, light = 0xFF0369a1)
        val unsure = Tone(dark = 0xFFa78bfa, light = 0xFF6d43c8)
        val idle = Tone(dark = 0xFF6b7280, light = 0xFF9aa2b1)

        /**
         * Charts and contribution grids: the muted track to the strongest blue
         * the ground will carry, with the brand accent at step four. Nothing
         * draws one yet; it is here so the first one does not invent a second
         * set of blues.
         */
        val chart1 = Tone(dark = 0xFF232833, light = 0xFFe6eaf1)
        val chart2 = Tone(dark = 0xFF2b3f66, light = 0xFFb9caea)
        val chart3 = Tone(dark = 0xFF2f56a3, light = 0xFF7b9de2)
        val chart4 = Tone(dark = 0xFF3866d6, light = 0xFF3866d6)
        val chart5 = Tone(dark = 0xFF7aa7f7, light = 0xFF1e3f8f)

        /**
         * The ring around a card, and the shadow under it. Not in the shared
         * token table: the same intent is three different mechanisms on three
         * surfaces — a CSS box-shadow with an inset highlight, a SwiftUI
         * overlay stroke, and this — and a shared hex would be a number that
         * agrees while the surfaces do not.
         */
        val ring = Tone(dark = 0x1affffff, light = 0x1a101c28)
    }

    /**
     * The roles, spelled out, so a call site says which line of the scale it is
     * using rather than which Material slot happens to be near it.
     */
    object Style {
        val greeting = TextStyle(
            fontSize = Text.greeting,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = Tracking.greeting,
        )
        val title = TextStyle(
            fontSize = Text.title,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = Tracking.title,
        )
        val section = TextStyle(
            fontSize = Text.section,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = Tracking.section,
        )
        val body = TextStyle(fontSize = Text.body)
        val bodyStrong = TextStyle(fontSize = Text.body, fontWeight = FontWeight.SemiBold)
        val bodySmall = TextStyle(fontSize = Text.bodySmall)
        val label = TextStyle(fontSize = Text.label)
        val micro = TextStyle(fontSize = Text.micro)
    }
}

/**
 * One colour, in both themes.
 *
 * A pair rather than two palettes, because two palettes drift: the console kept
 * its light theme as a partial override of its dark one and lost a colour out
 * of it twice. Here a tone that exists at all exists in both.
 */
class Tone(private val dark: Long, private val light: Long) {
    fun color(isDark: Boolean): Color = Color(if (isDark) dark else light)
}

/** The tone as it is on this phone, right now. */
val Tone.now: Color
    @Composable get() = color(isSystemInDarkTheme())

/**
 * Material's slots, filled from the palette.
 *
 * Every untouched composable in the app reads its colour from one of these, so
 * filling them is what makes a screen nobody has restyled yet still belong to
 * the same app. `primary` is the accent and nothing else is: Material would
 * happily use it for a selected state, which is the "never a state" rule this
 * palette is built on.
 */
private fun scheme(isDark: Boolean) = if (isDark) {
    darkColorScheme(
        primary = Design.Palette.accent.color(true),
        onPrimary = Color.White,
        secondary = Design.Palette.accent.color(true),
        tertiary = Design.Palette.attention.color(true),
        background = Design.Palette.bg.color(true),
        onBackground = Design.Palette.ink.color(true),
        surface = Design.Palette.card.color(true),
        onSurface = Design.Palette.ink.color(true),
        surfaceVariant = Design.Palette.inner.color(true),
        onSurfaceVariant = Design.Palette.inkDim.color(true),
        error = Design.Palette.bad.color(true),
        outline = Design.Palette.inkDim.color(true),
        outlineVariant = Design.Palette.track.color(true),
    )
} else {
    lightColorScheme(
        primary = Design.Palette.accent.color(false),
        onPrimary = Color.White,
        secondary = Design.Palette.accent.color(false),
        tertiary = Design.Palette.attention.color(false),
        background = Design.Palette.bg.color(false),
        onBackground = Design.Palette.ink.color(false),
        surface = Design.Palette.card.color(false),
        onSurface = Design.Palette.ink.color(false),
        surfaceVariant = Design.Palette.inner.color(false),
        onSurfaceVariant = Design.Palette.inkDim.color(false),
        error = Design.Palette.bad.color(false),
        outline = Design.Palette.inkDim.color(false),
        outlineVariant = Design.Palette.track.color(false),
    )
}

/**
 * The scale, in the slots Material reaches for.
 *
 * Only the slots this app actually uses are overridden — a screen that has not
 * been restyled by hand still comes out on the scale rather than on Material's
 * defaults, which is the difference between a design system and a coat of paint
 * on the screens somebody remembered.
 */
private val FleetTypography = Typography(
    headlineMedium = Design.Style.greeting,
    headlineSmall = Design.Style.title,
    titleLarge = Design.Style.section,
    titleMedium = Design.Style.bodyStrong,
    titleSmall = Design.Style.bodyStrong,
    bodyLarge = Design.Style.body,
    bodyMedium = Design.Style.bodySmall,
    bodySmall = Design.Style.label,
    labelLarge = Design.Style.label,
    labelMedium = Design.Style.label,
    labelSmall = Design.Style.micro,
)

/** The radius hierarchy, in the slots Material's own components read. */
private val FleetShapes = Shapes(
    extraSmall = RoundedCornerShape(Design.Radius.chip),
    small = RoundedCornerShape(Design.Radius.chip),
    medium = RoundedCornerShape(Design.Radius.row),
    large = RoundedCornerShape(Design.Radius.cardSmall),
    extraLarge = RoundedCornerShape(Design.Radius.card),
)

/** The app's theme. One call, at the top, and nothing under it is stock. */
@Composable
fun FleetwrightTheme(isDark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = scheme(isDark),
        typography = FleetTypography,
        shapes = FleetShapes,
        content = content,
    )
}

/**
 * A card: no border, a soft shadow and a 1px ring.
 *
 * Compose has no inset highlight and no multi-layer box-shadow, so the ring
 * does the work the highlight does on the web. The intent is the one the design
 * states — a card edged in a hairline reads as a box on a page, a card lifted
 * off the ground reads as a surface above it — and this is that intent in the
 * mechanism this platform has.
 *
 * `clip = false` on the shadow, because a clipped shadow is not a shadow.
 */
@Composable
fun Modifier.fleetCard(
    radius: Dp = Design.Radius.card,
    fill: Color = Design.Palette.card.now,
    ring: Color = Design.Palette.ring.now,
    elevation: Dp = 6.dp,
): Modifier {
    val shape = RoundedCornerShape(radius)
    return this
        .shadow(elevation, shape, clip = false)
        .background(fill, shape)
        .border(1.dp, ring, shape)
}
