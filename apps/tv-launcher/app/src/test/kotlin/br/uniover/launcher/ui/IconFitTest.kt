package br.uniover.launcher.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A análise do ícone sobre pixels ARGB (sem Android): os mesmos casos do azulejo do controle no app. */
class IconFitTest {
    private val clear = 0x00000000
    private val white = 0xFFFFFFFF.toInt()
    private val black = 0xFF000000.toInt()
    private val red = 0xFFD32F2F.toInt()

    private fun grid(size: Int, paint: (Int, Int) -> Int): IntArray =
        IntArray(size * size) { paint(it % size, it / size) }

    /** Um quadrado cheio de [color] de [from] a [to] (exclusivo) sobre fundo [outside]. */
    private fun square(size: Int, from: Int, to: Int, color: Int, outside: Int = clear) =
        grid(size) { x, y -> if (x in from until to && y in from until to) color else outside }

    private val tolerance = 0.0001f

    @Test
    fun `a transparent margin is trimmed down to the plate and the plate color becomes the background`() {
        val result = IconFit.analyze(square(64, 8, 56, black), 64, 64)
        assertEquals(8f / 64f, result.trim.left, tolerance)
        assertEquals(8f / 64f, result.trim.bottom, tolerance)
        assertEquals(black, result.background)
        assertFalse(result.blank)
    }

    @Test
    fun `a white frame around a colored plate is trimmed with one more pixel for the seam`() {
        val icon = grid(64) { x, y ->
            when {
                x in 8 until 56 && y in 8 until 56 -> red
                x in 3 until 61 && y in 3 until 61 -> white
                else -> clear
            }
        }
        val result = IconFit.analyze(icon, 64, 64)
        assertEquals(9f / 64f, result.trim.left, tolerance)
        assertEquals(9f / 64f, result.trim.top, tolerance)
        assertEquals(red, result.background)
    }

    @Test
    fun `a full bleed icon trims nothing and still reports its edge color`() {
        val result = IconFit.analyze(grid(64) { _, _ -> red }, 64, 64)
        assertEquals(0f, result.trim.left, tolerance)
        assertEquals(red, result.background)
    }

    @Test
    fun `a free form drawing keeps its own breathing room and has no plate`() {
        val drawing = grid(64) { x, y -> if ((x - 32) * (x - 32) + (y - 32) * (y - 32) < 15 * 15) red else clear }
        val result = IconFit.analyze(drawing, 64, 64)
        assertNull(result.background)
        // A caixa do desenho começa perto de 17; sobra essa margem menos a folga de 7% do lado.
        assertEquals(17f / 64f - 0.07f, result.trim.left, 0.02f)
    }

    @Test
    fun `no side loses more than the limit however wide the margin`() {
        val result = IconFit.analyze(square(64, 28, 36, black), 64, 64)
        assertEquals(IconFit.MAX_TRIM, result.trim.left, tolerance)
        assertEquals(IconFit.MAX_TRIM, result.trim.top, tolerance)
    }

    @Test
    fun `a stray pixel in the margin does not hold the trim`() {
        val icon = square(64, 8, 56, black)
        icon[2 * 64 + 2] = red
        val result = IconFit.analyze(icon, 64, 64)
        assertEquals(8f / 64f, result.trim.left, tolerance)
    }

    @Test
    fun `an image with no ink is blank and never fitted`() {
        val result = IconFit.analyze(IntArray(64 * 64), 64, 64)
        assertTrue(result.blank)
        assertFalse(IconFit.needsFit(result, IconFit.cropSquare(result.trim)))
    }

    @Test
    fun `what cannot be read safely trims nothing`() {
        assertEquals(0f, IconFit.analyze(IntArray(4), 2, 2).trim.left, tolerance)
        assertEquals(0f, IconFit.analyze(IntArray(10), 64, 64).trim.left, tolerance)
    }

    @Test
    fun `the crop is the larger side of what is left, centered and inside the image`() {
        val whole = IconFit.cropSquare(IconFit.Trim(0f, 0f, 0f, 0f))
        assertEquals(1f, whole.size, tolerance)
        val wide = IconFit.cropSquare(IconFit.Trim(0.1f, 0.2f, 0.1f, 0.2f))
        assertEquals(0.8f, wide.size, tolerance)
        assertEquals(0.1f, wide.x, tolerance)
        assertEquals(0.1f, wide.y, tolerance)
        val side = IconFit.cropSquare(IconFit.Trim(0.5f, 0f, 0f, 0f))
        assertTrue(side.x + side.size <= 1f + tolerance)
    }

    @Test
    fun `next to no trim is left alone unless there is a plate`() {
        val analysis = IconFit.Analysis(IconFit.Trim(0f, 0.002f, 0f, 0f), null)
        assertFalse(IconFit.needsFit(analysis, IconFit.cropSquare(analysis.trim)))
        val withPlate = IconFit.Analysis(IconFit.Trim(0f, 0f, 0f, 0f), red)
        assertTrue(IconFit.needsFit(withPlate, IconFit.cropSquare(withPlate.trim)))
        assertNotNull(withPlate.background)
    }
}
