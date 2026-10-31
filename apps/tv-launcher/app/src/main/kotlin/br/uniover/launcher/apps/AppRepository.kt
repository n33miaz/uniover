package br.uniover.launcher.apps

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable

/** Leitura dos apps instalados pelo PackageManager. Só o que a home precisa; nada fica em segundo plano. */
class AppRepository(private val context: Context) {
    private val pm: PackageManager = context.packageManager

    /** Apps com ícone de TV (leanback) ou de celular, um por pacote. */
    fun installed(): List<InstalledApp> {
        val seen = LinkedHashMap<String, InstalledApp>()
        for (category in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)) {
            val query = Intent(Intent.ACTION_MAIN).addCategory(category)
            for (info in pm.queryIntentActivities(query, 0)) {
                val pkg = info.activityInfo?.packageName ?: continue
                if (pkg in seen) continue
                val flags = info.activityInfo.applicationInfo.flags
                val isSystem = flags and ApplicationInfo.FLAG_SYSTEM != 0
                val updated = flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP != 0
                seen[pkg] = InstalledApp(
                    packageName = pkg,
                    label = info.loadLabel(pm)?.toString()?.takeIf { it.isNotBlank() } ?: pkg,
                    isFactory = isSystem && !updated,
                )
            }
        }
        return seen.values.toList()
    }

    /** Ícone do app (o adaptativo, se tiver). Nulo se o pacote sumiu entre a lista e o desenho. */
    fun icon(packageName: String): Drawable? = try {
        launchIntent(packageName)?.let { pm.resolveActivity(it, 0)?.loadIcon(pm) } ?: pm.getApplicationIcon(packageName)
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: RuntimeException) {
        null
    }

    /** Intent de abertura: leanback primeiro, depois o ícone de celular. */
    fun launchIntent(packageName: String): Intent? =
        pm.getLeanbackLaunchIntentForPackage(packageName) ?: pm.getLaunchIntentForPackage(packageName)
}
