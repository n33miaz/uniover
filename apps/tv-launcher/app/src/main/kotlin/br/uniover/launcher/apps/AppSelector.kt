package br.uniover.launcher.apps

import br.uniover.launcher.config.AppsConfig
import br.uniover.launcher.config.AppsMode

/** Um app instalado que tem ícone de TV ou de celular. [isFactory]: de sistema e nunca atualizado. */
data class InstalledApp(
    val packageName: String,
    val label: String,
    val isFactory: Boolean,
)

/** [fellBack]: a configuração deixaria a home vazia, então mostramos todos os apps (rede de segurança). */
data class Selection(val apps: List<InstalledApp>, val fellBack: Boolean)

/**
 * Decide quais apps aparecem e em que ordem. Lógica pura, sem Android, testada à parte.
 *
 * Regras:
 * - O próprio launcher nunca aparece.
 * - `hidden` vence tudo.
 * - `listed`: só os de `items`, na ordem dada; o que não está instalado é pulado sem erro.
 * - `all`: `items` primeiro (na ordem dada), depois o resto em ordem alfabética; apps de fábrica ficam de fora,
 *   a menos que `showFactory` ou que estejam em `items`.
 * - Se o resultado ficar vazio, vale a lista completa (menos o próprio launcher): a home nunca fica sem nada.
 */
object AppSelector {
    fun select(installed: List<InstalledApp>, config: AppsConfig, selfPackage: String): Selection {
        val candidates = installed
            .filter { it.packageName != selfPackage }
            .distinctBy { it.packageName }
        val byPackage = candidates.associateBy { it.packageName }

        val chosen = when (config.mode) {
            AppsMode.LISTED ->
                config.items.mapNotNull { byPackage[it] }.filter { it.packageName !in config.hidden }

            AppsMode.ALL -> {
                val first = config.items.mapNotNull { byPackage[it] }
                val firstSet = first.map { it.packageName }.toSet()
                val rest = candidates
                    .filter { it.packageName !in firstSet }
                    .filter { config.showFactory || !it.isFactory }
                    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
                (first + rest).filter { it.packageName !in config.hidden }
            }
        }

        if (chosen.isNotEmpty()) return Selection(chosen, fellBack = false)
        val everything = candidates.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
        return Selection(everything, fellBack = everything.isNotEmpty())
    }
}
