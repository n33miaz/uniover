using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.DependencyInjection;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Porta: a conta ainda está ativa (não foi revogada)? Quem guarda as contas (o módulo de identidade) a implementa; a
/// resposta pode vir de um cache curto, então a revogação vale em até o prazo do cache. Fica aqui para os módulos
/// decidirem o acesso pelo JWT sem referenciar o interior do Identity (um módulo extraído troca por um cliente HTTP).
/// </summary>
public interface IAccountStatus
{
    Task<bool> IsActiveAsync(Guid userId, CancellationToken cancellationToken = default);
}

/// <summary>
/// Exige que a conta de um convidado não tenha sido revogada, mesmo com o JWT de acesso ainda dentro da validade.
/// O dono não paga a consulta. Sem implementação registrada de <see cref="IAccountStatus"/> o convidado é recusado
/// (falha fechada).
/// </summary>
public sealed class ActiveAccountRequirement : IAuthorizationRequirement;

internal sealed class ActiveAccountHandler(IServiceProvider services) : AuthorizationHandler<ActiveAccountRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, ActiveAccountRequirement requirement)
    {
        if (!string.Equals(AccountRoles.Of(context.User), AccountRoles.Guest, StringComparison.Ordinal))
        {
            // Dono: sem consulta. Papel desconhecido já foi barrado pelo requisito de papel.
            context.Succeed(requirement);
            return;
        }

        var status = services.GetService<IAccountStatus>();
        if (status is null || !Guid.TryParse(context.User.FindFirst(UniOverAuth.SubjectClaim)?.Value, out var userId))
        {
            return;
        }

        if (await status.IsActiveAsync(userId))
        {
            context.Succeed(requirement);
        }
    }
}
