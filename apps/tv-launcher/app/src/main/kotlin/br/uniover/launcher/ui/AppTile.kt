package br.uniover.launcher.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import br.uniover.launcher.config.IconSize
import br.uniover.launcher.config.LabelMode

/**
 * Um app da fileira: círculo com o ícone, anel branco quando tem foco e o nome embaixo.
 * Só framework: três Views e um TextView por app, sem imagem extra além do ícone que o sistema já tem em cache.
 */
class AppTile(
    context: Context,
    private val metrics: Metrics,
    iconSize: IconSize,
    private val labels: LabelMode,
    val tileId: String,
    label: String,
    icon: Drawable?,
    /** Chamado quando o tile ganha foco (a home centraliza a fileira nele). */
    private val onFocused: (AppTile) -> Unit,
    /** Círculo do próprio sistema (Dormir, Rede, Entradas, Configurações): desenho nosso, centrado numa placa cheia. */
    val system: Boolean = false,
    /** A reserva para um ícone todo transparente: a inicial sobre a cor do pacote ([FallbackIcon]). */
    private val fallback: (() -> Drawable)? = null,
) : LinearLayout(context) {

    private val ring: View
    private val stack: FrameLayout
    private val labelView: TextView?

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        isFocusable = true
        isClickable = true
        // O toque não rouba o foco do D-pad; o clique funciona do mesmo jeito.
        isFocusableInTouchMode = false
        clipChildren = false
        clipToPadding = false
        contentDescription = label
        // Sem o destaque azul padrão do sistema no foco: o anel branco é o único destaque.
        defaultFocusHighlightEnabled = false

        val side = metrics.tileSide(iconSize)
        val diameter = metrics.iconDiameter(iconSize)

        stack = FrameLayout(context).apply {
            layoutParams = LayoutParams(side, side)
            clipChildren = false
        }

        ring = View(context).apply {
            layoutParams = FrameLayout.LayoutParams(side, side)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.TRANSPARENT)
                setStroke(metrics.ringStroke, 0xFFFFFFFF.toInt())
            }
            alpha = 0f
        }

        val plate = FrameLayout(context).apply {
            layoutParams = FrameLayout.LayoutParams(diameter, diameter, Gravity.CENTER)
            // Base translúcida: ícones com fundo transparente ficam com um círculo uniforme atrás.
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(if (system) SYSTEM_PLATE else 0x33FFFFFF)
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
        }
        if (icon != null) {
            val view = ImageView(context).apply {
                setImageDrawable(icon)
                // Os círculos do sistema são desenho nosso: a placa enche o círculo e o traço branco fica no meio dela.
                // Ícone de app enche sempre o círculo de borda a borda, como o azulejo do controle (`cover`): o adaptativo
                // já vem sangrado; o antigo (quadrado) é aparado e a cor da placa vira o fundo; sem o que aparar, vai
                // inteiro, sem folga (antes ganhava 16% de margem por lado e virava um quadrado pequeno no meio).
                if (system) {
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    val inset = (diameter * SYSTEM_GLYPH_INSET).toInt()
                    setPadding(inset, inset, inset, inset)
                } else {
                    // Ícone sem tinta nenhuma (todo transparente) seria um círculo vazio: vale a reserva com a inicial.
                    // A reserva já enche o círculo; o adaptativo já vem sangrado: nenhum dos dois passa pelo ajuste.
                    val fit = if (icon is AdaptiveIconDrawable || icon is FallbackIcon.LetterDrawable) null
                    else IconFit.fit(icon, diameter)
                    val shown = if (fit?.blank == true) fallback?.invoke() else fit?.drawable
                    if (shown != null) setImageDrawable(shown)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                }
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            plate.addView(view, FrameLayout.LayoutParams(diameter, diameter))
        }

        stack.addView(ring)
        stack.addView(plate)
        addView(stack)

        labelView = if (labels == LabelMode.NEVER) null else TextView(context).apply {
            text = label
            setTextColor(Color.WHITE)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, metrics.labelText.toFloat())
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            gravity = Gravity.CENTER
            setShadowLayer(metrics.labelText / 4f, 0f, 2f, 0x99000000.toInt())
            alpha = if (labels == LabelMode.ALWAYS) UNFOCUSED_LABEL_ALPHA else 0f
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        labelView?.let {
            // Largura do nome = largura do conjunto ícone + anel, para os nomes não empurrarem os vizinhos.
            addView(it, LayoutParams(side + metrics.tileSpacing / 2, LayoutParams.WRAP_CONTENT).apply {
                topMargin = metrics.labelGap
            })
        }
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        // O ValueAnimator por baixo respeita a escala de animação do sistema (zero = sem movimento).
        val scale = if (gainFocus) Metrics.FOCUS_SCALE else 1f
        stack.animate().scaleX(scale).scaleY(scale).setDuration(FOCUS_MS).start()
        ring.animate().alpha(if (gainFocus) 1f else 0f).setDuration(FOCUS_MS).start()
        labelView?.animate()?.alpha(if (gainFocus) 1f else if (labels == LabelMode.ALWAYS) UNFOCUSED_LABEL_ALPHA else 0f)
            ?.setDuration(FOCUS_MS)?.start()
        if (gainFocus) onFocused(this)
    }

    internal companion object {
        /** A placa dos círculos do sistema: um azul-noite claro, da mesma família do fundo padrão da home. */
        const val SYSTEM_PLATE = 0xFF4A5A8C.toInt()
        /** A folga do traço do sistema dentro da placa (por lado): o desenho ocupa 52% do círculo. */
        const val SYSTEM_GLYPH_INSET = 0.24f
        const val FOCUS_MS = 140L
        const val UNFOCUSED_LABEL_ALPHA = 0.72f
    }
}
