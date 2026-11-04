namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>O que a conferência da estrutura de um JPEG concluiu.</summary>
internal enum JpegCheck
{
    /// <summary>Marcadores do SOI ao EOI, um quadro com dimensões dentro do teto e ao menos uma varredura.</summary>
    Valid,

    /// <summary>Não é um JPEG inteiro: não começa pelo SOI, foi cortado, não tem quadro ou varredura, ou tem lixo no meio.</summary>
    NotJpeg,

    /// <summary>A estrutura vale, mas largura ou altura (lidas do cabeçalho) estão fora de 1 a <see cref="JpegInspector.MaxDimension"/>.</summary>
    DimensionsOutOfRange,
}

/// <summary>
/// Confere a estrutura de um JPEG sem decodificá-lo e sem biblioteca: percorre os marcadores do SOI ao EOI, lê a largura e a
/// altura do quadro (SOF) e exige ao menos uma varredura (SOS) e o EOI como último marcador. Não prova que a imagem
/// decodifica (isso é do agente e do launcher), mas barra o que não tem forma de JPEG: arquivo cortado, sem quadro, com
/// dimensões absurdas ou com bytes quaisquer atrás de três bytes mágicos.
/// </summary>
internal static class JpegInspector
{
    /// <summary>Maior lado aceito, em pixels. O navegador reduz a foto para 1920x1080; o teto só barra o que é absurdo.</summary>
    public const int MaxDimension = 4096;

    public static JpegCheck Inspect(ReadOnlySpan<byte> data) => Inspect(data, out _, out _);

    public static JpegCheck Inspect(ReadOnlySpan<byte> data, out int width, out int height)
    {
        width = 0;
        height = 0;
        if (data.Length < 4 || data[0] != 0xFF || data[1] != 0xD8)
        {
            return JpegCheck.NotJpeg;
        }

        var position = 2;
        var hasFrame = false;
        var hasScan = false;
        while (true)
        {
            // Todo marcador começa por FF (que pode vir repetido, como enchimento); o fim do arquivo antes do EOI é corte.
            if (position >= data.Length || data[position] != 0xFF)
            {
                return JpegCheck.NotJpeg;
            }

            while (position < data.Length && data[position] == 0xFF)
            {
                position++;
            }

            if (position >= data.Length)
            {
                return JpegCheck.NotJpeg;
            }

            var marker = data[position++];
            if (marker == 0xD9)
            {
                // O EOI é o último byte: nada depois dele (arquivo com sobra não é o que o navegador gera).
                if (!hasFrame || !hasScan || position != data.Length)
                {
                    return JpegCheck.NotJpeg;
                }

                return width is >= 1 and <= MaxDimension && height is >= 1 and <= MaxDimension
                    ? JpegCheck.Valid
                    : JpegCheck.DimensionsOutOfRange;
            }

            // Sem tamanho: TEM (01) e os reinícios (D0 a D7).
            if (marker == 0x01 || marker is >= 0xD0 and <= 0xD7)
            {
                continue;
            }

            // 00 e um segundo SOI (D8) não têm lugar fora da varredura; os demais levam o tamanho em dois bytes.
            if (marker is 0x00 or 0xD8 || position + 2 > data.Length)
            {
                return JpegCheck.NotJpeg;
            }

            var length = (data[position] << 8) | data[position + 1];
            if (length < 2 || position + length > data.Length)
            {
                return JpegCheck.NotJpeg;
            }

            if (IsFrameMarker(marker))
            {
                // Tamanho, precisão (1), altura (2), largura (2), componentes (1) e 3 bytes por componente.
                if (hasFrame || length < 8)
                {
                    return JpegCheck.NotJpeg;
                }

                var components = data[position + 7];
                if (components < 1 || length < 8 + (3 * components))
                {
                    return JpegCheck.NotJpeg;
                }

                height = (data[position + 3] << 8) | data[position + 4];
                width = (data[position + 5] << 8) | data[position + 6];
                hasFrame = true;
            }

            position += length;
            if (marker == 0xDA)
            {
                if (!hasFrame)
                {
                    return JpegCheck.NotJpeg;
                }

                hasScan = true;
                position = SkipScanData(data, position);
            }
        }
    }

    /// <summary>SOF0 a SOF15, menos DHT (C4), JPG (C8) e DAC (CC), que têm marcadores vizinhos mas não são quadros.</summary>
    private static bool IsFrameMarker(byte marker) => marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC;

    /// <summary>Pula os dados da varredura: vão até o próximo marcador de verdade (FF 00 e os reinícios D0 a D7 fazem parte dela).</summary>
    private static int SkipScanData(ReadOnlySpan<byte> data, int position)
    {
        while (position < data.Length)
        {
            if (data[position] != 0xFF)
            {
                position++;
                continue;
            }

            var next = position + 1 < data.Length ? data[position + 1] : -1;
            if (next == 0x00 || next is >= 0xD0 and <= 0xD7)
            {
                position += 2;
            }
            else if (next == 0xFF)
            {
                position++;
            }
            else
            {
                break;
            }
        }

        return position;
    }
}
