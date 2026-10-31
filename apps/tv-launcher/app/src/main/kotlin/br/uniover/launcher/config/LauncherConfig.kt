package br.uniover.launcher.config

/**
 * Modelo da configuração da home (contrato `contracts/tv-launcher/config.v1.schema.json`).
 * Tudo tem padrão: sem arquivo nenhum a home funciona e mostra algo útil.
 */

enum class ClockSize { SMALL, MEDIUM, LARGE }

enum class ClockFormat { H24, H12, AUTO }

enum class WallpaperType { GRADIENT, SOLID, PHOTO }

enum class AppsMode { LISTED, ALL }

enum class IconSize { SMALL, MEDIUM, LARGE }

enum class LabelMode { ALWAYS, FOCUS, NEVER }

data class ClockConfig(
    val enabled: Boolean = true,
    val size: ClockSize = ClockSize.LARGE,
    val format: ClockFormat = ClockFormat.H24,
    val seconds: Boolean = false,
    val date: Boolean = true,
)

/** Cores em ARGB opaco (0xFFRRGGBB). */
data class WallpaperConfig(
    val type: WallpaperType = WallpaperType.GRADIENT,
    val colors: List<Int> = DEFAULT_COLORS,
    val angle: Int = 315,
    /** Só o nome do arquivo; a pasta é sempre a do próprio app. */
    val photo: String? = null,
    val dim: Float = 0.25f,
) {
    companion object {
        // Azul-noite para um violeta apagado: suave, escuro o bastante para o relógio branco ler bem.
        val DEFAULT_COLORS = listOf(0xFF1B2440.toInt(), 0xFF3A2D5C.toInt())
    }
}

data class AppsConfig(
    val mode: AppsMode = AppsMode.ALL,
    val items: List<String> = emptyList(),
    val hidden: Set<String> = emptySet(),
    val showFactory: Boolean = false,
)

data class IconsConfig(
    val size: IconSize = IconSize.MEDIUM,
    val labels: LabelMode = LabelMode.ALWAYS,
)

data class BuiltinConfig(
    val settings: Boolean = true,
    val sleep: Boolean = false,
)

data class SleepConfig(val maxMinutes: Int = 0)

data class LauncherConfig(
    val revision: Int = 0,
    val clock: ClockConfig = ClockConfig(),
    val wallpaper: WallpaperConfig = WallpaperConfig(),
    val apps: AppsConfig = AppsConfig(),
    val icons: IconsConfig = IconsConfig(),
    val builtin: BuiltinConfig = BuiltinConfig(),
    val sleep: SleepConfig = SleepConfig(),
) {
    companion object {
        val DEFAULT = LauncherConfig()
    }
}
