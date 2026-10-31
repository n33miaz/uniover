using System.Security.Cryptography;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>
/// A foto do fundo: o que a API aceita guardar e como ela viaja até o agente. O navegador a reduz (no máximo 1920x1080,
/// JPEG) antes de enviar; aqui só se confere o teto e o formato, porque o agente confere de novo (tamanho, formato e
/// sha256) antes de gravar na TV.
/// </summary>
internal static class LivrePhoto
{
    /// <summary>Teto da foto guardada (o mesmo do agente e do contrato da mensagem).</summary>
    public const int MaxBytes = Domain.TvLivreEntry.PhotoMaxBytes;

    /// <summary>
    /// Bytes crus de cada pedaço. O transporte recusa mensagem acima de 64 KB e o base64 cresce um terço: 30000 bytes viram
    /// 40000 caracteres, que com o envelope cabem folgados.
    /// </summary>
    public const int ChunkBytes = 30000;

    /// <summary>Quantos pedaços uma foto de <see cref="MaxBytes"/> precisa, no máximo (o contrato aceita até 16).</summary>
    public const int MaxChunks = 16;

    public const string ContentType = "image/jpeg";

    private static readonly byte[] JpegMagic = [0xFF, 0xD8, 0xFF];

    /// <summary>Todo JPEG começa por FF D8 FF; o resto é problema do agente, que decodifica antes de gravar.</summary>
    public static bool LooksLikeJpeg(ReadOnlySpan<byte> data) => data.StartsWith(JpegMagic);

    /// <summary>O sha256 em hexadecimal minúsculo, como o contrato da mensagem pede.</summary>
    public static string Sha256Hex(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));

    /// <summary>Parte a foto em pedaços de <see cref="ChunkBytes"/> (o último leva o resto), na ordem em que o agente os junta.</summary>
    public static IReadOnlyList<byte[]> Slice(byte[] photo)
    {
        ArgumentNullException.ThrowIfNull(photo);
        if (photo.Length == 0 || photo.Length > MaxBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(photo), "A foto vazia ou acima do teto não vai em pedaços.");
        }

        var chunks = new List<byte[]>((photo.Length + ChunkBytes - 1) / ChunkBytes);
        for (var offset = 0; offset < photo.Length; offset += ChunkBytes)
        {
            chunks.Add(photo[offset..Math.Min(offset + ChunkBytes, photo.Length)]);
        }

        return chunks;
    }
}
