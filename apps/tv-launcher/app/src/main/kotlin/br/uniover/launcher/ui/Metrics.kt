package br.uniover.launcher.ui

import br.uniover.launcher.config.ClockSize
import br.uniover.launcher.config.IconSize
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Tamanhos como fração da altura da tela, não em dp: as TVs variam de densidade (mdpi a xhdpi) e de resolução,
 * mas a proporção do desenho aprovado (relógio grande, fileira de círculos) é a mesma em qualquer uma.
 * Referência: 1080p. Lógica pura, testada sem Android.
 */
class Metrics(widthPx: Int, heightPx: Int) {
    /** A unidade de medida: o lado menor da tela (a altura, com a TV na horizontal). */
    private val unit: Float = minOf(widthPx, heightPx).toFloat()

    private fun px(fraction: Float): Int = max(1, (unit * fraction).roundToInt())

    val horizontalPadding: Int = px(0.12f)

    fun clockText(size: ClockSize): Int = px(
        when (size) {
            ClockSize.LARGE -> 0.17f
            ClockSize.MEDIUM -> 0.11f
            ClockSize.SMALL -> 0.07f
        },
    )

    fun dateText(size: ClockSize): Int = px(
        when (size) {
            ClockSize.LARGE -> 0.04f
            ClockSize.MEDIUM -> 0.032f
            ClockSize.SMALL -> 0.026f
        },
    )

    /** Espaço entre o bloco do relógio e a fileira de apps. */
    val clockToRowGap: Int = px(0.09f)

    fun iconDiameter(size: IconSize): Int = px(
        when (size) {
            IconSize.LARGE -> 0.22f
            IconSize.MEDIUM -> 0.18f
            IconSize.SMALL -> 0.14f
        },
    )

    /** Anel de foco: espessura e folga entre o anel e o círculo do ícone. */
    val ringStroke: Int = max(3, px(0.007f))
    val ringGap: Int = max(3, px(0.007f))

    /** Espaço entre um app e o próximo (de borda a borda do anel). */
    val tileSpacing: Int = px(0.045f)

    val labelText: Int = px(0.026f)
    val labelGap: Int = px(0.022f)

    /** Respiro vertical da fileira para o círculo ampliado e o anel não serem cortados. */
    val rowVerticalPadding: Int = px(0.04f)

    /** Diâmetro total do conjunto ícone + folga + anel. */
    fun tileSide(size: IconSize): Int = iconDiameter(size) + 2 * (ringStroke + ringGap)

    companion object {
        const val FOCUS_SCALE = 1.12f
    }
}
