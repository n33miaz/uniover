using System.Text.RegularExpressions;

namespace UniOver.Modules.Identity.Domain;

/// <summary>
/// O que a conta respondeu à dica "adicionar à tela de início", por app (raiz, <c>tv</c>, <c>treino</c>): vale em qualquer
/// aparelho e sobrevive à limpeza de dados do Safari. Tabela própria, de propósito: a Início (<see cref="AccountPreferences"/>)
/// tem controle de versão e uma gravação concorrente desta aqui nunca pode fazê-la conflitar nem se desfazer.
/// A linha só existe depois da primeira resposta.
/// </summary>
public sealed class InstallHintAnswers
{
    // Para o EF Core materializar a linha.
    private InstallHintAnswers()
    {
    }

    public Guid UserId { get; private set; }

    /// <summary>As respostas como JSON de <c>{ app: InstallHintScope }</c> (<see cref="InstallHintRules"/>).</summary>
    public string AnswersJson { get; private set; } = "{}";

    public DateTimeOffset UpdatedAt { get; private set; }

    public static InstallHintAnswers Create(Guid userId, string answersJson, DateTimeOffset now) =>
        new() { UserId = userId, AnswersJson = answersJson, UpdatedAt = now };

    public void Replace(string answersJson, DateTimeOffset now)
    {
        AnswersJson = answersJson;
        UpdatedAt = now;
    }
}

/// <summary>O que se sabe de um app: quando disse "Agora não", se pediu para parar e se instalou.</summary>
/// <param name="DismissedAt">Instante (ms desde 1970) do último "Agora não".</param>
public sealed record InstallHintScope(long? DismissedAt, bool? Never, bool? Installed);

/// <summary>
/// Forma e fusão da resposta da dica de instalação. A fusão é monotônica: "instalado" e "nunca" só viram verdadeiros e o
/// "Agora não" fica no instante mais novo. Assim dois aparelhos gravando ao mesmo tempo, ou um aparelho com a memória
/// local apagada, nunca desfazem uma resposta que a pessoa já deu.
/// </summary>
public static partial class InstallHintRules
{
    public const int MaxScopes = 8;

    /// <summary>Um "Agora não" no futuro (relógio errado do aparelho) travaria a dica por muito tempo: o servidor limita a este adiantamento.</summary>
    public static readonly TimeSpan MaxClockSkew = TimeSpan.FromDays(1);

    // `\z` e não `$`: o `$` aceitaria uma quebra de linha depois do id.
    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]{0,39}\z", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex ScopePattern();

    /// <summary>Mensagem do primeiro problema, ou nulo se o corpo é aceitável.</summary>
    public static string? Validate(IReadOnlyDictionary<string, InstallHintScope?>? scopes)
    {
        if (scopes is null)
        {
            return "Informe a resposta da dica por app.";
        }

        if (scopes.Count > MaxScopes)
        {
            return $"A dica aceita no máximo {MaxScopes} apps.";
        }

        foreach (var (scope, value) in scopes)
        {
            if (!ScopePattern().IsMatch(scope) || value is null)
            {
                return "Cada app precisa de um id curto, em minúsculas, e de uma resposta.";
            }

            if (value.DismissedAt is < 0)
            {
                return "O instante do \"Agora não\" não pode ser negativo.";
            }
        }

        return null;
    }

    /// <summary>Funde o que chegou com o que a conta já tinha; o "Agora não" nunca passa de <paramref name="now"/> mais <see cref="MaxClockSkew"/>.</summary>
    public static IReadOnlyDictionary<string, InstallHintScope> Merge(
        IReadOnlyDictionary<string, InstallHintScope>? current,
        IReadOnlyDictionary<string, InstallHintScope?> incoming,
        DateTimeOffset now)
    {
        var ceiling = (now + MaxClockSkew).ToUnixTimeMilliseconds();
        var result = new Dictionary<string, InstallHintScope>(current ?? new Dictionary<string, InstallHintScope>(), StringComparer.Ordinal);
        foreach (var (scope, value) in incoming)
        {
            if (value is null)
            {
                continue;
            }

            result.TryGetValue(scope, out var old);
            result[scope] = new InstallHintScope(
                Max(old?.DismissedAt, value.DismissedAt is { } at ? Math.Min(at, ceiling) : null),
                value.Never == true || old?.Never == true ? true : null,
                value.Installed == true || old?.Installed == true ? true : null);
        }

        return result;
    }

    private static long? Max(long? a, long? b) => a is null ? b : b is null ? a : Math.Max(a.Value, b.Value);
}
