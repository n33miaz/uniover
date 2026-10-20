using System.Security.Cryptography;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Ícone de um app da TV: imagem pequena (PNG ou WebP) que o agente tirou do APK. Chega em base64 dentro de
/// <c>tv.apps.v2</c> e volta para a tela como <c>data:</c> URI, porque o CSP do PWA só aceita <c>img-src 'self' data:</c>
/// e um <c>&lt;img src&gt;</c> não consegue mandar o cabeçalho de autenticação.
/// </summary>
public sealed record ShortcutIcon(string Mime, byte[] Data)
{
    public const string Png = "image/png";
    public const string Webp = "image/webp";

    /// <summary>Mesmo teto do contrato: 32768 bytes viram até 43692 caracteres de base64.</summary>
    public const int MaxBytes = 32 * 1024;

    public const int MaxBase64Chars = (MaxBytes + 2) / 3 * 4;

    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>
    /// Decodifica e confere o ícone na borda. Recusa tipo fora de PNG/WebP, base64 inválido, imagem acima do limite e
    /// conteúdo que não bate com o tipo declarado (o tipo vai direto para o <c>data:</c> URI que o navegador abre).
    /// O contrato já barra isso, mas o contrato é validado por quem recebe a mensagem; aqui é a última defesa.
    /// </summary>
    public static bool TryCreate(string? mime, string? base64, out ShortcutIcon? icon)
    {
        icon = null;
        if (mime is not (Png or Webp) || string.IsNullOrEmpty(base64) || base64.Length > MaxBase64Chars)
        {
            return false;
        }

        var buffer = new byte[MaxBytes];
        if (!Convert.TryFromBase64String(base64, buffer, out var written) || written == 0)
        {
            return false;
        }

        var data = buffer.AsSpan(0, written);
        if (!MatchesMime(mime, data))
        {
            return false;
        }

        icon = new ShortcutIcon(mime, data.ToArray());
        return true;
    }

    /// <summary>Impressão digital do conteúdo: só regrava o ícone quando ela muda.</summary>
    public string Sha256() => Convert.ToHexStringLower(SHA256.HashData(Data));

    /// <summary>O ícone como a tela o consome (<c>data:image/png;base64,...</c>).</summary>
    public string ToDataUri() => $"data:{Mime};base64,{Convert.ToBase64String(Data)}";

    private static bool MatchesMime(string mime, ReadOnlySpan<byte> data) =>
        mime == Png
            ? data.StartsWith(PngSignature)
            : data.Length >= 12 && data[..4].SequenceEqual("RIFF"u8) && data.Slice(8, 4).SequenceEqual("WEBP"u8);
}
