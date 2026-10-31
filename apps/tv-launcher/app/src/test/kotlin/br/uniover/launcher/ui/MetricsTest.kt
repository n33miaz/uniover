package br.uniover.launcher.ui

import br.uniover.launcher.config.ClockSize
import br.uniover.launcher.config.IconSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MetricsTest {
    private val full = Metrics(1920, 1080)

    @Test
    fun `clock is big and ordered by size`() {
        assertTrue(full.clockText(ClockSize.LARGE) > full.clockText(ClockSize.MEDIUM))
        assertTrue(full.clockText(ClockSize.MEDIUM) > full.clockText(ClockSize.SMALL))
        // O relógio grande ocupa perto de um sexto da altura da tela, como no desenho aprovado.
        assertEquals(184, full.clockText(ClockSize.LARGE))
    }

    @Test
    fun `icons are ordered by size and about a tenth of the width at the default`() {
        assertEquals(194, full.iconDiameter(IconSize.MEDIUM))
        assertTrue(full.iconDiameter(IconSize.LARGE) > full.iconDiameter(IconSize.MEDIUM))
        assertTrue(full.iconDiameter(IconSize.MEDIUM) > full.iconDiameter(IconSize.SMALL))
    }

    @Test
    fun `the focus ring never shrinks to nothing on a small screen`() {
        val tiny = Metrics(640, 360)
        assertTrue(tiny.ringStroke >= 3)
        assertTrue(tiny.ringGap >= 3)
    }

    @Test
    fun `proportions hold at 720p`() {
        val hd = Metrics(1280, 720)
        assertEquals(full.clockText(ClockSize.LARGE) * 2 / 3.0, hd.clockText(ClockSize.LARGE).toDouble(), 1.5)
    }

    @Test
    fun `a tile is the icon plus the ring and its gap on both sides`() {
        val d = full.iconDiameter(IconSize.MEDIUM)
        assertEquals(d + 2 * (full.ringStroke + full.ringGap), full.tileSide(IconSize.MEDIUM))
    }

    @Test
    fun `a portrait or odd screen uses the smaller side`() {
        assertEquals(Metrics(1080, 1920).clockText(ClockSize.LARGE), full.clockText(ClockSize.LARGE))
    }
}
