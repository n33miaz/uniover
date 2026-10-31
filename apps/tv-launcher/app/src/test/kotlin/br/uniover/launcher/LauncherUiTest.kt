package br.uniover.launcher

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextClock
import br.uniover.launcher.config.ConfigStore
import br.uniover.launcher.ui.AppTile
import br.uniover.launcher.ui.Wallpaper
import br.uniover.launcher.config.WallpaperConfig
import br.uniover.launcher.config.WallpaperType
import java.io.File
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * A home, o Modo Dormir e o receptor rodando no Robolectric (JVM, sem emulador). Cobrem a montagem da tela, a
 * ordem e a ocultação dos apps, o foco por D-pad e o que o manifesto promete. O desenho em pixels (anel, escala)
 * não é verificado aqui: isso só se vê num aparelho.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = LauncherApp::class)
class LauncherUiTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val app: LauncherApp get() = context as LauncherApp
    private val pm get() = context.packageManager

    @Before
    fun setUp() {
        install("com.google.android.youtube.tv", "YouTube", system = true, updated = true)
        install("com.netflix.ninja", "Netflix")
        install("com.spotify.tv.android", "Spotify")
        install("com.tcl.store", "Loja TCL", system = true)
        install("com.android.tv.settings", "Config TV", system = true)
    }

    @After
    fun tearDown() {
        File(context.getExternalFilesDir(null), ConfigStore.CONFIG_NAME).delete()
        File(context.filesDir, ConfigStore.CONFIG_NAME).delete()
        ConfigSignal.listener = null
    }

    // ---------------------------------------------------------------- apoio

    private fun install(pkg: String, label: String, system: Boolean = false, updated: Boolean = false) {
        val appInfo = ApplicationInfo().apply {
            packageName = pkg
            flags = (if (system) ApplicationInfo.FLAG_SYSTEM else 0) or
                (if (updated) ApplicationInfo.FLAG_UPDATED_SYSTEM_APP else 0)
            nonLocalizedLabel = label
        }
        shadowOf(pm).installPackage(PackageInfo().apply { packageName = pkg; applicationInfo = appInfo })

        val activity = ActivityInfo().apply {
            packageName = pkg
            name = "$pkg.Main"
            applicationInfo = appInfo
            nonLocalizedLabel = label
        }
        val resolve = ResolveInfo().apply {
            activityInfo = activity
            nonLocalizedLabel = label
        }
        shadowOf(pm).addResolveInfoForIntent(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER),
            resolve,
        )
    }

    private fun writeConfig(json: String) {
        File(context.getExternalFilesDir(null), ConfigStore.CONFIG_NAME).writeText(json)
    }

    private fun home() = Robolectric.buildActivity(HomeActivity::class.java).setup()

    private fun tilesOf(activity: HomeActivity): List<AppTile> = collect(activity.window.decorView).filterIsInstance<AppTile>()

    private fun collect(view: View): List<View> =
        listOf(view) + ((view as? ViewGroup)?.let { g -> (0 until g.childCount).flatMap { collect(g.getChildAt(it)) } } ?: emptyList())

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    // ---------------------------------------------------------------- home: apps

    @Test
    fun `without a config the home shows non factory apps alphabetically plus the settings tile`() {
        val activity = home().get()
        // YouTube é de sistema mas foi atualizado, então conta como app comum; Loja TCL e Config TV são de fábrica.
        assertEquals(
            listOf("com.netflix.ninja", "com.spotify.tv.android", "com.google.android.youtube.tv", "builtin:settings"),
            tilesOf(activity).map { it.tileId },
        )
    }

    @Test
    fun `listed config shows only those apps in that order`() {
        writeConfig("""{ "schema": 1, "revision": 1, "apps": { "mode": "listed",
            "items": ["com.spotify.tv.android", "com.netflix.ninja", "com.not.installed"] } }""")
        val activity = home().get()
        assertEquals(
            listOf("com.spotify.tv.android", "com.netflix.ninja", "builtin:settings"),
            tilesOf(activity).map { it.tileId },
        )
    }

    @Test
    fun `hidden apps and the optional sleep tile`() {
        writeConfig("""{ "schema": 1, "revision": 1, "apps": { "hidden": ["com.netflix.ninja"] },
            "builtin": { "settings": false, "sleep": true } }""")
        val activity = home().get()
        assertEquals(
            listOf("com.spotify.tv.android", "com.google.android.youtube.tv", "builtin:sleep"),
            tilesOf(activity).map { it.tileId },
        )
    }

    @Test
    fun `a config that would empty the home falls back to every app`() {
        writeConfig("""{ "schema": 1, "revision": 1, "apps": { "mode": "listed", "items": ["com.not.installed"] },
            "builtin": { "settings": false } }""")
        val ids = tilesOf(home().get()).map { it.tileId }
        // Rede de segurança: a lista pedida ficou vazia, então aparecem todos (inclusive os de fábrica).
        assertTrue(ids.containsAll(listOf("com.netflix.ninja", "com.tcl.store", "com.android.tv.settings")))
    }

    @Test
    fun `the launcher itself is not listed`() {
        install(context.packageName, "TV Livre")
        assertFalse(tilesOf(home().get()).any { it.tileId == context.packageName })
    }

    // ---------------------------------------------------------------- home: foco

    @Test
    fun `the first tile gets the focus and the D-pad walks the row`() {
        val activity = home().get()
        idle()
        val tiles = tilesOf(activity)
        assertTrue("o primeiro tile deveria ter foco", tiles.first().isFocused)
        assertSame(tiles[1], tiles[0].focusSearch(View.FOCUS_RIGHT))
        assertSame(tiles[0], tiles[1].focusSearch(View.FOCUS_LEFT))
        assertTrue(tiles.all { it.isFocusable && it.isClickable })
    }

    @Test
    fun `back does not close the home`() {
        val activity = home().get()
        @Suppress("DEPRECATION")
        activity.onBackPressed()
        assertFalse(activity.isFinishing)
    }

    @Test
    fun `focus stays on the same app when the list is rebuilt`() {
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
        idle()
        val activity = controller.get()
        assertTrue(tilesOf(activity)[1].requestFocus())
        idle()
        assertTrue("o segundo tile deveria ter foco antes de reconstruir", tilesOf(activity)[1].isFocused)
        writeConfig("""{ "schema": 1, "revision": 2, "icons": { "labels": "never" } }""")
        controller.pause().resume()
        idle()
        val focused = tilesOf(activity).first { it.isFocused }
        assertEquals("com.spotify.tv.android", focused.tileId)
    }

    // ---------------------------------------------------------------- home: cliques

    @Test
    fun `clicking the settings tile opens the system settings`() {
        val activity = home().get()
        tilesOf(activity).first { it.tileId == "builtin:settings" }.performClick()
        val started = shadowOf(activity).nextStartedActivity
        assertNotNull(started)
        assertEquals(android.provider.Settings.ACTION_SETTINGS, started.action)
    }

    @Test
    fun `clicking the sleep tile opens the sleep activity`() {
        writeConfig("""{ "schema": 1, "revision": 1, "builtin": { "sleep": true } }""")
        val activity = home().get()
        tilesOf(activity).first { it.tileId == "builtin:sleep" }.performClick()
        assertEquals(SleepActivity::class.java.name, shadowOf(activity).nextStartedActivity.component!!.className)
    }

    // ---------------------------------------------------------------- home: relógio e fundo

    @Test
    fun `clock follows the config`() {
        writeConfig("""{ "schema": 1, "revision": 1, "clock": { "format": "12h", "seconds": true, "date": false } }""")
        val activity = home().get()
        val clocks = collect(activity.window.decorView).filterIsInstance<TextClock>()
        assertEquals("h:mm:ss a", clocks[0].format12Hour.toString())
        assertEquals("h:mm:ss a", clocks[0].format24Hour.toString())
        assertEquals(View.GONE, clocks[1].visibility)
    }

    @Test
    fun `default clock is 24 hours with the date`() {
        val clocks = collect(home().get().window.decorView).filterIsInstance<TextClock>()
        assertEquals("HH:mm", clocks[0].format24Hour.toString())
        assertEquals(View.VISIBLE, clocks[0].visibility)
        assertEquals(View.VISIBLE, clocks[1].visibility)
    }

    @Test
    fun `a gradient wallpaper is a gradient drawable`() {
        writeConfig("""{ "schema": 1, "revision": 1, "wallpaper": { "colors": ["#112233", "#445566"], "angle": 270 } }""")
        val backdrop = collect(home().get().window.decorView).filterIsInstance<ImageView>().first()
        assertTrue(backdrop.drawable is GradientDrawable)
    }

    @Test
    fun `a missing photo falls back to the gradient instead of an empty background`() {
        writeConfig("""{ "schema": 1, "revision": 1, "wallpaper": { "type": "photo", "photo": "gone.jpg" } }""")
        val backdrop = collect(home().get().window.decorView).filterIsInstance<ImageView>().first()
        assertTrue(backdrop.drawable is GradientDrawable)
    }

    @Test
    fun `wallpaper helper picks gradient or solid and maps the angles`() {
        assertTrue(Wallpaper.backdrop(WallpaperConfig()) is GradientDrawable)
        assertTrue(Wallpaper.backdrop(WallpaperConfig(type = WallpaperType.SOLID)) is ColorDrawable)
        assertEquals(GradientDrawable.Orientation.TOP_BOTTOM, Wallpaper.orientationFor(270))
        assertEquals(GradientDrawable.Orientation.LEFT_RIGHT, Wallpaper.orientationFor(0))
        assertEquals(GradientDrawable.Orientation.TL_BR, Wallpaper.orientationFor(315))
    }

    @Test
    fun `a bad or missing photo file does not crash the decoder`() {
        // O BitmapFactory do Robolectric devolve um bitmap vazio para lixo (o do Android devolve nulo): aqui só
        // se confere que nada é lançado. A decodificação de verdade foi conferida no emulador.
        val file = File(context.cacheDir, "bad.jpg").apply { writeText("não sou uma imagem") }
        Wallpaper.decodePhoto(file, 1920, 1080)
        Wallpaper.decodePhoto(File(context.cacheDir, "nao-existe.jpg"), 1920, 1080)
    }

    @Test
    fun `a corrupt config never takes the home down`() {
        writeConfig("""{ "schema": 1, "revision": 1, "clock": {""")
        assertEquals(4, tilesOf(home().get()).size)
    }

    // ---------------------------------------------------------------- dormir

    @Test
    fun `sleep is black, keeps the screen on and any key wakes it`() {
        val controller = Robolectric.buildActivity(SleepActivity::class.java).setup()
        val activity = controller.get()
        assertTrue(activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
        assertFalse(activity.isFinishing)
        val consumed = activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER))
        assertTrue("a tecla que acorda é consumida", consumed)
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `sleep wakes on touch and swallows key up`() {
        val activity = Robolectric.buildActivity(SleepActivity::class.java).setup().get()
        assertTrue(activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK)))
        assertFalse("soltar a tecla não acorda", activity.isFinishing)
        activity.dispatchTouchEvent(android.view.MotionEvent.obtain(0, 0, android.view.MotionEvent.ACTION_DOWN, 1f, 1f, 0))
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `sleep leaves by itself after the configured time`() {
        writeConfig("""{ "schema": 1, "revision": 1, "sleep": { "maxMinutes": 30 } }""")
        val activity = Robolectric.buildActivity(SleepActivity::class.java).setup().get()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(29))
        assertFalse(activity.isFinishing)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(2))
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `sleep without a limit stays until a key`() {
        val activity = Robolectric.buildActivity(SleepActivity::class.java).setup().get()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofHours(12))
        assertFalse(activity.isFinishing)
    }

    // ---------------------------------------------------------------- receptor

    private fun send(json: String?): ConfigReceiver {
        val receiver = ConfigReceiver()
        val intent = Intent(ConfigReceiver.ACTION)
        if (json != null) intent.putExtra(ConfigReceiver.EXTRA_CONFIG_B64, Base64.encodeToString(json.toByteArray(), Base64.NO_WRAP))
        receiver.onReceive(context, intent)
        return receiver
    }

    @Test
    fun `receiver stores a valid config and tells the home`() {
        var notified = 0
        ConfigSignal.listener = { notified++ }
        send("""{ "schema": 1, "revision": 11, "clock": { "enabled": false } }""")
        assertEquals(1, notified)
        assertFalse(app.configStore.load().clock.enabled)
        assertEquals(11, app.configStore.load().revision)
        assertTrue(File(context.filesDir, ConfigStore.CONFIG_NAME).isFile)
    }

    @Test
    fun `receiver refuses what the parser refuses and changes nothing`() {
        var notified = 0
        ConfigSignal.listener = { notified++ }
        send("""{ "schema": 7, "revision": 11 }""")
        send("isso não é json")
        send(null)
        assertEquals(0, notified)
        assertFalse(File(context.filesDir, ConfigStore.CONFIG_NAME).exists())
    }

    @Test
    fun `receiver ignores other actions`() {
        ConfigReceiver().onReceive(context, Intent("outra.acao").putExtra(ConfigReceiver.EXTRA_CONFIG_B64, "e30="))
        assertFalse(File(context.filesDir, ConfigStore.CONFIG_NAME).exists())
    }

    // ---------------------------------------------------------------- manifesto

    @Test
    fun `the home answers the HOME intent and the leanback launcher intent`() {
        val home = pm.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
        assertNotNull(home)
        assertEquals(HomeActivity::class.java.name, home!!.activityInfo.name)
        val leanback = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER), 0)
        assertTrue(leanback.any { it.activityInfo.name == HomeActivity::class.java.name })
    }

    @Test
    fun `no permission is requested`() {
        val info = pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
        assertTrue(info.requestedPermissions.isNullOrEmpty())
    }

    @Test
    fun `sleep is exported for adb and the receiver needs the shell permission`() {
        val sleep = pm.getActivityInfo(ComponentName(context, SleepActivity::class.java), 0)
        assertTrue(sleep.exported)
        val receiver = pm.getReceiverInfo(ComponentName(context, ConfigReceiver::class.java), 0)
        assertTrue(receiver.exported)
        assertEquals("android.permission.DUMP", receiver.permission)
    }

    @Test
    fun `the home is a single task activity`() {
        val info = pm.getActivityInfo(ComponentName(context, HomeActivity::class.java), 0)
        assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, info.launchMode)
    }
}
