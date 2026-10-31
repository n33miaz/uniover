package br.uniover.launcher

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateFormat
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.Toast
import br.uniover.launcher.apps.AppRepository
import br.uniover.launcher.apps.AppSelector
import br.uniover.launcher.config.ClockConfig
import br.uniover.launcher.config.ClockFormat
import br.uniover.launcher.config.ClockSize
import br.uniover.launcher.config.ConfigStore
import br.uniover.launcher.config.IconsConfig
import br.uniover.launcher.config.LauncherConfig
import br.uniover.launcher.config.WallpaperConfig
import br.uniover.launcher.config.WallpaperType
import br.uniover.launcher.ui.AppTile
import br.uniover.launcher.ui.Metrics
import br.uniover.launcher.ui.Wallpaper
import java.io.File
import java.util.Locale

/**
 * A tela inicial da TV: relógio grande no centro e, embaixo, uma fileira centrada de apps em círculos.
 *
 * Sem serviço, sem rede, sem biblioteca de interface: a tela é montada em código só com o framework e relê a
 * configuração a cada vez que volta para a frente (o agente grava o arquivo e abre a home de novo).
 */
class HomeActivity : Activity() {
    private enum class Kind { APP, SETTINGS, SLEEP }

    /** O que cada ícone da fileira é. Duas listas iguais não precisam redesenhar a fileira. */
    private data class TileSpec(val kind: Kind, val id: String, val label: String)

    /** Tudo que já está desenhado, para só mexer no que mudou (e não perder o foco à toa). */
    private data class Applied(
        val wallpaper: WallpaperConfig,
        val photoStamp: Long,
        val clock: ClockConfig,
        val icons: IconsConfig,
        val tiles: List<TileSpec>,
    )

    private lateinit var store: ConfigStore
    private lateinit var repo: AppRepository
    private lateinit var metrics: Metrics

    private lateinit var backdrop: ImageView
    private lateinit var dim: View
    private lateinit var clock: TextClock
    private lateinit var date: TextClock
    private lateinit var scroller: HorizontalScrollView
    private lateinit var row: LinearLayout

