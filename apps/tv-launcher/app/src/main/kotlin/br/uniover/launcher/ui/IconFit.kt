package br.uniover.launcher.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PorterDuff
import android.graphics.Rect
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Ajuste do ícone ao círculo da home: acha a margem do próprio ícone (a faixa transparente ou a moldura de uma cor
 * chapada que alguns apps desenham em volta), apara o que é claramente margem e usa a cor da placa como fundo do
 * círculo. É o mesmo desenho do azulejo do controle no app (`app-icon-fit.ts`), em Kotlin.
 *
 * Princípio: nunca um desenho pequeno no meio do círculo, e errar para o lado de não cortar o desenho. A faixa
 * transparente em volta não tem desenho nenhum: ela sai inteira (até [MAX_CLEAR_TRIM] do lado), e um ícone com muita
 * folga cresce até encher o círculo. Já a moldura opaca é tinta: dela cada borda perde no máximo [MAX_TRIM] a mais, e
 * só o que é claramente margem. Um desenho solto sobre o transparente mantém uma folga própria; uma placa de uma cor só é
 * aparada rente, e a cor dela vira o fundo do círculo (some o quadrado branco dos cantos).
 *
 * A análise ([analyze]) é pura sobre pixels ARGB, sem Android, e é a parte testada.
 */
object IconFit {
    /** Fração do lado a aparar em cada borda. */
    data class Trim(val left: Float, val top: Float, val right: Float, val bottom: Float)

    data class Analysis(val trim: Trim, val background: Int?, val blank: Boolean = false)

    /** O recorte quadrado, em frações do lado da imagem. */
    data class Crop(val x: Float, val y: Float, val size: Float)

    /** Quanto de moldura opaca cada lado pode perder (além da faixa transparente). */
    const val MAX_TRIM = 0.18f
    /** Quanto de faixa transparente cada lado pode perder: o desenho que ocupa 20% do lado ainda enche o círculo. */
    const val MAX_CLEAR_TRIM = 0.4f
    const val ANALYSIS_SIDE = 64

    private const val SOLID_ALPHA = 128
    private const val MIN_KEPT_PIXELS = 2
    private const val COLOR_TOLERANCE = 18
    private const val STRAY_SHARE = 0.02f
    private const val FREE_FORM_KEEP = 0.07f
    private const val PLATE_OPAQUE_SHARE = 0.5f
    private const val FRAME_AGREE_SHARE = 0.9f
    private const val FRAME_EXPOSED_SHARE = 0.5f

    private val NO_TRIM = Trim(0f, 0f, 0f, 0f)
    private val NOTHING = Analysis(NO_TRIM, null)

    /** Caixa em pixels; `x1` e `y1` são exclusivos. */
    private data class Box(val x0: Int, val y0: Int, val x1: Int, val y1: Int)

    private fun alpha(argb: Int) = argb ushr 24
    private fun red(argb: Int) = (argb shr 16) and 0xFF
    private fun green(argb: Int) = (argb shr 8) and 0xFF
    private fun blue(argb: Int) = argb and 0xFF
    private fun rgb(r: Int, g: Int, b: Int) = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private fun near(argb: Int, color: Int) =
        abs(red(argb) - red(color)) <= COLOR_TOLERANCE &&
            abs(green(argb) - green(color)) <= COLOR_TOLERANCE &&
            abs(blue(argb) - blue(color)) <= COLOR_TOLERANCE

    /** Encolhe a caixa enquanto a fileira (ou coluna) da ponta for só fundo; nulo se nada sobra. */
    private fun shrink(box: Box, isBackground: (Int, Int) -> Boolean): Box? {
        var x0 = box.x0
        var y0 = box.y0
        var x1 = box.x1
        var y1 = box.y1
        fun rowIsBackground(y: Int): Boolean {
            val allowed = ((x1 - x0) * STRAY_SHARE).toInt()
            var stray = 0
            for (x in x0 until x1) if (!isBackground(x, y)) { stray++; if (stray > allowed) return false }
            return true
        }
        fun columnIsBackground(x: Int): Boolean {
            val allowed = ((y1 - y0) * STRAY_SHARE).toInt()
            var stray = 0
            for (y in y0 until y1) if (!isBackground(x, y)) { stray++; if (stray > allowed) return false }
            return true
        }
        while (y0 < y1 && rowIsBackground(y0)) y0++
        if (y0 >= y1) return null
        while (rowIsBackground(y1 - 1)) y1--
        while (x0 < x1 && columnIsBackground(x0)) x0++
        if (x0 >= x1) return null
        while (columnIsBackground(x1 - 1)) x1--
        return Box(x0, y0, x1, y1)
    }

    private fun median(values: List<Int>): Int = values.sorted()[values.size shr 1]

    private data class Ring(val opaqueShare: Float, val color: Int?, val agreeShare: Float)

