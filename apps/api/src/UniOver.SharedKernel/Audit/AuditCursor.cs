using System.Buffers.Text;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace UniOver.SharedKernel.Audit;

/// <summary>
/// Como o cursor se compara com uma fonte quando duas linhas têm o MESMO instante. A ordem total da trilha é
/// (instante, fonte, id), da mais nova para a mais antiga; cada fonte aplica a regra que cabe a ela.
/// </summary>
public enum AuditTie
{
    /// <summary>É a fonte do cursor: no mesmo instante, só vêm as linhas de id menor.</summary>
    SameSource,

    /// <summary>Fonte que vem DEPOIS da do cursor no mesmo instante: as linhas desse instante ainda não saíram.</summary>
    IncludeSameInstant,

    /// <summary>Fonte que vem ANTES da do cursor no mesmo instante: as linhas desse instante já saíram.</summary>
    ExcludeSameInstant,
}

/// <summary>
/// Posição composta <c>(instante, fonte, id)</c> numa trilha unificada de várias tabelas. Só guarda a posição: nenhuma
/// permissão nem filtro viaja nele (os filtros vêm de cada pedido e o acesso é conferido a cada pedido), então não
/// precisa de assinatura; um cursor adulterado só muda onde a página começa, e um malformado é recusado.
/// </summary>
public sealed partial record AuditCursor
{
    private const int MaxEncodedLength = 160;
    private const string Version = "1";

    [GeneratedRegex("^[a-z][a-z0-9_]{1,40}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex ModulePattern();

    public AuditCursor(DateTimeOffset occurredAt, string module, Guid id)
    {
        ArgumentNullException.ThrowIfNull(module);
        if (!ModulePattern().IsMatch(module))
        {
            throw new ArgumentException("Nome de fonte inválido.", nameof(module));
        }

        // Sempre em UTC: o Npgsql só aceita deslocamento zero em timestamptz, e é com ele que o banco compara.
        OccurredAt = occurredAt.ToUniversalTime();
        Module = module;
        Id = id;
    }

    public DateTimeOffset OccurredAt { get; }

    public string Module { get; }

    public Guid Id { get; }

    public static AuditCursor Of(AuditRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        return new AuditCursor(record.OccurredAt, record.Module, record.Id);
    }

    /// <summary>Texto opaco, seguro para URL (base64url, sem preenchimento). O instante vai em ticks: sem perda de precisão.</summary>
    public string Encode()
    {
        var text = string.Create(
            CultureInfo.InvariantCulture, $"{Version}|{OccurredAt.UtcTicks}|{Module}|{Id:N}");
        return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));
    }

    /// <summary>Lê um cursor recebido de um cliente. Qualquer coisa fora do formato exato é recusada (<c>false</c>), nunca lança.</summary>
    public static bool TryDecode(string? encoded, out AuditCursor? cursor)
    {
        cursor = null;
        if (string.IsNullOrEmpty(encoded) || encoded.Length > MaxEncodedLength)
        {
            return false;
        }

        try
        {
            var text = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(encoded));
            var parts = text.Split('|');
            if (parts.Length != 4
                || parts[0] != Version
                || !long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
                || ticks > DateTimeOffset.MaxValue.UtcTicks
                || !ModulePattern().IsMatch(parts[2])
                || parts[3].Length != 32
                || !Guid.TryParseExact(parts[3], "N", out var id))
            {
                return false;
            }

            cursor = new AuditCursor(new DateTimeOffset(ticks, TimeSpan.Zero), parts[2], id);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            // Bytes que não são UTF-8 válido ou ticks fora do intervalo do tipo: é só um cursor ruim.
            return false;
        }
    }

    /// <summary>A regra de desempate no mesmo instante para a fonte <paramref name="module"/>.</summary>
    public AuditTie TieFor(string module)
    {
        ArgumentNullException.ThrowIfNull(module);

        // Ordem descendente por nome da fonte: quem tem nome MAIOR sai primeiro dentro do mesmo instante.
        var order = string.CompareOrdinal(module, Module);
        return order == 0 ? AuditTie.SameSource : order < 0 ? AuditTie.IncludeSameInstant : AuditTie.ExcludeSameInstant;
    }
}

/// <summary>
/// A ordem da trilha unificada: o mais novo primeiro; no mesmo instante, a fonte de nome maior; depois o id maior.
/// O id é comparado como texto canônico minúsculo, que ordena exatamente como o <c>uuid</c> do Postgres (byte a byte):
/// quem junta as fontes em memória e quem ordena no banco precisam concordar, ou a página repetiria ou perderia linhas.
/// </summary>
public sealed class AuditOrder : IComparer<AuditRecord>
{
    public static AuditOrder Newest { get; } = new();

    public int Compare(AuditRecord? x, AuditRecord? y)
    {
        ArgumentNullException.ThrowIfNull(x);
        ArgumentNullException.ThrowIfNull(y);

        var byInstant = y.OccurredAt.UtcTicks.CompareTo(x.OccurredAt.UtcTicks);
        if (byInstant != 0)
        {
            return byInstant;
        }

        var byModule = string.CompareOrdinal(y.Module, x.Module);
        return byModule != 0
            ? byModule
            : string.CompareOrdinal(y.Id.ToString("D", CultureInfo.InvariantCulture), x.Id.ToString("D", CultureInfo.InvariantCulture));
    }
}
