using System.Globalization;
using System.Text;

namespace UniOver.Modules.Identity.Audit;

/// <summary>
/// Exportação da trilha em CSV (RFC 4180, UTF-8 com marca de ordem para o Excel abrir os acentos). O aparelho
/// (<c>User-Agent</c>) é texto que o cliente escolhe, então toda célula passa pela neutralização de fórmula: uma célula
/// que começa por <c>=</c>, <c>+</c>, <c>-</c>, <c>@</c>, tabulação ou retorno de carro ganha um apóstrofo na frente,
/// e o Excel e as planilhas parecidas a tratam como texto em vez de executar.
/// </summary>
internal static class AuditCsv
{
    public static readonly string[] Header =
    [
        "occurredAt", "module", "action", "outcome", "actorId", "actorName", "target", "targetAccountId",
        "targetAccountName", "detail", "ip", "userAgent",
    ];

    private const string LineBreak = "\r\n";

    public static byte[] Write(IEnumerable<AuditItem> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var text = new StringBuilder();
        AppendRow(text, Header);
        foreach (var item in items)
        {
            AppendRow(
                text,
                [
                    item.OccurredAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture),
                    item.Module,
                    item.Action,
                    item.Outcome,
                    item.Actor?.Id.ToString("D", CultureInfo.InvariantCulture),
                    item.Actor?.DisplayName,
                    item.Target,
                    item.TargetAccount?.Id.ToString("D", CultureInfo.InvariantCulture),
                    item.TargetAccount?.DisplayName,
                    item.Detail,
                    item.Ip,
                    item.UserAgent,
                ]);
        }

        var preamble = Encoding.UTF8.GetPreamble();
        var body = Encoding.UTF8.GetBytes(text.ToString());
        var bytes = new byte[preamble.Length + body.Length];
        preamble.CopyTo(bytes, 0);
        body.CopyTo(bytes, preamble.Length);
        return bytes;
    }

    /// <summary>Uma célula pronta para o arquivo: sem fórmula executável e entre aspas quando precisa.</summary>
    public static string Cell(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var safe = value[0] is '=' or '+' or '-' or '@' or '\t' or '\r' ? "'" + value : value;
        return safe.AsSpan().IndexOfAny(",\"\r\n") >= 0
            ? "\"" + safe.Replace("\"", "\"\"", StringComparison.Ordinal) + "\""
            : safe;
    }

    private static void AppendRow(StringBuilder text, string?[] cells)
    {
        for (var i = 0; i < cells.Length; i++)
        {
            if (i > 0)
            {
                text.Append(',');
            }

            text.Append(Cell(cells[i]));
        }

        text.Append(LineBreak);
    }
}
