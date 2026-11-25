package br.uniover.launcher.apps

import br.uniover.launcher.R

/**
 * Apps do sistema da TV que aparecem com o desenho do UniOver (o mesmo círculo dos atalhos do sistema do TV Livre),
 * nunca com a arte do fabricante. É a mesma tabela do controle no app (`SYSTEM_APP_GLYPHS` em `app-icon-source.ts`),
 * conferida no teste.
 */
object SystemApps {
    /** Pacote -> nome do desenho no app (`tv-icon.ts`). */
    val GLYPHS: Map<String, String> = mapOf(
        "com.android.tv.settings" to "settings",
        "com.android.settings" to "settings",
    )

    /** Fim de nome de pacote que é a tela de configurações de algum fabricante (`com.tcl.settings`, `...tvsettings`). */
    private val SETTINGS_SUFFIXES = listOf(".settings", ".tvsettings")

    /** O nome do desenho para um app do sistema, ou nulo para um app comum. */
    fun glyph(packageName: String): String? =
        GLYPHS[packageName] ?: if (SETTINGS_SUFFIXES.any { packageName.endsWith(it) }) "settings" else null

    /** O desenho do launcher para cada nome do app (os mesmos caminhos, conferidos no teste). */
    fun drawable(glyph: String): Int? = when (glyph) {
        "settings" -> R.drawable.ic_settings
        "wifi" -> R.drawable.ic_network
        "input" -> R.drawable.ic_inputs
        "sleep" -> R.drawable.ic_sleep
        else -> null
    }
}
