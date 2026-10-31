package br.uniover.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import br.uniover.launcher.config.ConfigParser

/**
 * Segundo caminho da configuração: `adb shell am broadcast -n br.uniover.launcher/.ConfigReceiver
 * -a br.uniover.launcher.action.APPLY_CONFIG --es config_b64 <JSON em base64>`.
 *
 * O manifesto exige a permissão DUMP (do usuário shell e do sistema), então app comum não consegue acionar. O JSON
 * só é gravado se for aceito pelo leitor; recusado, nada muda. O resultado volta no próprio `am broadcast`:
 * `result=1` aceito, `result=2` recusado (com o motivo em `data`).
 */
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val outcome = apply(context, intent.getStringExtra(EXTRA_CONFIG_B64))
        if (isOrderedBroadcast) {
            setResultCode(if (outcome.accepted) RESULT_ACCEPTED else RESULT_REJECTED)
            setResultData(outcome.message)
        }
        if (outcome.accepted) ConfigSignal.listener?.invoke()
    }

    private data class Outcome(val accepted: Boolean, val message: String)

    private fun apply(context: Context, encoded: String?): Outcome {
        if (encoded.isNullOrBlank()) return Outcome(false, "faltou o extra $EXTRA_CONFIG_B64")
        val text = decode(encoded) ?: return Outcome(false, "base64 inválido")
        val result = ConfigParser.parse(text)
        val config = result.config ?: return Outcome(false, result.rejected ?: "recusada")
        return try {
            (context.applicationContext as LauncherApp).configStore.writeInternal(text)
            Outcome(true, "revision=${config.revision} avisos=${result.warnings.size}")
        } catch (e: Exception) {
            Outcome(false, "não consegui gravar: ${e.javaClass.simpleName}")
        }
    }

    private fun decode(encoded: String): String? {
        // O adb costuma entregar o base64 sem quebras de linha, mas aceitamos também a variante de URL.
        for (flags in intArrayOf(Base64.DEFAULT, Base64.URL_SAFE)) {
            try {
                return String(Base64.decode(encoded.trim(), flags), Charsets.UTF_8)
            } catch (_: IllegalArgumentException) {
                // tenta a outra variante
            }
        }
        return null
    }

    companion object {
        const val ACTION = "br.uniover.launcher.action.APPLY_CONFIG"
        const val EXTRA_CONFIG_B64 = "config_b64"
        const val RESULT_ACCEPTED = 1
        const val RESULT_REJECTED = 2
    }
}
