package br.uniover.launcher

/**
 * Aviso de "chegou configuração nova" do receptor para a home, quando ela está na tela. É só uma referência na
 * memória (sem serviço, sem broadcast local): a home registra em onResume e solta em onPause.
 */
object ConfigSignal {
    @Volatile
    var listener: (() -> Unit)? = null
}
