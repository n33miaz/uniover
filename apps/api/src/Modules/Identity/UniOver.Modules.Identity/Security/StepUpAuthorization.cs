using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Monta, para nomes com o prefixo de confirmação, a política "autenticado + confirmação da ação". Qualquer outro
/// nome (inclusive a política padrão e a de fallback) vai para o provedor original: sem isso a regra de
/// "autenticado por padrão" sumiria.
/// </summary>
internal sealed class StepUpPolicyProvider(IOptions<AuthorizationOptions> options) : DefaultAuthorizationPolicyProvider(options)
{
    public override Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        if (StepUp.TryGetAction(policyName, out var action))
        {
            return Task.FromResult<AuthorizationPolicy?>(new AuthorizationPolicyBuilder()
                .RequireAuthenticatedUser()
                .AddRequirements(new StepUpRequirement(action))
                .Build());
        }

        return base.GetPolicyAsync(policyName);
    }
}

/// <summary>
/// Decide o requisito de confirmação consultando o banco do próprio módulo: precisa existir uma confirmação da
/// mesma ação, na mesma sessão, ainda dentro da validade, e a sessão não pode ter sido encerrada.
/// </summary>
internal sealed class StepUpRequirementHandler(IdentityDbContext db, ICurrentUser current, TimeProvider time)
    : AuthorizationHandler<StepUpRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, StepUpRequirement requirement)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(requirement);

        if (current.UserId is not { } userId || current.SessionId is not { } sessionId)
        {
            return;
        }

        var now = time.GetUtcNow();
        var action = requirement.Action;

        var confirmed = await db.StepUpConfirmations.AnyAsync(
            c => c.UserId == userId && c.SessionFamilyId == sessionId && c.Action == action && c.ExpiresAt > now);
        if (!confirmed)
        {
            return;
        }

        // O JWT de acesso sobrevive ao logout por alguns minutos; a confirmação não pode sobreviver junto.
        var sessionAlive = await db.RefreshTokens.AnyAsync(
            t => t.FamilyId == sessionId && t.UserId == userId && t.RevokedAt == null);
        if (sessionAlive)
        {
            context.Succeed(requirement);
        }
    }
}

/// <summary>
/// Troca o 403 vazio por um ProblemDetails <c>step-up-required</c> com a ação, para o app abrir o fluxo de
/// confirmação e repetir o pedido. Todo o resto (inclusive o 401) segue o tratamento padrão.
/// </summary>
internal sealed class StepUpAuthorizationResponder(IProblemDetailsService problems) : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public async Task HandleAsync(
        RequestDelegate next, HttpContext context, AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        ArgumentNullException.ThrowIfNull(next);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(authorizeResult);

        var missing = authorizeResult.Forbidden
            ? authorizeResult.AuthorizationFailure?.FailedRequirements.OfType<StepUpRequirement>().FirstOrDefault()
            : null;
        if (missing is null)
        {
            await _default.HandleAsync(next, context, policy, authorizeResult);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status403Forbidden,
                Title = "Esta ação precisa da confirmação com a passkey.",
                Type = ProblemDetailsExtensions.TypeBase + StepUp.RequiredProblemType,
                Extensions =
                {
                    ["code"] = StepUp.RequiredCode,
                    ["action"] = missing.Action,
                },
            },
        });
    }
}
