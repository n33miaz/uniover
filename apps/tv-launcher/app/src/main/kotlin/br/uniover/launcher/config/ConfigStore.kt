package br.uniover.launcher.config

import java.io.File

/** Onde a configuração pode estar e de onde vêm as fotos. A raiz externa pode não existir em algumas caixas. */
class ConfigStore(
    /** Pasta externa do app (`/sdcard/Android/data/<pacote>/files`), onde o agente faz `adb push`. */
    private val externalDir: () -> File?,
    /** Pasta interna do app, onde o receptor grava o que chega por broadcast. */
    private val internalDir: File,
) {
    /** Impressão digital de cada origem: arquivo que não mudou não é relido. */
    private data class Stamp(val path: String, val modified: Long, val length: Long)

    private var lastStamps: List<Stamp?> = emptyList()
    private var lastGood: LauncherConfig? = null
    private var lastWarnings: List<String> = emptyList()

    /** Avisos da última leitura (valores que voltaram ao padrão), para o registro de depuração. */
    val warnings: List<String> get() = lastWarnings

    /**
     * Lê a configuração em vigor. Nunca lança: erro de leitura mantém a última boa (ou o padrão, na primeira vez).
     *
     * Duas origens: o arquivo da pasta externa (adb push) e o da pasta interna (broadcast). Vale a de maior
     * `revision`; empate fica com a externa. Um arquivo meio escrito (JSON truncado) é recusado e a última
     * configuração boa continua valendo: o agente deve escrever num `.tmp` e renomear, mas não dependemos disso.
     */
    @Synchronized
    fun load(): LauncherConfig {
        val files = listOf(
            externalDir()?.let { File(it, CONFIG_NAME) },
            File(internalDir, CONFIG_NAME),
        )
        val stamps = files.map { file ->
            file?.takeIf { it.isFile }?.let { Stamp(it.path, it.lastModified(), it.length()) }
        }
        if (stamps == lastStamps && lastGood != null) return lastGood!!

        val candidates = mutableListOf<LauncherConfig>()
        val warnings = mutableListOf<String>()
        var anyFailed = false
        files.forEachIndexed { index, file ->
            if (stamps[index] == null || file == null) return@forEachIndexed
            val result = try {
                ConfigParser.parse(file.readText())
            } catch (e: Exception) {
                ParseResult(null, rejected = "erro de leitura: ${e.javaClass.simpleName}")
            }
            if (result.config != null) {
                candidates += result.config
                warnings += result.warnings
            } else {
                anyFailed = true
                warnings += "${file.name} recusado: ${result.rejected}"
            }
        }

        val chosen = candidates.maxByOrNull { it.revision }
            ?: if (anyFailed) lastGood else null
        lastStamps = stamps
        lastWarnings = warnings
        lastGood = chosen ?: LauncherConfig.DEFAULT
        return lastGood!!
    }

    /** Resolve o nome de uma foto da configuração para um arquivo existente, ou nulo. */
    fun photoFile(name: String?): File? {
        if (name == null || name != File(name).name) return null
        return listOfNotNull(externalDir(), internalDir)
            .map { File(it, name) }
            .firstOrNull { it.isFile && it.length() in 1..MAX_PHOTO_BYTES }
    }

    /** Grava a configuração recebida por broadcast na pasta interna, de forma atômica. */
    fun writeInternal(text: String) {
        internalDir.mkdirs()
        val tmp = File(internalDir, "$CONFIG_NAME.tmp")
        tmp.writeText(text)
        val target = File(internalDir, CONFIG_NAME)
        if (!tmp.renameTo(target)) {
            target.delete()
            check(tmp.renameTo(target)) { "não consegui gravar a configuração" }
        }
    }

    companion object {
        const val CONFIG_NAME = "config.json"
        const val MAX_PHOTO_BYTES = 4L * 1024 * 1024
    }
}
