package br.uniover.launcher.config

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Resultado de ler um JSON de configuração.
 *
 * - [config] nulo: o arquivo inteiro foi recusado (não é JSON, versão desconhecida, grande demais); [rejected] diz por quê.
 * - [config] presente: pode vir com [warnings] (campo desconhecido ou valor inválido que voltou ao padrão).
 */
data class ParseResult(
    val config: LauncherConfig?,
    val warnings: List<String> = emptyList(),
    val rejected: String? = null,
)

/**
 * Leitor tolerante: a home nunca pode cair por causa de um arquivo mal escrito. Valor inválido volta ao padrão,
 * campo desconhecido é ignorado (versões futuras do agente podem escrever mais). Só se recusa o que não dá para
 * interpretar com segurança: não ser um objeto JSON, faltar `schema` ou ele não ser a versão 1.
 */
object ConfigParser {
    const val SUPPORTED_SCHEMA = 1
    const val MAX_BYTES = 64 * 1024

    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val COLOR = Regex("^#[0-9A-Fa-f]{6}$")
    private val PHOTO = Regex("^[A-Za-z0-9._-]{1,64}\\.(jpg|jpeg|png|webp)$", RegexOption.IGNORE_CASE)

    private const val MAX_ITEMS = 64
    private const val MAX_HIDDEN = 256

    fun parse(text: String): ParseResult {
        if (text.length > MAX_BYTES) return ParseResult(null, rejected = "arquivo maior que $MAX_BYTES bytes")
        val root = try {
            JSONObject(text)
        } catch (_: JSONException) {
            return ParseResult(null, rejected = "não é um objeto JSON")
        }

        val schema = root.opt("schema")
        if (schema !is Int || schema != SUPPORTED_SCHEMA) {
            return ParseResult(null, rejected = "versão de esquema não suportada: $schema")
        }

        val warnings = mutableListOf<String>()
        warnUnknown(root, "", setOf("schema", "revision", "clock", "wallpaper", "apps", "icons", "builtin", "sleep"), warnings)

        val revision = root.opt("revision").let {
            if (it is Int && it >= 0) it else {
                warnings += "revision ausente ou inválida; usando 0"
                0
            }
        }

        val config = LauncherConfig(
            revision = revision,
            clock = parseClock(section(root, "clock", warnings), warnings),
            wallpaper = parseWallpaper(section(root, "wallpaper", warnings), warnings),
            apps = parseApps(section(root, "apps", warnings), warnings),
            icons = parseIcons(section(root, "icons", warnings), warnings),
            builtin = parseBuiltin(section(root, "builtin", warnings), warnings),
            sleep = parseSleep(section(root, "sleep", warnings), warnings),
        )
        return ParseResult(config, warnings)
    }

    private fun section(root: JSONObject, name: String, warnings: MutableList<String>): JSONObject? {
        val value = root.opt(name) ?: return null
        if (value is JSONObject) return value
        warnings += "$name deve ser um objeto"
        return null
    }

