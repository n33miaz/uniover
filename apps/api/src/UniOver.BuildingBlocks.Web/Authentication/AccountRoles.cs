using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Papéis de uma conta. O dono usa tudo; o convidado usa só o controle da TV. O papel viaja no JWT (claim
/// <see cref="UniOverAuth.RoleClaim"/>) para que cada módulo decida sozinho, sem consultar o Identity.
/// </summary>
public static class AccountRoles
{
    public const string Owner = "owner";
    public const string Guest = "guest";

    /// <summary>
    /// Papel do usuário autenticado. Token sem a claim vem de antes dos convidados existirem, quando só havia o dono:
    /// vale como dono. Um convidado sempre recebe <c>guest</c> explícito, e o token é assinado, então a regra é segura.
    /// Claim presente e desconhecida não vira dono: devolve o valor como está (e nenhuma política o aceita).
    /// </summary>
    /// <remarks>
    /// Compatibilidade temporária: o "sem claim = dono" existe só para os JWT de antes do papel, que vivem até 15 min
    /// depois do deploy. Passado esse tempo, trocar por "sem claim = sem papel" (nenhuma política o aceita). Não fazer
    /// rollback do código para antes do papel enquanto houver convidados no banco: o código antigo emite token sem a
    /// claim, e este teria o convidado como dono.
    /// </remarks>
    public static string Of(ClaimsPrincipal? user) =>
        user?.FindFirst(UniOverAuth.RoleClaim)?.Value ?? Owner;

    public static bool IsKnown(string? role) =>
        string.Equals(role, Owner, StringComparison.Ordinal) || string.Equals(role, Guest, StringComparison.Ordinal);
}

/// <summary>Exige que o papel do usuário seja um dos listados.</summary>
public sealed class AccountRoleRequirement(IReadOnlyCollection<string> roles) : IAuthorizationRequirement
{
    public IReadOnlyCollection<string> Roles { get; } = roles;
}

internal sealed class AccountRoleHandler : AuthorizationHandler<AccountRoleRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, AccountRoleRequirement requirement)
    {
        if (context.User.Identity?.IsAuthenticated == true && requirement.Roles.Contains(AccountRoles.Of(context.User)))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

public static class AccountRolePolicyExtensions
{
    /// <summary>A política só aceita quem tem um destes papéis (além de estar autenticado).</summary>
    public static AuthorizationPolicyBuilder RequireAccountRole(this AuthorizationPolicyBuilder builder, params string[] roles)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(roles);
        if (roles.Length == 0)
        {
            throw new ArgumentException("Informe ao menos um papel.", nameof(roles));
        }

        return builder.RequireAuthenticatedUser().AddRequirements(new AccountRoleRequirement(roles));
    }

    /// <summary>A política só aceita GET: o bilhete de stream abre conexões SSE e não serve para escrever nada.</summary>
    public static AuthorizationPolicyBuilder RequireGetOnly(this AuthorizationPolicyBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.AddRequirements(new GetOnlyRequirement());
    }

    /// <summary>Convidado revogado perde o acesso mesmo com o JWT ainda válido (consulta curta e com cache, só para ele).</summary>
    public static AuthorizationPolicyBuilder RequireActiveAccount(this AuthorizationPolicyBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder.AddRequirements(new ActiveAccountRequirement());
    }
}