    /** O contorno de um pixel de espessura da caixa. */
    private fun ringOf(argb: IntArray, width: Int, box: Box): Ring {
        val spots = ArrayList<Int>()
        for (x in box.x0 until box.x1) { spots += box.y0 * width + x; spots += (box.y1 - 1) * width + x }
        for (y in box.y0 + 1 until box.y1 - 1) { spots += y * width + box.x0; spots += y * width + box.x1 - 1 }
        val opaque = spots.filter { alpha(argb[it]) >= SOLID_ALPHA }
        if (spots.isEmpty() || opaque.isEmpty()) return Ring(0f, null, 0f)
        val color = rgb(
            median(opaque.map { red(argb[it]) }),
            median(opaque.map { green(argb[it]) }),
            median(opaque.map { blue(argb[it]) }),
        )
        val agreeing = opaque.count { near(argb[it], color) }
        return Ring(opaque.size.toFloat() / spots.size, color, agreeing.toFloat() / opaque.size)
    }

    /**
     * A moldura de uma cor chapada: o miolo que sobra depois de tirar as fileiras só dessa cor (ou transparentes).
     * Nulo quando não há miolo ou quando o miolo ainda é, na maior parte, a mesma cor (então ela é o fundo do ícone, não
     * uma moldura, e cortá-la só ampliaria o desenho até as bordas).
     */
    private fun frameInner(argb: IntArray, width: Int, box: Box, frame: Int): Box? {
        val isFrame = { x: Int, y: Int ->
            val pixel = argb[y * width + x]
            alpha(pixel) < SOLID_ALPHA || near(pixel, frame)
        }
        val inner = shrink(box, isFrame) ?: return null
        var frameLike = 0
        var total = 0
        fun count(x: Int, y: Int) { total++; if (isFrame(x, y)) frameLike++ }
        for (x in inner.x0 until inner.x1) { count(x, inner.y0); count(x, inner.y1 - 1) }
        for (y in inner.y0 + 1 until inner.y1 - 1) { count(inner.x0, y); count(inner.x1 - 1, y) }
        return if (total > 0 && frameLike.toFloat() / total >= FRAME_EXPOSED_SHARE) null else inner
    }

    /** O corte de um lado: a faixa transparente ([clear], até [MAX_CLEAR_TRIM]) mais a moldura opaca além dela (até [MAX_TRIM]). */
    private fun clampTrim(value: Float, clear: Float): Float {
        val free = min(MAX_CLEAR_TRIM, max(0f, clear))
        return free + min(MAX_TRIM, max(0f, value - max(0f, clear)))
    }

    /** Os dois cortes opostos nunca comem o lado inteiro: sobram ao menos [MIN_KEPT_PIXELS] pixels (o miolo nunca zera). */
    private fun keepSpan(start: Float, end: Float, pixels: Int): Pair<Float, Float> {
        val room = 1f - MIN_KEPT_PIXELS.toFloat() / pixels
        val total = start + end
        return if (total <= room) start to end else (start * room / total) to (end * room / total)
    }

    /**
     * Procura a margem do ícone em [argb] (largura x altura pixels ARGB) e devolve quanto aparar de cada lado e a cor da
     * placa. Entrada que não dá para ler com segurança (pequena demais, buffer curto) não corta nada.
     */
    fun analyze(argb: IntArray, width: Int, height: Int): Analysis {
        if (width < 4 || height < 4 || argb.size < width * height) return NOTHING
        val whole = Box(0, 0, width, height)
        val content = shrink(whole) { x, y -> alpha(argb[y * width + x]) < SOLID_ALPHA }
            ?: return if (argb.take(width * height).all { alpha(it) == 0 }) Analysis(NO_TRIM, null, blank = true) else NOTHING
        val margins = Trim(
            content.x0.toFloat() / width,
            content.y0.toFloat() / height,
            (width - content.x1).toFloat() / width,
            (height - content.y1).toFloat() / height,
        )
        val ring = ringOf(argb, width, content)
        val plate = ring.opaqueShare >= PLATE_OPAQUE_SHARE && ring.color != null
        val keep = if (plate) 0f else FREE_FORM_KEEP
        var trim = Trim(margins.left - keep, margins.top - keep, margins.right - keep, margins.bottom - keep)

        if (plate && ring.agreeShare >= FRAME_AGREE_SHARE) {
            val inner = frameInner(argb, width, content, ring.color!!)
            if (inner != null) {
                // Um pixel a mais onde houve corte: o pixel da emenda é uma mistura da moldura com o miolo.
                fun seam(moved: Boolean, size: Int) = if (moved) 1f / size else 0f
                trim = Trim(
                    inner.x0.toFloat() / width + seam(inner.x0 > content.x0, width),
                    inner.y0.toFloat() / height + seam(inner.y0 > content.y0, height),
                    (width - inner.x1).toFloat() / width + seam(inner.x1 < content.x1, width),
                    (height - inner.y1).toFloat() / height + seam(inner.y1 < content.y1, height),
                )
            }
        }
        val rawCapped = Trim(
            clampTrim(trim.left, margins.left - keep),
            clampTrim(trim.top, margins.top - keep),
            clampTrim(trim.right, margins.right - keep),
            clampTrim(trim.bottom, margins.bottom - keep),
        )
        val (left, right) = keepSpan(rawCapped.left, rawCapped.right, width)
        val (top, bottom) = keepSpan(rawCapped.top, rawCapped.bottom, height)
        val capped = Trim(left, top, right, bottom)
        val finalRing = ringOf(
            argb,
            width,
            Box(
                (capped.left * width).roundToInt(),
                (capped.top * height).roundToInt(),
                width - (capped.right * width).roundToInt(),
                height - (capped.bottom * height).roundToInt(),
            ),
        )
        val background = if (finalRing.opaqueShare >= PLATE_OPAQUE_SHARE) finalRing.color else null
        return Analysis(capped, background)
    }

