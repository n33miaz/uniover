using System.Buffers.Text;
using System.Globalization;
using System.Text;

namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Cursor da leitura incremental: o par (<c>updated_at</c>, <c>id</c>) do último registro entregue, em base64url. O texto é
/// opaco para quem lê a tela, mas o formato é estável e documentado (<c>&lt;ticks UTC&gt;|&lt;uuid&gt;</c>) porque o
/// aparelho recua o cursor uma margem de segurança antes de puxar.
/// </summary>
public readonly record struct PullCursor(DateTimeOffset UpdatedAt, Guid Id)
{
    /// <summary>Tamanho de página padrão da leitura incremental.</summary>
    public const int DefaultLimit = 200;

    public const int MaxLimit = 500;

    public string Encode()
    {
        var text = string.Create(CultureInfo.InvariantCulture, $"{UpdatedAt.UtcTicks}|{Id:D}");
        return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));
    }

    public static bool TryDecode(string? value, out PullCursor cursor)
    {
        cursor = default;
        if (string.IsNullOrEmpty(value) || value.Length > 120)
        {
            return false;
        }

        try
        {
            var text = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(value));
            var parts = text.Split('|');
            if (parts.Length != 2
                || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
                || ticks > DateTime.MaxValue.Ticks
                || !Guid.TryParseExact(parts[1], "D", out var id))
            {
                return false;
            }

            cursor = new PullCursor(new DateTimeOffset(ticks, TimeSpan.Zero), id);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
