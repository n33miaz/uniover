package br.uniover.launcher

import android.view.KeyEvent

/**
 * As teclas que passam pelo Modo Dormir sem acordar a tela: volume, mudo e mídia (tocar, pausar, pular, parar,
 * voltar e avançar). Quem as trata é o sistema; o Modo Dormir só não as engole.
 */
object SleepKeys {
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

    fun passesThrough(keyCode: Int): Boolean = keyCode in PASS_THROUGH
}
