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
                setColor(0x33FFFFFF)
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
        }
        if (icon != null) {
            val view = ImageView(context).apply {
                setImageDrawable(icon)
                // Ícone adaptativo já vem sangrado e é só recortado no círculo; o antigo (quadrado) ganha margem.
                if (icon is AdaptiveIconDrawable) {
                    scaleType = ImageView.ScaleType.CENTER_CROP
                } else {
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    val inset = (diameter * 0.16f).toInt()
                    setPadding(inset, inset, inset, inset)
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

    private companion object {
        const val FOCUS_MS = 140L
        const val UNFOCUSED_LABEL_ALPHA = 0.72f
    }
}
