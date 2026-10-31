package br.uniover.launcher

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager

/**
 * Modo Dormir: tela preta em tela cheia, sem nenhum elemento, que sai com qualquer tecla (ou toque).
 *
 * A TV continua ligada, o áudio continua tocando e o agente continua conectado; só os pixels ficam pretos. Num
 * painel LCD o backlight segue aceso (com brilho residual); em OLED o preto é total.
 */
class SleepActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Sem isto a TV poderia entrar no protetor de tela do sistema e trocar o preto por outra coisa.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Brilho mínimo da janela. Em muitas TVs não muda nada (o backlight é da imagem do fabricante), mas onde
        // vale, é o mais escuro possível.
        window.attributes = window.attributes.also { it.screenBrightness = 0f }
        // Tela cheia por flag de janela, sem o modo imersivo: o sistema mostra um aviso ("Viewing full screen") na
        // primeira vez que um app entra nele, e esse aviso engolia a tecla que deveria acordar. Numa TV não há
        // barras de sistema; em outros aparelhos elas ficam pretas por cima do preto.
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        setContentView(View(this).apply { setBackgroundColor(Color.BLACK) })

        val maxMinutes = (application as LauncherApp).configStore.load().sleep.maxMinutes
        if (maxMinutes > 0) handler.postDelayed({ finish() }, maxMinutes * 60_000L)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** Qualquer tecla acorda. A tecla é consumida: ela não deve também apertar algo na tela de baixo. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) finish()
        return true
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) finish()
        return true
    }
}
