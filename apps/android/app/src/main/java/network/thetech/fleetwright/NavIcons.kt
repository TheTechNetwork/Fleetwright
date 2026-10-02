package network.thetech.fleetwright

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The three tabs' marks, drawn here rather than taken from a library.
 *
 * The bar had labels and empty icon slots, so the three tabs read as three
 * words with nothing for the eye to land on. The core icon set has a list and a
 * person but nothing that says machine, and a wrench standing in for a server
 * would be the generic-icon default this design avoids. So they are three
 * strokes on the same 24-unit grid as SF Symbols' list, server rack and person,
 * which is what iOS shows in the same three places.
 *
 * Stroked in black and tinted by `Icon`, so the bar's selected and unselected
 * colours apply exactly as they would to any icon.
 */
object NavIcons {
    val sessions: ImageVector = stroked("Sessions") {
        moveTo(4f, 6f); horizontalLineTo(20f)
        moveTo(4f, 12f); horizontalLineTo(20f)
        moveTo(4f, 18f); horizontalLineTo(14f)
    }

    val machines: ImageVector = stroked("Machines") {
        rack(top = 4f)
        rack(top = 13f)
        // The two lights, one per box: a zero-length stroke with a round cap.
        moveTo(7f, 7.5f); horizontalLineTo(7.01f)
        moveTo(7f, 16.5f); horizontalLineTo(7.01f)
    }

    val you: ImageVector = stroked("You") {
        moveTo(16f, 8f)
        arcTo(4f, 4f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 8f, y1 = 8f)
        arcTo(4f, 4f, 0f, isMoreThanHalf = true, isPositiveArc = true, x1 = 16f, y1 = 8f)
        close()
        moveTo(4f, 21f)
        arcTo(8f, 8f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 20f, y1 = 21f)
    }

    /** One box of the rack: 18 by 7 at x 3, corners of 2. */
    private fun PathBuilder.rack(top: Float) {
        val bottom = top + 7f
        moveTo(5f, top); horizontalLineTo(19f)
        arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 21f, y1 = top + 2f)
        verticalLineTo(bottom - 2f)
        arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 19f, y1 = bottom)
        horizontalLineTo(5f)
        arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 3f, y1 = bottom - 2f)
        verticalLineTo(top + 2f)
        arcTo(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 5f, y1 = top)
        close()
    }

    private fun stroked(name: String, draw: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
            .path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathBuilder = draw,
            )
            .build()
}
