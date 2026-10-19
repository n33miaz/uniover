using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Exige que a sessão tenha confirmado uma ação perigosa com a passkey há pouco tempo. Quem usa escreve só
/// <c>.RequireAuthorization(StepUp.Policy("devices.pair-approve"))</c>: o módulo dono da confirmação (Identity) é quem
/// resolve a política pelo nome, então nenhum outro módulo precisa referenciá-lo.
/// </summary>
public static partial class StepUp
{
    /// <summary>Prefixo do nome da política; o provedor do Identity reconhece nomes que o têm.</summary>
    public const string PolicyPrefix = "stepup:";

    public const int MaxActionLength = 64;

    /// <summary>Tipo (sufixo de URL) do erro 403 que manda o cliente abrir o fluxo de confirmação.</summary>
    public const string RequiredProblemType = "step-up-required";

    /// <summary>Valor da extensão <c>code</c> do mesmo erro.</summary>
    public const string RequiredCode = "step_up_required";

    [GeneratedRegex(@"^[a-z0-9]+([.-][a-z0-9]+)*\z", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex ActionPattern();

    /// <summary>Minúsculas, dígitos e separadores <c>.</c> ou <c>-</c> entre eles, até 64 caracteres.</summary>
    public static bool IsValidAction(string? action) =>
        action is { Length: > 0 and <= MaxActionLength } && ActionPattern().IsMatch(action);

    /// <summary>Nome da política que exige confirmação de <paramref name="action"/>.</summary>
    /// <exception cref="ArgumentException">Ação fora do formato: melhor falhar ao mapear a rota do que gerar uma rota que nunca libera.</exception>
    public static string Policy(string action)
    {
        if (!IsValidAction(action))
        {
            throw new ArgumentException(
                "Ação de confirmação inválida: use minúsculas, dígitos e '.' ou '-', até 64 caracteres.", nameof(action));
        }

        return PolicyPrefix + action;
    }

    /// <summary>Extrai a ação de um nome de política; falso se não for uma política de confirmação.</summary>
    public static bool TryGetAction(string? policyName, out string action)
    {
        action = string.Empty;
        if (policyName is null || !policyName.StartsWith(PolicyPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var candidate = policyName[PolicyPrefix.Length..];
        if (!IsValidAction(candidate))
        {
            return false;
        }

        action = candidate;
        return true;
    }
}

/// <summary>
/// Requisito de uma confirmação válida da <see cref="Action"/> na sessão atual. O tratamento fica no Identity
/// (a autorização é avaliada no módulo que guarda as confirmações).
/// </summary>
public sealed class StepUpRequirement(string action) : IAuthorizationRequirement
{
    public string Action { get; } = action;
}
