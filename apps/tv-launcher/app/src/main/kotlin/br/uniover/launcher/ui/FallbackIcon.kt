package br.uniover.launcher.ui

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import java.util.Locale

/**
 * O ícone de reserva de um app sem imagem (ou com imagem toda transparente): a inicial do nome sobre uma cor estável do
 * pacote, enchendo o círculo inteiro. É o mesmo azulejo de reserva do controle no app (`app-icon.ts`): o mesmo índice de
 * cor por pacote, as mesmas seis cores, e a cor parecida com a da marca (com a sua tinta e marca) para os apps
 * conhecidos. As tabelas daqui são conferidas contra as do app no teste, para os dois lados nunca divergirem.
 */
object FallbackIcon {
    /** Cor de fundo e tinta da letra, já resolvidas (ARGB). */
    data class Look(val background: Int, val ink: Int, val glyph: String)

    /** Marca conhecida: fundo parecido com a cor da marca, tinta com contraste AA e, às vezes, uma marca curta. */
    data class Brand(val tint: Int, val ink: Int, val mark: String? = null)

    /** As cores de reserva (as classes `hue-0` a `hue-5` do azulejo do app). */
    val HUES = intArrayOf(0x3b6b4b, 0x1f7a8c, 0x3a5a9b, 0x7a4a8a, 0xb5532e, 0x9a7416)

    /** O fundo e a tinta do tema escuro do app, com que a cor do pacote se mistura (a home da TV é escura). */
    private const val SURFACE = 0x181f1a
    private const val INK = 0xe9efea

    private const val WHITE = 0xffffff
    private const val DARK = 0x111111

    /** Os apps conhecidos do app (`tv-suggestions.ts`), só os pacotes Android. */
    val BRANDS: Map<String, Brand> = buildMap {
        fun brand(tint: Int, ink: Int, mark: String?, vararg packages: String) = packages.forEach { put(it, Brand(tint, ink, mark)) }
        brand(0xcc0000, WHITE, null, "com.google.android.youtube.tv")
        brand(0xb20710, WHITE, null, "com.netflix.ninja")
        brand(0x0f6aa8, WHITE, null, "com.amazon.amazonvideo.livingroom")
        brand(0x113ccf, WHITE, "D+", "com.disney.disneyplus")
        brand(0xc4004f, WHITE, null, "com.globo.globotv")
        brand(0x002be7, WHITE, null, "com.wbd.stream")
        brand(0x1db954, DARK, null, "com.spotify.tv.android")
        brand(0x0050d8, WHITE, "P+", "com.cbs.ott")
        brand(0x111111, WHITE, "tv", "com.apple.atve.androidtv.appletv")
        brand(0xcc0000, WHITE, null, "com.google.android.youtube.tvkids")
        brand(0xcc0000, WHITE, null, "com.google.android.youtube.tvmusic")
        brand(0x2b2b2b, WHITE, null, "tv.pluto.android")
        brand(0x772ce8, WHITE, null, "tv.twitch.android.app")
        brand(0x8c1fe0, WHITE, null, "deezer.android.tv")
        brand(0xf47521, DARK, null, "com.crunchyroll.crunchyroid")
        brand(0xe5a00d, DARK, null, "com.plexapp.android")
        brand(0x17b2e7, DARK, null, "org.xbmc.kodi")
        brand(0xff8800, DARK, null, "org.videolan.vlc")
    }

    /** Índice estável (0 a 5) da cor de um pacote: FNV-1a de 32 bits sobre as unidades UTF-16, como no app. */
    fun hue(packageName: String): Int {
        var hash = 2166136261L
        for (unit in packageName) hash = ((hash xor unit.code.toLong()) * 16777619L) and 0xFFFFFFFFL
        return (hash % HUES.size).toInt()
    }

    /** A inicial do nome (letra ou número), em maiúscula; sem nenhuma, um ponto médio discreto. */
    fun glyph(label: String): String {
        val first = label.trim().firstOrNull { it.isLetterOrDigit() } ?: return "·"
        return first.toString().uppercase(Locale.forLanguageTag("pt-BR"))
    }

    /** Mistura `share` de [color] em [base] (como o `color-mix` em sRGB do app). */
    private fun mix(color: Int, share: Float, base: Int): Int {
        fun channel(shift: Int): Int {
            val a = (color shr shift) and 0xFF
            val b = (base shr shift) and 0xFF
            return Math.round(a * share + b * (1f - share))
        }
        return (0xFF shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
    }

    fun look(packageName: String, label: String): Look {
        BRANDS[packageName]?.let { brand ->
            return Look((0xFF shl 24) or brand.tint, (0xFF shl 24) or brand.ink, brand.mark ?: glyph(label))
        }
        val hue = HUES[hue(packageName)]
        return Look(mix(hue, 0.25f, SURFACE), mix(hue, 0.55f, INK), glyph(label))
    }

    fun drawable(packageName: String, label: String): Drawable = LetterDrawable(look(packageName, label))

    /** Fundo cheio (a placa redonda da home recorta o círculo) e a letra centrada, com 44% do lado, como no app. */
    internal class LetterDrawable(val look: Look) : Drawable() {
        private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = look.ink
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }

        override fun draw(canvas: Canvas) {
            val box = bounds
            canvas.drawColor(look.background)
            text.textSize = minOf(box.width(), box.height()) * 0.44f
            val baseline = box.exactCenterY() - (text.descent() + text.ascent()) / 2f
            canvas.drawText(look.glyph, box.exactCenterX(), baseline, text)
        }

        override fun setAlpha(alpha: Int) {
            text.alpha = alpha
        }

        override fun setColorFilter(colorFilter: ColorFilter?) {
            text.colorFilter = colorFilter
        }

        @Deprecated("Deprecated in Java")
        override fun getOpacity(): Int = PixelFormat.OPAQUE
    }
}
