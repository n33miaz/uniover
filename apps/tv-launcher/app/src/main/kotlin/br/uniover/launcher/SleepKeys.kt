package br.uniover.launcher

import android.view.KeyEvent

/**
 * Como o Modo Dormir trata cada tecla.
 *
 * - Volume, mudo e mídia (tocar, pausar, pular, parar, voltar e avançar) passam para o sistema sem acordar a tela.
 * - As de energia (ligar/desligar, a de energia da TV, dormir e acordar) fecham a tela preta e também seguem para o
 *   sistema: a TV Livre nunca as engole, senão a TV deixa de desligar pelo controle (físico ou pelo app).
 * - As demais acordam a tela e são consumidas, para não apertarem também algo na tela de baixo.
 */
object SleepKeys {
    private val POWER = setOf(
        KeyEvent.KEYCODE_POWER,
        KeyEvent.KEYCODE_TV_POWER,
        KeyEvent.KEYCODE_SLEEP,
        KeyEvent.KEYCODE_SOFT_SLEEP,
        KeyEvent.KEYCODE_WAKEUP,
    )

    private val PASS_THROUGH = setOf(
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_VOLUME_MUTE,
        KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_MEDIA_STOP,
        KeyEvent.KEYCODE_MEDIA_NEXT,
        KeyEvent.KEYCODE_MEDIA_PREVIOUS,
        KeyEvent.KEYCODE_MEDIA_REWIND,
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
    )

    /** Segue para o sistema e a tela continua preta. */
    fun passesThrough(keyCode: Int): Boolean = keyCode in PASS_THROUGH

    /** Tecla de energia: fecha a tela preta e segue para o sistema (nunca é consumida). */
    fun isPower(keyCode: Int): Boolean = keyCode in POWER
}
