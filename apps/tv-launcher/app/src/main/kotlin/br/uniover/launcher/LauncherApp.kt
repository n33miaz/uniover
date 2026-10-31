package br.uniover.launcher

import android.app.Application
import br.uniover.launcher.config.ConfigStore

/** Guarda o leitor de configuração único, para a home, o Modo Dormir e o receptor compartilharem o cache. */
class LauncherApp : Application() {
    val configStore: ConfigStore by lazy {
        // getExternalFilesDir cria a pasta na primeira chamada: é por isso que o app precisa abrir uma vez antes do
        // agente enviar arquivos para ela.
        ConfigStore(externalDir = { getExternalFilesDir(null) }, internalDir = filesDir)
    }
}
