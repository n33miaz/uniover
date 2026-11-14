package br.uniover.launcher.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings

/**
 * As telas do sistema que os círculos "Rede" e "Entradas" abrem. Cada tela tem uma lista de pedidos candidatos, do mais
 * certo ao menos; vale o primeiro que a TV sabe atender. Sem nenhum, o círculo não aparece (nunca um botão que não abre).
 *
 * Qual tela cada marca abre para as entradas só se confirma na própria TV: acrescentar ou trocar candidatos é mexer só
 * nesta lista.
 */
object SystemScreens {
    /** A ação que cada candidato usa; o manifesto lista as mesmas ações em `<queries>` para o Android 11+ deixar ver. */
    val NETWORK_ACTIONS = listOf(Settings.ACTION_WIFI_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS)
    val INPUT_ACTIONS = listOf("android.media.tv.action.SETUP_INPUTS")

    fun network(pm: PackageManager): Intent? = firstResolvable(pm, NETWORK_ACTIONS)

    fun inputs(pm: PackageManager): Intent? = firstResolvable(pm, INPUT_ACTIONS)

    private fun firstResolvable(pm: PackageManager, actions: List<String>): Intent? =
        actions.map { Intent(it) }.firstOrNull { pm.resolveActivity(it, 0) != null }
}