    private fun warnUnknown(obj: JSONObject, path: String, known: Set<String>, warnings: MutableList<String>) {
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in known) warnings += "campo desconhecido ignorado: $path$key"
        }
    }

    private fun parseClock(obj: JSONObject?, w: MutableList<String>): ClockConfig {
        val d = ClockConfig()
        if (obj == null) return d
        warnUnknown(obj, "clock.", setOf("enabled", "size", "format", "seconds", "date"), w)
        return ClockConfig(
            enabled = bool(obj, "clock.enabled", "enabled", d.enabled, w),
            size = enum(obj, "clock.size", "size", mapOf("small" to ClockSize.SMALL, "medium" to ClockSize.MEDIUM, "large" to ClockSize.LARGE), d.size, w),
            format = enum(obj, "clock.format", "format", mapOf("24h" to ClockFormat.H24, "12h" to ClockFormat.H12, "auto" to ClockFormat.AUTO), d.format, w),
            seconds = bool(obj, "clock.seconds", "seconds", d.seconds, w),
            date = bool(obj, "clock.date", "date", d.date, w),
        )
    }

    private fun parseWallpaper(obj: JSONObject?, w: MutableList<String>): WallpaperConfig {
        val d = WallpaperConfig()
        if (obj == null) return d
        warnUnknown(obj, "wallpaper.", setOf("type", "colors", "angle", "photo", "dim"), w)

        val type = enum(obj, "wallpaper.type", "type", mapOf("gradient" to WallpaperType.GRADIENT, "solid" to WallpaperType.SOLID, "photo" to WallpaperType.PHOTO), d.type, w)

        var colors = d.colors
        val rawColors = obj.opt("colors")
        if (rawColors != null) {
            val parsed = (rawColors as? JSONArray)?.let { array ->
                (0 until minOf(array.length(), 3)).mapNotNull { i ->
                    val value = array.opt(i)
                    if (value is String && COLOR.matches(value)) {
                        0xFF000000.toInt() or value.substring(1).toLong(16).toInt()
                    } else {
                        w += "wallpaper.colors[$i] inválida: $value"
                        null
                    }
                }
            }
            if (parsed.isNullOrEmpty()) w += "wallpaper.colors sem nenhuma cor válida; usando as cores padrão" else colors = parsed
        }

        val angle = obj.opt("angle").let {
            when {
                it == null -> d.angle
                it is Int && it in 0..315 && it % 45 == 0 -> it
                else -> {
                    w += "wallpaper.angle inválido: $it"
                    d.angle
                }
            }
        }

        val photo = obj.opt("photo").let {
            when {
                it == null -> null
                it is String && PHOTO.matches(it) -> it
                else -> {
                    // O nome nunca pode apontar para fora da pasta do app (nada de "../").
                    w += "wallpaper.photo inválido: $it"
                    null
                }
            }
        }

        val dim = obj.opt("dim").let {
            when {
                it == null -> d.dim
                it is Number && it.toDouble() in 0.0..0.8 -> it.toFloat()
                else -> {
                    w += "wallpaper.dim inválido: $it"
                    d.dim
                }
            }
        }

        // Pediu foto mas sem arquivo válido: cai para o degradê em vez de ficar sem fundo.
        val effectiveType = if (type == WallpaperType.PHOTO && photo == null) {
            w += "wallpaper.type photo sem foto válida; usando degradê"
            WallpaperType.GRADIENT
        } else type
        // Degradê com uma cor só é cor sólida.
        val finalType = if (effectiveType == WallpaperType.GRADIENT && colors.size == 1) WallpaperType.SOLID else effectiveType

        return WallpaperConfig(finalType, colors, angle, photo, dim)
    }

    private fun parseApps(obj: JSONObject?, w: MutableList<String>): AppsConfig {
        val d = AppsConfig()
        if (obj == null) return d
        warnUnknown(obj, "apps.", setOf("mode", "items", "hidden", "showFactory"), w)
        return AppsConfig(
            mode = enum(obj, "apps.mode", "mode", mapOf("listed" to AppsMode.LISTED, "all" to AppsMode.ALL), d.mode, w),
            items = packages(obj, "items", MAX_ITEMS, w).distinct(),
            hidden = packages(obj, "hidden", MAX_HIDDEN, w).toSet(),
            showFactory = bool(obj, "apps.showFactory", "showFactory", d.showFactory, w),
        )
    }

    private fun packages(obj: JSONObject, key: String, max: Int, w: MutableList<String>): List<String> {
        val raw = obj.opt(key) ?: return emptyList()
        val array = raw as? JSONArray ?: run {
            w += "apps.$key deve ser uma lista"
            return emptyList()
        }
        val out = mutableListOf<String>()
        for (i in 0 until array.length()) {
            val value = array.opt(i)
            if (out.size >= max) {
                w += "apps.$key passou de $max itens; o resto foi ignorado"
                break
            }
            if (value is String && value.length <= 255 && PACKAGE.matches(value)) out += value
            else w += "apps.$key[$i] não é um nome de pacote: $value"
        }
        return out
    }

    private fun parseIcons(obj: JSONObject?, w: MutableList<String>): IconsConfig {
        val d = IconsConfig()
        if (obj == null) return d
        warnUnknown(obj, "icons.", setOf("shape", "size", "labels"), w)
        // `shape` só tem "circle" hoje; qualquer outro valor é aviso e fica círculo.
        enum(obj, "icons.shape", "shape", mapOf("circle" to Unit), Unit, w)
        return IconsConfig(
            size = enum(obj, "icons.size", "size", mapOf("small" to IconSize.SMALL, "medium" to IconSize.MEDIUM, "large" to IconSize.LARGE), d.size, w),
            labels = enum(obj, "icons.labels", "labels", mapOf("always" to LabelMode.ALWAYS, "focus" to LabelMode.FOCUS, "never" to LabelMode.NEVER), d.labels, w),
        )
    }

    private fun parseBuiltin(obj: JSONObject?, w: MutableList<String>): BuiltinConfig {
        val d = BuiltinConfig()
        if (obj == null) return d
        warnUnknown(obj, "builtin.", setOf("settings", "sleep"), w)
        return BuiltinConfig(
            settings = bool(obj, "builtin.settings", "settings", d.settings, w),
            sleep = bool(obj, "builtin.sleep", "sleep", d.sleep, w),
        )
    }

    private fun parseSleep(obj: JSONObject?, w: MutableList<String>): SleepConfig {
        if (obj == null) return SleepConfig()
        warnUnknown(obj, "sleep.", setOf("maxMinutes"), w)
        val value = obj.opt("maxMinutes")
        return when {
            value == null -> SleepConfig()
            value is Int && value in 0..720 -> SleepConfig(value)
            else -> {
                w += "sleep.maxMinutes inválido: $value"
                SleepConfig()
            }
        }
    }

    private fun bool(obj: JSONObject, label: String, key: String, default: Boolean, w: MutableList<String>): Boolean {
        val value = obj.opt(key) ?: return default
        if (value is Boolean) return value
        w += "$label deve ser verdadeiro ou falso"
        return default
    }

    private fun <T> enum(obj: JSONObject, label: String, key: String, values: Map<String, T>, default: T, w: MutableList<String>): T {
        val value = obj.opt(key) ?: return default
        val found = (value as? String)?.let { values[it] }
        if (found != null) return found
        w += "$label inválido: $value"
        return default
    }
}
