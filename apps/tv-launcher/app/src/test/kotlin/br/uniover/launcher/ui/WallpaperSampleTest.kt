package br.uniover.launcher.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class WallpaperSampleTest {
    @Test
    fun `a photo already at screen size is not reduced`() {
        assertEquals(1, Wallpaper.sampleSize(1920, 1080, 1920, 1080))
    }

    @Test
    fun `a big photo is reduced by the largest power of two that still covers the screen`() {
        assertEquals(2, Wallpaper.sampleSize(4000, 3000, 1920, 1080))
        assertEquals(4, Wallpaper.sampleSize(8000, 6000, 1920, 1080))
    }

    @Test
    fun `reduction never makes the photo smaller than the screen`() {
        // 3840x2160 em tela 1920x1080: 2 deixa exatamente 1920x1080; 4 ficaria menor e ia esticar.
        assertEquals(2, Wallpaper.sampleSize(3840, 2160, 1920, 1080))
    }

    @Test
    fun `a photo that is wide but short is limited by the short side`() {
        assertEquals(1, Wallpaper.sampleSize(6000, 1500, 1920, 1080))
    }

    @Test
    fun `degenerate sizes are safe`() {
        assertEquals(1, Wallpaper.sampleSize(0, 0, 1920, 1080))
        assertEquals(1, Wallpaper.sampleSize(1000, 1000, 0, 0))
    }
}
