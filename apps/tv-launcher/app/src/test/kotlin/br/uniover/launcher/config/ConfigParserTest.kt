package br.uniover.launcher.config

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigParserTest {
    private fun parse(json: String) = ConfigParser.parse(json)

    private fun accepted(json: String): LauncherConfig {
        val result = parse(json)
        assertNotNull("recusado: ${result.rejected}", result.config)
        return result.config!!
    }

    @Test
    fun `minimal config gets every default`() {
        val result = parse("""{ "schema": 1, "revision": 0 }""")
        assertEquals(LauncherConfig.DEFAULT, result.config)
        assertTrue(result.warnings.isEmpty())
    }

    @Test
    fun `defaults describe the approved home`() {
        val c = LauncherConfig.DEFAULT
        assertEquals(ClockSize.LARGE, c.clock.size)
        assertEquals(ClockFormat.H24, c.clock.format)
        assertTrue(c.clock.date)
        assertEquals(WallpaperType.GRADIENT, c.wallpaper.type)
        assertEquals(AppsMode.ALL, c.apps.mode)
        assertFalse("apps de fábrica ficam ocultos por padrão", c.apps.showFactory)
        assertTrue("Configurações é a saída de emergência", c.builtin.settings)
        assertFalse(c.builtin.sleep)
        assertEquals(0, c.sleep.maxMinutes)
    }

    @Test
    fun `full config is read field by field`() {
        val c = accepted(File(contractsDir(), "examples/valid/full.json").readText())
        assertEquals(42, c.revision)
        assertEquals(ClockSize.LARGE, c.clock.size)
        assertEquals(listOf(0xFF10151F.toInt(), 0xFF2B3A67.toInt(), 0xFF6C5B9E.toInt()), c.wallpaper.colors)
        assertEquals(270, c.wallpaper.angle)
        assertEquals(AppsMode.ALL, c.apps.mode)
        assertEquals(listOf("com.google.android.youtube.tv", "com.netflix.ninja"), c.apps.items)
        assertEquals(setOf("com.tcl.store", "com.example.bloatware"), c.apps.hidden)
        assertTrue(c.builtin.sleep)
        assertEquals(480, c.sleep.maxMinutes)
    }

    @Test
    fun `photo wallpaper keeps the file name and the dim`() {
        val c = accepted(File(contractsDir(), "examples/valid/photo.json").readText())
        assertEquals(WallpaperType.PHOTO, c.wallpaper.type)
        assertEquals("wallpaper.jpg", c.wallpaper.photo)
        assertEquals(0.3f, c.wallpaper.dim, 0.0001f)
        assertEquals(ClockFormat.AUTO, c.clock.format)
        assertTrue(c.clock.seconds)
        assertFalse(c.clock.date)
        assertEquals(LabelMode.FOCUS, c.icons.labels)
        assertEquals(IconSize.LARGE, c.icons.size)
    }

    @Test
    fun `listed mode keeps the order of the items`() {
        val c = accepted(File(contractsDir(), "examples/valid/listed.json").readText())
        assertEquals(AppsMode.LISTED, c.apps.mode)
        assertEquals(
            listOf("com.google.android.youtube.tv", "com.netflix.ninja", "com.spotify.tv.android"),
            c.apps.items,
        )
    }

    @Test
    fun `unknown schema version is rejected whole`() {
        val result = parse("""{ "schema": 2, "revision": 3 }""")
        assertNull(result.config)
        assertNotNull(result.rejected)
    }

    @Test
    fun `missing schema and garbage are rejected`() {
        assertNull(parse("""{ "revision": 1 }""").config)
        assertNull(parse("isso não é json").config)
        assertNull(parse("[1, 2]").config)
        assertNull(parse("""{ "schema": "1", "revision": 1 }""").config)
        assertNull(parse("").config)
    }

    @Test
    fun `truncated file is rejected, not half read`() {
        assertNull(parse("""{ "schema": 1, "revision": 5, "clock": { "size": "lar""").config)
    }

    @Test
    fun `oversized file is rejected`() {
        val padding = "x".repeat(ConfigParser.MAX_BYTES)
        assertNull(parse("""{ "schema": 1, "revision": 1, "junk": "$padding" }""").config)
    }

    @Test
    fun `invalid value falls back to the default with a warning`() {
        val result = parse("""{ "schema": 1, "revision": 1, "clock": { "size": "giant", "seconds": "yes" } }""")
        assertEquals(ClockSize.LARGE, result.config!!.clock.size)
        assertFalse(result.config!!.clock.seconds)
        assertEquals(2, result.warnings.size)
    }

    @Test
    fun `bad colors are dropped and the default gradient survives when none is valid`() {
        val partly = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "colors": ["#112233", "azul"] } }""")
        assertEquals(listOf(0xFF112233.toInt()), partly.wallpaper.colors)
        val none = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "colors": ["azul"] } }""")
        assertEquals(WallpaperConfig.DEFAULT_COLORS, none.wallpaper.colors)
    }

    @Test
    fun `gradient with a single color becomes solid`() {
        val c = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "type": "gradient", "colors": ["#112233"] } }""")
        assertEquals(WallpaperType.SOLID, c.wallpaper.type)
    }

    @Test
    fun `photo type without a valid photo falls back to gradient`() {
        val c = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "type": "photo" } }""")
        assertEquals(WallpaperType.GRADIENT, c.wallpaper.type)
        assertNull(c.wallpaper.photo)
    }

    @Test
    fun `photo name cannot leave the app folder`() {
        for (name in listOf("../../data/secret.jpg", "/sdcard/x.jpg", "a/b.jpg", "x.exe", "..")) {
            val c = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "type": "photo", "photo": "$name" } }""")
            assertNull("aceitou $name", c.wallpaper.photo)
            assertEquals(WallpaperType.GRADIENT, c.wallpaper.type)
        }
    }

    @Test
    fun `angle must be a multiple of 45`() {
        val ok = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "angle": 90 } }""")
        assertEquals(90, ok.wallpaper.angle)
        val bad = accepted("""{ "schema": 1, "revision": 1, "wallpaper": { "angle": 30 } }""")
        assertEquals(315, bad.wallpaper.angle)
    }

    @Test
    fun `invalid package names are dropped, duplicates collapse`() {
        val c = accepted(
            """{ "schema": 1, "revision": 1, "apps": { "mode": "listed",
               "items": ["com.a.b", "not a package", "com.a.b", "com.c.d"], "hidden": ["x"] } }""",
        )
        assertEquals(listOf("com.a.b", "com.c.d"), c.apps.items)
        assertTrue(c.apps.hidden.isEmpty())
    }

    @Test
    fun `unknown fields are ignored with a warning, never an error`() {
        val result = parse("""{ "schema": 1, "revision": 1, "systemName": { "mode": "text" }, "clock": { "extra": 1 } }""")
        assertNotNull(result.config)
        assertEquals(2, result.warnings.size)
    }

    @Test
    fun `missing revision reads as zero`() {
        val result = parse("""{ "schema": 1 }""")
        assertEquals(0, result.config!!.revision)
        assertEquals(1, result.warnings.size)
    }

    @Test
    fun `every valid contract example is accepted without warnings`() {
        val files = File(contractsDir(), "examples/valid").listFiles { f -> f.extension == "json" }!!
        assertTrue(files.isNotEmpty())
        for (file in files) {
            val result = parse(file.readText())
            assertNotNull("${file.name} recusado: ${result.rejected}", result.config)
            assertTrue("${file.name} gerou avisos: ${result.warnings}", result.warnings.isEmpty())
        }
    }

    @Test
    fun `every invalid contract example is rejected or flagged`() {
        val files = File(contractsDir(), "examples/invalid").listFiles { f -> f.extension == "json" }!!
        assertTrue(files.isNotEmpty())
        for (file in files) {
            val result = parse(file.readText())
            val flagged = result.config == null || result.warnings.isNotEmpty()
            assertTrue("${file.name} passou limpo pelo leitor", flagged)
        }
    }

    companion object {
        fun contractsDir(): File = File(System.getProperty("contracts.dir") ?: error("contracts.dir não definido"))
    }
}