    /** O recorte vira um quadrado: o lado é o maior dos dois, centrado na caixa que sobrou e empurrado para dentro da imagem. */
    fun cropSquare(trim: Trim): Crop {
        val width = 1f - trim.left - trim.right
        val height = 1f - trim.top - trim.bottom
        val size = min(1f, max(width, height))
        fun place(start: Float, length: Float) = min(1f - size, max(0f, start + length / 2f - size / 2f))
        return Crop(place(trim.left, width), place(trim.top, height), size)
    }

    /** Menos de meio por cento de corte não compensa mexer na imagem. */
    fun needsFit(analysis: Analysis, crop: Crop): Boolean =
        !analysis.blank && (crop.size <= 0.995f || analysis.background != null)

    /**
     * O ícone pronto para o círculo, ou nulo quando não há o que ajustar (ícone adaptativo, que já vem sangrado, ou sem
     * margem nem placa). Desenha o ícone a [diameter] pixels, com a cor da placa de fundo e o recorte ocupando tudo.
     */
    fun fitted(icon: Drawable, diameter: Int): Drawable? = fit(icon, diameter).drawable

    /** O resultado do ajuste: o desenho pronto (ou nulo, se não há o que ajustar) e se o ícone não tem tinta nenhuma. */
    data class Fitted(val drawable: Drawable?, val blank: Boolean)

    private val UNTOUCHED = Fitted(null, false)

    /** Como [fitted], dizendo também quando o ícone é todo transparente (quem o mostra põe a reserva no lugar). */
    fun fit(icon: Drawable, diameter: Int): Fitted {
        if (diameter < 8) return UNTOUCHED
        val adaptive = icon is AdaptiveIconDrawable
        val analysis = try {
            val sample = Bitmap.createBitmap(ANALYSIS_SIDE, ANALYSIS_SIDE, Bitmap.Config.ARGB_8888)
            drawSquare(icon, Canvas(sample), ANALYSIS_SIDE, 1f, 0f, 0f)
            val pixels = IntArray(ANALYSIS_SIDE * ANALYSIS_SIDE)
            sample.getPixels(pixels, 0, ANALYSIS_SIDE, 0, 0, ANALYSIS_SIDE, ANALYSIS_SIDE)
            sample.recycle()
            analyze(pixels, ANALYSIS_SIDE, ANALYSIS_SIDE)
        } catch (_: RuntimeException) {
            return UNTOUCHED
        }
        if (analysis.blank) return Fitted(null, true)
        // O adaptativo já vem sangrado: só se confere se é todo transparente, sem recortar nada.
        if (adaptive) return UNTOUCHED
        val crop = cropSquare(analysis.trim)
        if (!needsFit(analysis, crop)) return UNTOUCHED
        val drawable = try {
            val bitmap = Bitmap.createBitmap(diameter, diameter, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            analysis.background?.let { canvas.drawColor(it, PorterDuff.Mode.SRC) }
            val scale = 1f / crop.size
            drawSquare(icon, canvas, diameter, scale, -crop.x * scale, -crop.y * scale)
            BitmapDrawable(null, bitmap)
        } catch (_: RuntimeException) {
            null
        }
        return Fitted(drawable, false)
    }

    /**
     * Desenha o quadrado do meio do ícone (o mesmo corte que o `cover` do controle faz) ocupando [side] pixels, ampliado
     * por [scale] e deslocado por ([dx], [dy]) lados.
     */
    private fun drawSquare(icon: Drawable, canvas: Canvas, side: Int, scale: Float, dx: Float, dy: Float) {
        val iw = icon.intrinsicWidth.takeIf { it > 0 } ?: side
        val ih = icon.intrinsicHeight.takeIf { it > 0 } ?: side
        val shortSide = min(iw, ih).toFloat()
        val squarePx = side * scale
        val width = squarePx * iw / shortSide
        val height = squarePx * ih / shortSide
        val left = dx * side - (width - squarePx) / 2f
        val top = dy * side - (height - squarePx) / 2f
        val saved = Rect(icon.bounds)
        icon.setBounds(left.roundToInt(), top.roundToInt(), (left + width).roundToInt(), (top + height).roundToInt())
        icon.draw(canvas)
        icon.bounds = saved
    }
}
