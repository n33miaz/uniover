using System.Text.RegularExpressions;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Um módulo na Início da conta: qual é e se aparece. A ordem é a ordem da lista.</summary>
public sealed record HomeEntry(string Id, bool Enabled);

/// <summary>
/// O que a conta guarda de personalização, para valer em todo aparelho dela. Hoje só a Início (módulos, ordem e
/// visibilidade). A linha só existe depois da primeira gravação: conta sem linha usa o padrão, na versão zero.
/// </summary>
public sealed class AccountPreferences
{
    // Para o EF Core materializar a linha.
    private AccountPreferences()
    {
    }

    public Guid UserId { get; private set; }

    /// <summary>A Início como lista JSON de <see cref="HomeEntry"/>; nulo é "voltou ao padrão".</summary>
    public string? HomeJson { get; private set; }

    /// <summary>
    /// Sobe um a cada gravação. O cliente informa em qual versão se baseou: se outro aparelho gravou antes, a versão
    /// já não é a mesma e a gravação é recusada, em vez de apagar a mudança mais nova.
    /// </summary>
    public int Version { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public static AccountPreferences Create(Guid userId, string? homeJson, DateTimeOffset now) =>
        new() { UserId = userId, HomeJson = homeJson, Version = 1, CreatedAt = now, UpdatedAt = now };
}

/// <summary>Limites e forma aceita para a lista da Início: o servidor não confia no tamanho nem no texto do cliente.</summary>
public static partial class HomePreferenceRules
{
    /// <summary>Mais do que o catálogo terá por muito tempo; só impede um corpo gigante.</summary>
    public const int MaxEntries = 32;

    public const int MaxIdLength = 40;

    // `\z` e não `$`: o `$` aceitaria uma quebra de linha depois do id.
    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]{0,39}\z",RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex IdPattern();

    /// <summary>Mensagem do primeiro problema da lista, ou nulo se ela é aceitável (nula = padrão).</summary>
    public static string? Validate(IReadOnlyList<HomeEntry?>? entries)
    {
        if (entries is null)
        {
            return null;
        }

        if (entries.Count > MaxEntries)
        {
            return $"A lista da Início aceita no máximo {MaxEntries} módulos.";
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (entry?.Id is not { } id || !IdPattern().IsMatch(id))
            {
                return "Cada módulo precisa de um id curto, em minúsculas, com letras, números e hífen.";
            }

            if (!seen.Add(id))
            {
                return "Um módulo não pode aparecer duas vezes na lista.";
            }
        }

        return null;
    }
}
