package br.uniover.launcher.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView

/**
 * O nome do sistema, pequeno, num canto da tela. Posição, tamanho e transparência ficam aqui, num lugar só, porque o
 * desenho ainda pode mudar (o dono vai ver e escolher). Quase não se nota, de propósito: não disputa com o relógio.
 */
object BrandMark {
    const val GRAVITY = Gravity.BOTTOM or Gravity.END
    const val ALPHA = 0.4f

    /** O tamanho do texto, em fração do lado menor da tela. */
    const val TEXT_FRACTION = 0.022f

    /** A distância da borda, em fração do lado menor da tela. */
    const val MARGIN_FRACTION = 0.03f

    fun create(context: Context, text: String, screenUnit: Int): TextView = TextView(context).apply {
        this.text = text
        setTextColor(Color.WHITE)
        alpha = ALPHA
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, screenUnit * TEXT_FRACTION)
        letterSpacing = 0.08f
        importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO
        isFocusable = false
        val margin = (screenUnit * MARGIN_FRACTION).toInt()
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, GRAVITY)
            .apply { setMargins(margin, margin, margin, margin) }
    }
}
