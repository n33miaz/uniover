using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Papéis de uma conta. <c>owner</c> é o Administrador (todas as permissões, implícitas); <c>guest</c> é a pessoa cujo
/// acesso é o que as permissões concedidas a ela dizem (<see cref="AccessPermissions"/>). O papel viaja no JWT (claim
/// <see cref="UniOverAuth.RoleClaim"/>) para que cada módulo decida sozinho, sem consultar o Identity; as permissões
/// NÃO viajam: vêm do banco, com cache curto (<see cref="IAccessGrants"/>).
/// </summary>
public static class AccountRoles
{
    public const string Owner = "owner";
    public const string Guest = "guest";

    /// <summary>
    /// Papel do usuário autenticado: o valor da claim como está, ou <c>null</c> se ela não existe. Token sem a claim
    /// NÃO é dono (esse atalho de compatibilidade acabou: todo token emitido hoje já traz o papel), e uma claim
    /// desconhecida também não: nenhuma política aceita <c>null</c> nem um valor fora de <see cref="IsKnown"/>.
    /// </summary>
    public static string? Of(ClaimsPrincipal? user) => user?.FindFirst(UniOverAuth.RoleClaim)?.Value;

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
        // Sem a claim de papel (ou com papel que a política não lista) ninguém passa: não há papel padrão.
        if (context.User.Identity?.IsAuthenticated == true
            && AccountRoles.Of(context.User) is { } role
            && requirement.Roles.Contains(role))
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
