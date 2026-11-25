package br.uniover.launcher.ui

import br.uniover.launcher.apps.SystemApps
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reserva (inicial sobre a cor do pacote) e os apps do sistema com desenho nosso são os mesmos da TV e do controle no
 * app: as tabelas daqui são lidas contra as do app, e os números conferidos são os mesmos do teste do app.
 */
class FallbackIconTest {
    private fun web(path: String): String {
        val file = listOf(File("../../web/src/app/modules/tv/$path"), File("apps/web/src/app/modules/tv/$path")).firstOrNull { it.isFile }
        assertTrue("o $path do app precisa estar ao lado (o repositório inteiro)", file != null)
        return file!!.readText()
    }

    @Test
    fun `each package gets the same color index as in the app`() {
        // Os mesmos números do `app-icon-source.spec.ts`.
        assertEquals(4, FallbackIcon.hue("com.netflix.ninja"))
        assertEquals(3, FallbackIcon.hue("com.exemplo.som"))
        assertEquals(0, FallbackIcon.hue("br.com.globo.globoplay"))
    }

    @Test
    fun `the six colors are the ones of the app tile`() {
        val css = web("ui/app-icon.css")
        val hues = Regex("""\.hue-(\d)\s*\{\s*--hue:\s*#([0-9a-fA-F]{6})""").findAll(css)
            .associate { it.groupValues[1].toInt() to it.groupValues[2].toInt(16) }
        assertEquals(FallbackIcon.HUES.size, hues.size)
        FallbackIcon.HUES.forEachIndexed { index, color -> assertEquals("hue-$index", hues[index], color) }
    }

    @Test
    fun `the known brands have the same tint, ink and mark as in the app`() {
        val source = web("data/tv-suggestions.ts")
        val entries = Regex("""\{[^{}]*?key:\s*'[^']+'[^{}]*?\}""").findAll(source).map { it.value }.toList()
        assertTrue("a tabela de marcas do app não foi lida", entries.size >= 10)
        var checked = 0
        for (entry in entries) {
            val packages = Regex("""'([^']+)'""").findAll(Regex("""packages:\s*\[([^\]]*)\]""").find(entry)!!.groupValues[1])
                .map { it.groupValues[1] }.filterNot { it.startsWith("samsung.") }
            val tint = Regex("""tint:\s*'#([0-9a-fA-F]{6})'""").find(entry)!!.groupValues[1].toInt(16)
            val ink = Regex("""ink:\s*'#([0-9a-fA-F]{6})'""").find(entry)!!.groupValues[1].toInt(16)
            val mark = Regex("""mark:\s*'([^']+)'""").find(entry)?.groupValues?.get(1)
            for (pkg in packages) {
                assertEquals("marca de $pkg", FallbackIcon.Brand(tint, ink, mark), FallbackIcon.BRANDS[pkg])
                checked++
            }
        }
        assertEquals("a TV tem marcas que o app não tem", checked, FallbackIcon.BRANDS.size)
    }

    @Test
    fun `a brand uses its tint and mark, other apps the initial on their package color`() {
        val disney = FallbackIcon.look("com.disney.disneyplus", "Disney+")
        assertEquals(0xFF113CCF.toInt(), disney.background)
        assertEquals("D+", disney.glyph)
        val other = FallbackIcon.look("com.exemplo.som", "  som da sala")
        assertEquals("S", other.glyph)
        assertNotEquals(other.background, other.ink)
        assertEquals("·", FallbackIcon.glyph("+++"))
    }

    @Test
    fun `the system apps with our own drawing are the same as in the app`() {
        val source = web("ui/app-icon-source.ts")
        val block = Regex("""SYSTEM_APP_GLYPHS[^{]*\{([^}]*)\}""").find(source)!!.groupValues[1]
        val webTable = Regex("""'([^']+)':\s*'([^']+)'""").findAll(block).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(webTable, SystemApps.GLYPHS)
        // Os mesmos casos do `app-icon-source.spec.ts`.
        assertEquals("settings", SystemApps.glyph("com.android.tv.settings"))
        assertEquals("settings", SystemApps.glyph("com.tcl.settings"))
        assertEquals("settings", SystemApps.glyph("com.vendor.tvsettings"))
        assertNull(SystemApps.glyph("com.exemplo.settingsapp"))
        assertNull(SystemApps.glyph("com.netflix.ninja"))
    }
}