    private var applied: Applied? = null
    private var photoToken = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = (application as LauncherApp).configStore
        repo = AppRepository(this)
        val display = resources.displayMetrics
        metrics = Metrics(display.widthPixels, display.heightPixels)
        setContentView(buildLayout())
    }

    override fun onResume() {
        super.onResume()
        // Se o receptor receber uma configuração enquanto a home está na tela, redesenha na hora.
        ConfigSignal.listener = { refresh() }
        refresh()
    }

    override fun onPause() {
        ConfigSignal.listener = null
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Home apertado com a home já aberta: volta o foco para o primeiro app, como as outras homes.
        if (intent.hasCategory(Intent.CATEGORY_HOME)) {
            scroller.scrollTo(0, 0)
            firstTile()?.requestFocus()
        }
    }

    // A home é o fim da pilha: o Voltar não pode fechá-la (a TV ficaria sem tela inicial).
    @Deprecated("Sem fechar a home")
    override fun onBackPressed() = Unit

    // ---------------------------------------------------------------- layout

    private fun buildLayout(): View {
        val root = FrameLayout(this)

        backdrop = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        root.addView(backdrop, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // Escurecimento por cima da foto (só aparece com foto), para o relógio e os nomes continuarem legíveis.
        dim = View(this).apply { visibility = View.GONE }
        root.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            clipChildren = false
        }

        clock = TextClock(this).apply {
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            includeFontPadding = false
            gravity = Gravity.CENTER
            // Algarismos de largura fixa: o relógio não "treme" quando o minuto muda.
            fontFeatureSettings = "tnum"
            setShadowLayer(12f, 0f, 3f, 0x66000000)
        }
        date = TextClock(this).apply {
            setTextColor(0xCCFFFFFF.toInt())
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            includeFontPadding = false
            gravity = Gravity.CENTER
            setShadowLayer(8f, 0f, 2f, 0x66000000)
        }
        column.addView(clock, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(date, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = (metrics.dateText(ClockSize.LARGE) * 0.4f).toInt()
        })

        row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            // Com poucos apps a fileira fica centrada; com muitos, rola e o app focado é trazido ao centro.
            gravity = Gravity.CENTER
            clipChildren = false
        }
        scroller = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isFillViewport = true
            clipChildren = false
            clipToPadding = false
            setPadding(metrics.horizontalPadding, metrics.rowVerticalPadding, metrics.horizontalPadding, metrics.rowVerticalPadding)
            addView(row, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        column.addView(scroller, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = metrics.clockToRowGap
        })

        root.addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return root
    }

    // ---------------------------------------------------------------- atualização

    /** Relê a configuração e os apps e mexe só no que mudou. Nunca lança: a home precisa continuar de pé. */
    private fun refresh() {
        try {
            val config = store.load()
            val photo = if (config.wallpaper.type == WallpaperType.PHOTO) store.photoFile(config.wallpaper.photo) else null
            val tiles = buildTileSpecs(config)
            val next = Applied(config.wallpaper, photo?.lastModified() ?: 0L, config.clock, config.icons, tiles)
            val previous = applied
            if (previous == next) return
            if (previous == null || previous.wallpaper != next.wallpaper || previous.photoStamp != next.photoStamp) {
                applyWallpaper(config.wallpaper, photo)
            }
            if (previous == null || previous.clock != next.clock) applyClock(config.clock)
            if (previous == null || previous.icons != next.icons || previous.tiles != next.tiles) {
                rebuildRow(config.icons, tiles)
            }
            applied = next
        } catch (e: RuntimeException) {
            // Última linha de defesa: o que já estava na tela continua.
            android.util.Log.w(TAG, "falha ao atualizar a home", e)
        }
    }

    private fun buildTileSpecs(config: LauncherConfig): List<TileSpec> {
        val selection = AppSelector.select(repo.installed(), config.apps, packageName)
        val specs = selection.apps.map { TileSpec(Kind.APP, it.packageName, it.label) }.toMutableList()
        if (config.builtin.sleep) specs += TileSpec(Kind.SLEEP, "builtin:sleep", getString(R.string.sleep_tile))
        // A saída de emergência: mesmo sem nenhum app, o botão de Configurações da TV continua ali.
        if (config.builtin.settings || specs.isEmpty()) {
            specs += TileSpec(Kind.SETTINGS, "builtin:settings", getString(R.string.settings_tile))
        }
        return specs
    }

    private fun applyWallpaper(config: WallpaperConfig, photo: File?) {
        photoToken++
        backdrop.setImageDrawable(Wallpaper.backdrop(config))
        if (config.type != WallpaperType.PHOTO || photo == null) {
            dim.visibility = View.GONE
            return
        }
        dim.setBackgroundColor(Color.argb((config.dim * 255).toInt(), 0, 0, 0))
        dim.visibility = View.VISIBLE
        val token = photoToken
        val display = resources.displayMetrics
        // Decodificar uma foto de 1080p leva alguns décimos de segundo: fora da thread principal, com o degradê
        // aparecendo enquanto isso.
        Thread({
            val bitmap = Wallpaper.decodePhoto(photo, display.widthPixels, display.heightPixels)
            runOnUiThread {
                if (bitmap != null && token == photoToken && !isDestroyed) backdrop.setImageBitmap(bitmap)
            }
        }, "wallpaper-decode").start()
    }

    private fun applyClock(config: ClockConfig) {
        clock.visibility = if (config.enabled) View.VISIBLE else View.GONE
        clock.setTextSize(TypedValue.COMPLEX_UNIT_PX, metrics.clockText(config.size).toFloat())
        val (twelve, twentyFour) = when (config.format) {
            ClockFormat.H24 -> (if (config.seconds) "HH:mm:ss" else "HH:mm").let { it to it }
            ClockFormat.H12 -> (if (config.seconds) "h:mm:ss a" else "h:mm a").let { it to it }
            ClockFormat.AUTO -> null to null
        }
        clock.format12Hour = twelve
        clock.format24Hour = twentyFour

        date.visibility = if (config.date) View.VISIBLE else View.GONE
        date.setTextSize(TypedValue.COMPLEX_UNIT_PX, metrics.dateText(config.size).toFloat())
        // O padrão de data certo para o idioma da TV ("sábado, 31 de outubro" em pt-BR).
        val datePattern = DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEEdMMMM")
        date.format12Hour = datePattern
        date.format24Hour = datePattern
    }

    private fun rebuildRow(icons: IconsConfig, tiles: List<TileSpec>) {
        // Procura o tile focado na própria fileira (não em currentFocus, que depende do estado da janela).
        val focusedId = (0 until row.childCount).map { row.getChildAt(it) as AppTile }.firstOrNull { it.isFocused }?.tileId
        row.removeAllViews()
        tiles.forEachIndexed { index, spec ->
            val tile = AppTile(
                context = this,
                metrics = metrics,
                iconSize = icons.size,
                labels = icons.labels,
                tileId = spec.id,
                label = spec.label,
                icon = iconFor(spec),
                onFocused = ::centerOnTile,
            )
            tile.setOnClickListener { open(spec) }
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                val half = metrics.tileSpacing / 2
                marginStart = if (index == 0) 0 else half
                marginEnd = if (index == tiles.lastIndex) 0 else half
            }
            row.addView(tile, params)
        }
        // Mantém o foco no mesmo app depois de reconstruir; na primeira vez, o primeiro.
        val target = (0 until row.childCount).map { row.getChildAt(it) as AppTile }
            .firstOrNull { it.tileId == focusedId } ?: firstTile()
        row.post { target?.requestFocus() }
    }

    private fun iconFor(spec: TileSpec) = when (spec.kind) {
        Kind.APP -> repo.icon(spec.id)
        Kind.SETTINGS -> getDrawable(R.drawable.ic_settings)
        Kind.SLEEP -> getDrawable(R.drawable.ic_sleep)
    }

    private fun firstTile(): AppTile? = row.getChildAt(0) as? AppTile

    /** Traz o app focado para o centro da fileira (quando ela é mais larga que a tela). */
    private fun centerOnTile(tile: AppTile) {
        val target = scroller.paddingLeft + tile.left + tile.width / 2 - scroller.width / 2
        scroller.smoothScrollTo(target.coerceAtLeast(0), 0)
    }

    // ---------------------------------------------------------------- ações

    private fun open(spec: TileSpec) {
        try {
            when (spec.kind) {
                Kind.APP -> {
                    val intent = repo.launchIntent(spec.id) ?: throw ActivityNotFoundException(spec.id)
                    startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
                }
                Kind.SETTINGS -> openSettings()
                Kind.SLEEP -> startActivity(Intent(this, SleepActivity::class.java))
            }
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show()
        } catch (_: SecurityException) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show()
        }
    }

    private fun openSettings() {
        val candidates = listOf(
            Intent(Settings.ACTION_SETTINGS),
            repo.launchIntent("com.android.tv.settings"),
            repo.launchIntent("com.android.settings"),
        )
        for (intent in candidates.filterNotNull()) {
            try {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: ActivityNotFoundException) {
                // tenta o próximo
            }
        }
        throw ActivityNotFoundException("settings")
    }

    private companion object {
        const val TAG = "UniOverHome"
    }
}
