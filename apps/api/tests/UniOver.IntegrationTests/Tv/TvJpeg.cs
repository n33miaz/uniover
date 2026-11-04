namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// JPEGs de teste montados à mão, só com a estrutura de marcadores (SOI, quadro, varredura, EOI): bastam para a API, que
/// confere a estrutura e as dimensões do cabeçalho mas não decodifica a imagem.
/// </summary>
internal static class TvJpeg
{
    private static readonly byte[] Tail = [0xFF, 0xD9];

    /// <summary>Um JPEG mínimo válido de <paramref name="width"/> por <paramref name="height"/>, com o tamanho total pedido (0 = o menor possível).</summary>
    public static byte[] Build(int width, int height, int totalLength = 0)
    {
        var head = Head(width, height);
        var scan = new byte[Math.Max(0, totalLength - head.Length - Tail.Length)];
        for (var i = 0; i < scan.Length; i++)
        {
            // Dados da varredura nunca levam FF solto: 0x11..0x7F não confundem com marcador.
            scan[i] = (byte)(0x11 + (i % 0x6F));
        }

        return [.. head, .. scan, .. Tail];
    }

    /// <summary>SOI, quadro (SOF0, um componente) e o cabeçalho da varredura (SOS), sem dados nem EOI.</summary>
    public static byte[] Head(int width, int height) =>
    [
        0xFF, 0xD8,
        0xFF, 0xC0, 0x00, 0x0B, 0x08,
        (byte)(height >> 8), (byte)(height & 0xFF), (byte)(width >> 8), (byte)(width & 0xFF),
        0x01, 0x01, 0x11, 0x00,
        0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
    ];
}
