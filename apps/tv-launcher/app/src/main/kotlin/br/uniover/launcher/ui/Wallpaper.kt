package br.uniover.launcher.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import br.uniover.launcher.config.WallpaperConfig
import br.uniover.launcher.config.WallpaperType
import java.io.File

/** Papel de parede: degradê e cor sólida são desenhos vetoriais (quase sem memória); foto é um bitmap único. */
object Wallpaper {
    /** Mesma convenção do Android: 0 = esquerda para direita, anti-horário. */
    fun orientationFor(angle: Int): GradientDrawable.Orientation = when (((angle % 360) + 360) % 360) {
        0 -> GradientDrawable.Orientation.LEFT_RIGHT
        45 -> GradientDrawable.Orientation.BL_TR
        90 -> GradientDrawable.Orientation.BOTTOM_TOP
        135 -> GradientDrawable.Orientation.BR_TL
        180 -> GradientDrawable.Orientation.RIGHT_LEFT
        225 -> GradientDrawable.Orientation.TR_BL
        270 -> GradientDrawable.Orientation.TOP_BOTTOM
        else -> GradientDrawable.Orientation.TL_BR
    }

    /** Fundo sem foto (ou enquanto a foto ainda decodifica). */
    fun backdrop(config: WallpaperConfig): Drawable {
        val colors = config.colors.ifEmpty { WallpaperConfig.DEFAULT_COLORS }
        if (config.type == WallpaperType.SOLID || colors.size == 1) return ColorDrawable(colors.first())
        return GradientDrawable(orientationFor(config.angle), colors.toIntArray())
    }

    /**
     * Fator de redução para a foto caber na tela sem desperdiçar memória: a maior potência de 2 que ainda deixa a
     * imagem do tamanho da tela ou maior (o `CENTER_CROP` precisa cobrir a tela inteira).
     */
    fun sampleSize(srcWidth: Int, srcHeight: Int, dstWidth: Int, dstHeight: Int): Int {
        if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) return 1
        var sample = 1
        while (srcWidth / (sample * 2) >= dstWidth && srcHeight / (sample * 2) >= dstHeight) sample *= 2
        return sample
    }

    /** Decodifica em RGB_565 (metade da memória de ARGB_8888; sem transparência numa foto de fundo). Nulo se falhar. */
    fun decodePhoto(file: File, dstWidth: Int, dstHeight: Int): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, dstWidth, dstHeight)
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        BitmapFactory.decodeFile(file.path, options)
    } catch (_: OutOfMemoryError) {
        null
    } catch (_: RuntimeException) {
        null
    }
}
