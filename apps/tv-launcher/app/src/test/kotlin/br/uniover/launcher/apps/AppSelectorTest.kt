package br.uniover.launcher.apps

import br.uniover.launcher.config.AppsConfig
import br.uniover.launcher.config.AppsMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppSelectorTest {
    private val self = "br.uniover.launcher"

    private val youtube = InstalledApp("com.google.android.youtube.tv", "YouTube", isFactory = false)
    private val netflix = InstalledApp("com.netflix.ninja", "Netflix", isFactory = false)
    private val spotify = InstalledApp("com.spotify.tv.android", "Spotify", isFactory = false)
    private val store = InstalledApp("com.tcl.store", "Loja", isFactory = true)
    private val settings = InstalledApp("com.android.tv.settings", "Configurações", isFactory = true)
    private val me = InstalledApp(self, "TV Livre", isFactory = false)
    private val installed = listOf(spotify, store, netflix, me, settings, youtube)

    private fun ids(selection: Selection) = selection.apps.map { it.packageName }

    @Test
    fun `listed mode shows only the items, in the given order`() {
        val config = AppsConfig(mode = AppsMode.LISTED, items = listOf(netflix.packageName, youtube.packageName))
        val selection = AppSelector.select(installed, config, self)
        assertEquals(listOf(netflix.packageName, youtube.packageName), ids(selection))
        assertFalse(selection.fellBack)
    }

    @Test
    fun `listed mode skips what is not installed`() {
        val config = AppsConfig(mode = AppsMode.LISTED, items = listOf("com.not.installed", spotify.packageName))
        assertEquals(listOf(spotify.packageName), ids(AppSelector.select(installed, config, self)))
    }

    @Test
    fun `all mode puts the items first and the rest alphabetically`() {
        val config = AppsConfig(mode = AppsMode.ALL, items = listOf(youtube.packageName))
        // Netflix e Spotify em ordem alfabética depois do YouTube; Loja e Configurações são de fábrica.
        assertEquals(
            listOf(youtube.packageName, netflix.packageName, spotify.packageName),
            ids(AppSelector.select(installed, config, self)),
        )
    }

    @Test
    fun `factory apps are hidden by default and can be shown`() {
        val hidden = AppSelector.select(installed, AppsConfig(), self)
        assertFalse(store.packageName in ids(hidden))
        assertFalse(settings.packageName in ids(hidden))

        val shown = AppSelector.select(installed, AppsConfig(showFactory = true), self)
        assertTrue(store.packageName in ids(shown))
        assertTrue(settings.packageName in ids(shown))
    }

    @Test
    fun `a factory app named in items is shown anyway`() {
        val config = AppsConfig(mode = AppsMode.ALL, items = listOf(settings.packageName))
        val result = ids(AppSelector.select(installed, config, self))
        assertEquals(settings.packageName, result.first())
        assertFalse(store.packageName in result)
    }

    @Test
    fun `hidden beats everything`() {
        val config = AppsConfig(
            mode = AppsMode.ALL,
            items = listOf(netflix.packageName),
            hidden = setOf(netflix.packageName, spotify.packageName),
        )
        assertEquals(listOf(youtube.packageName), ids(AppSelector.select(installed, config, self)))
    }

    @Test
    fun `the launcher itself never appears`() {
        val all = AppSelector.select(installed, AppsConfig(showFactory = true), self)
        assertFalse(self in ids(all))
        val listed = AppSelector.select(installed, AppsConfig(mode = AppsMode.LISTED, items = listOf(self)), self)
        assertFalse(self in ids(listed))
    }

    @Test
    fun `an empty result falls back to everything so the home is never empty`() {
        val config = AppsConfig(mode = AppsMode.LISTED, items = listOf("com.not.installed"))
        val selection = AppSelector.select(installed, config, self)
        assertTrue(selection.fellBack)
        assertEquals(
            listOf(settings.packageName, store.packageName, netflix.packageName, spotify.packageName, youtube.packageName),
            ids(selection),
        )
    }

    @Test
    fun `hiding every app also falls back`() {
        val config = AppsConfig(mode = AppsMode.LISTED, items = listOf(netflix.packageName), hidden = setOf(netflix.packageName))
        assertTrue(AppSelector.select(installed, config, self).fellBack)
    }

    @Test
    fun `nothing installed gives an empty list without falling back`() {
        val selection = AppSelector.select(emptyList(), AppsConfig(), self)
        assertTrue(selection.apps.isEmpty())
        assertFalse(selection.fellBack)
    }

    @Test
    fun `duplicates by package collapse`() {
        val twice = listOf(netflix, netflix.copy(label = "Netflix 2"), youtube)
        assertEquals(2, AppSelector.select(twice, AppsConfig(), self).apps.size)
    }

    @Test
    fun `alphabetical order ignores case`() {
        val apps = listOf(
            InstalledApp("a.b", "zebra", false),
            InstalledApp("c.d", "Abacate", false),
            InstalledApp("e.f", "banana", false),
        )
        assertEquals(listOf("c.d", "e.f", "a.b"), ids(AppSelector.select(apps, AppsConfig(), self)))
    }
}
