package br.uniover.launcher.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import br.uniover.launcher.LauncherApp
import br.uniover.launcher.config.IconSize
import br.uniover.launcher.config.LabelMode
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * O ícone de app enche o círculo de borda a borda (nunca um quadrado pequeno no meio), e os círculos do sistema são
 * desenho nosso, o mesmo traço do controle no app.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = LauncherApp::class)
class AppTileTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val metrics = Metrics(1920, 1080)

    private fun tile(
        icon: android.graphics.drawable.Drawable,
        system: Boolean = false,
        fallback: (() -> android.graphics.drawable.Drawable)? = null,
    ) = AppTile(
        context = context,
        metrics = metrics,
        iconSize = IconSize.MEDIUM,
        labels = LabelMode.ALWAYS,
        tileId = "x",
        label = "X",
        icon = icon,
        onFocused = {},
        system = system,
        fallback = fallback,
    )

    private fun imageOf(view: View): ImageView =
        if (view is ImageView) view
        else (0 until (view as ViewGroup).childCount).firstNotNullOf { runCatching { imageOf(view.getChildAt(it)) }.getOrNull() }

    /** Mede, depois do layout, a caixa útil da imagem dentro do círculo (sem a folga do padding). */
    private fun usefulBox(tile: AppTile): Pair<Int, Int> {
        val side = metrics.tileSide(IconSize.MEDIUM) * 2
        tile.measure(View.MeasureSpec.makeMeasureSpec(side, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(side * 2, View.MeasureSpec.AT_MOST))
        tile.layout(0, 0, tile.measuredWidth, tile.measuredHeight)
        val image = imageOf(tile)
        return (image.width - image.paddingLeft - image.paddingRight) to (image.height - image.paddingTop - image.paddingBottom)
    }

    /** Um desenho solto sobre o transparente que já toca as bordas: não há margem a aparar nem placa. */
    private fun freeFormIcon(): BitmapDrawable {
        val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
        for (y in 0 until 96) for (x in 0 until 96) {
            val inside = (x - 48) * (x - 48) + (y - 48) * (y - 48) <= 48 * 48
            bitmap.setPixel(x, y, if (inside && (x + y) % 3 != 0) Color.RED else Color.TRANSPARENT)
        }
        return BitmapDrawable(context.resources, bitmap)
    }

    @Test
    fun `an app icon fills the whole circle, with no inset, whatever the fit found`() {
        val diameter = metrics.iconDiameter(IconSize.MEDIUM)
        for (icon in listOf(freeFormIcon(), BitmapDrawable(context.resources, Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }))) {
            val tile = tile(icon)
            val (width, height) = usefulBox(tile)
            assertEquals("a imagem ocupa o círculo inteiro", diameter, width)
            assertEquals(diameter, height)
            assertEquals(ImageView.ScaleType.CENTER_CROP, imageOf(tile).scaleType)
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `an icon with no paint at all shows the initial on the package color, never an empty circle`() {
        val clear = BitmapDrawable(context.resources, Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888))
        val letter = FallbackIcon.drawable("com.exemplo.som", "Som")
        val tile = tile(clear, fallback = { letter })
        assertTrue("o ícone transparente ficou no lugar", imageOf(tile).drawable === letter)
        assertEquals(metrics.iconDiameter(IconSize.MEDIUM), usefulBox(tile).first)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `an adaptive icon with transparent layers shows the initial, a painted one stays as it is`() {
        // O desenho do adaptativo no Robolectric não respeita camadas transparentes: o teste controla o que ele pinta.
        fun adaptive(paint: Int?) = object : android.graphics.drawable.AdaptiveIconDrawable(null, null) {
            override fun draw(canvas: android.graphics.Canvas) { paint?.let { canvas.drawColor(it) } }
        }
        val letter = FallbackIcon.drawable("com.exemplo.som", "Som")
        assertTrue(imageOf(tile(adaptive(null), fallback = { letter })).drawable === letter)
        val painted = adaptive(Color.BLUE)
        assertTrue(imageOf(tile(painted, fallback = { letter })).drawable === painted)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `a small square in the middle of a wide transparent margin grows to fill the circle`() {
        // 40% do lado no meio: antes ficava um quadrado pequeno no centro do círculo.
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        for (y in 30 until 70) for (x in 30 until 70) bitmap.setPixel(x, y, Color.BLUE)
        val fit = IconFit.fit(BitmapDrawable(context.resources, bitmap), 200)
        val shown = (fit.drawable as BitmapDrawable).bitmap
        assertEquals("a borda do círculo é a cor da placa, não transparente", Color.BLUE, shown.getPixel(2, 100))
        assertEquals(Color.BLUE, shown.getPixel(100, 2))
    }

    @Test
    fun `a system circle keeps its glyph in the middle of a full plate`() {
        val diameter = metrics.iconDiameter(IconSize.MEDIUM)
        val tile = tile(context.getDrawable(br.uniover.launcher.R.drawable.ic_sleep)!!, system = true)
        val (width, _) = usefulBox(tile)
        val inset = (diameter * 0.24f).toInt()
        assertEquals(diameter - 2 * inset, width)
        assertEquals(ImageView.ScaleType.FIT_CENTER, imageOf(tile).scaleType)
    }

    @Test
    fun `the system glyphs are the same drawing as the controller in the app`() {
        // Uma fonte só: os `ic_*.xml` do launcher e o `tv-icon.ts` do app levam o mesmo caminho.
        val web = listOf(File("../../web/src/app/modules/tv/ui/tv-icon.ts"), File("apps/web/src/app/modules/tv/ui/tv-icon.ts"))
            .firstOrNull { it.isFile }
        assertTrue("o tv-icon.ts do app precisa estar ao lado (o repositório inteiro)", web != null)
        val source = web!!.readText()
        val pairs = mapOf("ic_settings" to "settings", "ic_network" to "wifi", "ic_inputs" to "input", "ic_sleep" to "sleep")
        val resDir = listOf(File("src/main/res/drawable"), File("app/src/main/res/drawable")).first { it.isDirectory }
        for ((drawable, name) in pairs) {
            val xml = File(resDir, "$drawable.xml").readText()
            val androidPath = Regex("android:pathData=\"([^\"]+)\"").find(xml)!!.groupValues[1]
            val webPath = Regex("(?m)^\\s*'?$name'?:\\s*(?:\\n\\s*)?'([^']+)'").find(source)?.groupValues?.get(1)
            assertTrue("o app não tem o desenho $name", webPath != null)
            assertEquals("$drawable.xml e o `$name` do app", webPath, androidPath)
        }
    }
}
