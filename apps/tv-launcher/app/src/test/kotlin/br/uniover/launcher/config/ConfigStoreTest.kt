package br.uniover.launcher.config

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ConfigStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val external get() = File(tmp.root, "external").apply { mkdirs() }
    private val internal get() = File(tmp.root, "internal").apply { mkdirs() }

    private fun store(externalAvailable: Boolean = true) =
        ConfigStore({ if (externalAvailable) external else null }, internal)

    private fun write(dir: File, revision: Int, extra: String = "") {
        File(dir, ConfigStore.CONFIG_NAME).writeText("""{ "schema": 1, "revision": $revision $extra }""")
    }

    @Test
    fun `no file at all gives the defaults`() {
        assertEquals(LauncherConfig.DEFAULT, store().load())
    }

    @Test
    fun `no external storage still works`() {
        write(internal, 3)
        assertEquals(3, store(externalAvailable = false).load().revision)
    }

    @Test
    fun `reads the file pushed to the external folder`() {
        write(external, 5, """, "clock": { "size": "small" }""")
        val config = store().load()
        assertEquals(5, config.revision)
        assertEquals(ClockSize.SMALL, config.clock.size)
    }

    @Test
    fun `the higher revision wins between the two sources`() {
        write(external, 4)
        write(internal, 9)
        assertEquals(9, store().load().revision)
    }

    @Test
    fun `a tie goes to the external file`() {
        write(external, 6, """, "clock": { "size": "small" }""")
        write(internal, 6, """, "clock": { "size": "medium" }""")
        assertEquals(ClockSize.SMALL, store().load().clock.size)
    }

    @Test
    fun `a half written file keeps the last good config`() {
        val store = store()
        write(external, 2)
        assertEquals(2, store.load().revision)

        File(external, ConfigStore.CONFIG_NAME).writeText("""{ "schema": 1, "revision": 3, "clock": { "si""")
        assertEquals("manteve a última boa", 2, store.load().revision)
        assertTrue(store.warnings.any { "recusado" in it })

        write(external, 3, """, "icons": { "labels": "never" }""")
        assertEquals(3, store.load().revision)
    }

    @Test
    fun `a garbage file on first read gives the defaults`() {
        File(external, ConfigStore.CONFIG_NAME).writeText("lixo")
        assertEquals(LauncherConfig.DEFAULT, store().load())
    }

    @Test
    fun `removing the file goes back to the defaults`() {
        val store = store()
        write(external, 8, """, "clock": { "enabled": false }""")
        assertFalse(store.load().clock.enabled)
        File(external, ConfigStore.CONFIG_NAME).delete()
        assertEquals(LauncherConfig.DEFAULT, store.load())
    }

    @Test
    fun `a change on disk is picked up`() {
        val store = store()
        write(external, 1)
        assertEquals(1, store.load().revision)
        write(external, 22)
        assertEquals(22, store.load().revision)
    }

    @Test
    fun `the temporary file used for atomic pushes is ignored`() {
        File(external, "${ConfigStore.CONFIG_NAME}.tmp").writeText("""{ "schema": 1, "revision": 99 }""")
        assertEquals(LauncherConfig.DEFAULT, store().load())
    }

    @Test
    fun `photo lookup finds a file in the external folder and refuses paths`() {
        File(external, "wallpaper.jpg").writeBytes(ByteArray(10) { 1 })
        val store = store()
        assertNotNull(store.photoFile("wallpaper.jpg"))
        assertNull(store.photoFile("../wallpaper.jpg"))
        assertNull(store.photoFile("sub/wallpaper.jpg"))
        assertNull(store.photoFile("missing.jpg"))
        assertNull(store.photoFile(null))
    }

    @Test
    fun `an empty photo file is refused`() {
        File(external, "empty.jpg").writeBytes(ByteArray(0))
        val store = store()
        assertNull(store.photoFile("empty.jpg"))
    }

    @Test
    fun `writeInternal replaces the file and leaves no temporary behind`() {
        val store = store()
        store.writeInternal("""{ "schema": 1, "revision": 1 }""")
        store.writeInternal("""{ "schema": 1, "revision": 2 }""")
        assertEquals(2, store.load().revision)
        assertFalse(File(internal, "${ConfigStore.CONFIG_NAME}.tmp").exists())
    }
}
