package br.uniover.launcher

import android.app.Activity
import android.content.Intent
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
 * painel LCD o backlight segue aceso (com brilho residual); em OLED o preto é total. Volume, mudo e as teclas de
 * mídia passam sem acordar a tela; as de energia fecham a tela preta e seguem para o sistema, que desliga a TV
 * ([SleepKeys]). O tempo para acordar sozinho vem do pedido (extra
 * [EXTRA_MAX_MINUTES]) quando ele traz um, e da configuração quando não.
 */
class SleepActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Sem isto a TV poderia entrar no protetor de tela do sistema e trocar o preto por outra coisa. A flag não
        // segura a TV ligada: a tecla de energia desliga mesmo com ela, e o desligamento por inatividade das TVs
        // atuais (o tempo de atenção do sistema) não a respeita.
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
        scheduleWake(intent)
    }

    /** Pedido novo com a tela já preta (a atividade é singleInstance): vale o tempo do pedido mais recente. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        scheduleWake(intent)
    }

    private fun scheduleWake(from: Intent?) {
        handler.removeCallbacksAndMessages(null)
        val requested = from?.getIntExtra(EXTRA_MAX_MINUTES, -1) ?: -1
        val maxMinutes = if (requested in 0..MAX_MINUTES) requested
        else (application as LauncherApp).configStore.load().sleep.maxMinutes
        if (maxMinutes > 0) handler.postDelayed({ finish() }, maxMinutes * 60_000L)
    }

    /**
     * A tela saiu da frente: a TV entrou em espera, apagou a tela ou outro app abriu por cima. Fecha a tela preta, para
     * a TV nunca voltar a ligar mostrando só preto (o que parece uma TV que não liga).
     */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) finish()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /**
     * Qualquer tecla acorda. A tecla é consumida: ela não deve também apertar algo na tela de baixo. As de volume e
     * mídia seguem para o sistema e a tela continua preta. As de energia fecham a tela e seguem para o sistema, no
     * apertar e no soltar (há TV que desliga no soltar ou no aperto longo).
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (SleepKeys.isPower(event.keyCode)) {
            if (event.action == KeyEvent.ACTION_DOWN) finish()
            return super.dispatchKeyEvent(event)
        }
        if (SleepKeys.passesThrough(event.keyCode)) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) finish()
        return true
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) finish()
        return true
    }

    companion object {
        /** Extra inteiro do `am start --ei`: minutos até acordar sozinho (0 a 720; 0 só acorda com tecla). */
        const val EXTRA_MAX_MINUTES = "br.uniover.launcher.extra.MAX_MINUTES"
        const val MAX_MINUTES = 720
    }
}
