using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Selection;

/// <summary>TV escolhida para a requisição. O id vazio só representa a compatibilidade temporária com AgentId no ambiente.</summary>
internal sealed record TvTarget(Guid Id, string AgentSlug, string Name, bool IsDefault)
{
    public bool IsPersisted => Id != Guid.Empty;
}

internal interface ITvCurrentSelection
{
    TvTarget Current { get; }

    bool TryGet(out TvTarget? target);

    void Set(TvTarget target);
}

internal sealed class TvCurrentSelection : ITvCurrentSelection
{
    private TvTarget? _target;

    public TvTarget Current => _target ?? throw new InvalidOperationException("A TV da requisição ainda não foi selecionada.");

    public bool TryGet(out TvTarget? target)
    {
        target = _target;
        return target is not null;
    }

    public void Set(TvTarget target) => _target = target ?? throw new ArgumentNullException(nameof(target));
}

/// <summary>
/// Centraliza a regra de visibilidade para que uma rota nova não consiga, por esquecimento, operar uma TV de outra conta.
/// Quem tem filiação vê as TVs das quais é membro. Quem NUNCA teve filiação é a conta de antes das várias TVs e continua na
/// TV padrão. Quem já teve e foi retirado (marca <see cref="TvMemberOptOut"/>) não vê TV nenhuma: perder a última TV não
/// pode entregar a TV do dono. O administrador vê todas.
/// </summary>
internal sealed class TvSelectionService(TvDbContext db, ITvAgentResolver defaultAgent)
{
    private enum MemberScope
    {
        Memberships,
        DefaultTv,
        Nothing,
    }

    public async Task<IReadOnlyList<TvTarget>> ListVisibleAsync(Guid userId, bool isOwner, CancellationToken cancellationToken)
    {
        IQueryable<ConfiguredTv> visible;
        if (isOwner)
        {
            visible = db.Tvs.AsNoTracking();
        }
        else
        {
            var scope = await ScopeOfMemberAsync(userId, cancellationToken);
            if (scope == MemberScope.Nothing)
            {
                return [];
            }

            visible = VisibleFor(scope, userId);
        }

        return await visible.OrderByDescending(t => t.IsDefault).ThenBy(t => t.Name).Select(ToTarget).ToListAsync(cancellationToken);
    }

    public async Task<TvTarget?> ResolveAsync(Guid userId, bool isOwner, Guid? requestedId, CancellationToken cancellationToken)
    {
        IQueryable<ConfiguredTv> visible;
        if (isOwner)
        {
            visible = db.Tvs.AsNoTracking();
        }
        else
        {
            var scope = await ScopeOfMemberAsync(userId, cancellationToken);
            if (scope == MemberScope.Nothing)
            {
                // Retirada da última TV: nem a reserva do agente do ambiente abaixo vale, ela também é a TV do dono.
                return null;
            }

            visible = VisibleFor(scope, userId);
        }

        if (await visible.AnyAsync(cancellationToken))
        {
            var query = visible;
            if (requestedId is { } id)
            {
                return await query.Where(t => t.Id == id).Select(ToTarget).SingleOrDefaultAsync(cancellationToken);
            }

            return await query.OrderByDescending(t => t.IsDefault).ThenBy(t => t.Name).Select(ToTarget).FirstOrDefaultAsync(cancellationToken);
        }

        // Sem linha salva, a instalação antiga ainda pode usar o AgentId do ambiente. Nunca aceita tvId nesse modo: não
        // há uma TV cuja visibilidade possa ser comprovada.
        if (requestedId is not null)
        {
            return null;
        }

        var binding = await defaultAgent.ResolveAsync(cancellationToken);
        // A rota continua alcançável sem agente configurado para responder 503, como no contrato antigo; 404 é reservado
        // para um tvId que a conta não consegue ver.
        return new TvTarget(Guid.Empty, binding.AgentSlug ?? string.Empty, binding.Name, true);
    }

    public Task<ConfiguredTv?> FindByAgentAsync(string agentSlug, CancellationToken cancellationToken) =>
        db.Tvs.SingleOrDefaultAsync(t => t.AgentSlug == agentSlug, cancellationToken);

    /// <summary>
    /// Filiação primeiro (vence a marca, que pode sobrar de antes de a conta voltar a uma TV), depois a marca, depois a
    /// compatibilidade. As duas leituras vão numa só consulta para virem do mesmo instante: separadas, uma conta que entra
    /// ou sai de uma TV bem no meio poderia aparecer, por um instante, como "nunca teve filiação".
    /// </summary>
    private async Task<MemberScope> ScopeOfMemberAsync(Guid userId, CancellationToken cancellationToken)
    {
        var evidence = await db.TvMembers.AsNoTracking().Where(m => m.UserId == userId).Select(m => 1)
            .Concat(db.TvMemberOptOuts.AsNoTracking().Where(o => o.UserId == userId).Select(o => 2))
            .Distinct()
            .ToListAsync(cancellationToken);
        return evidence.Contains(1) ? MemberScope.Memberships
            : evidence.Contains(2) ? MemberScope.Nothing
            : MemberScope.DefaultTv;
    }

    private IQueryable<ConfiguredTv> VisibleFor(MemberScope scope, Guid userId) => scope == MemberScope.Memberships
        ? db.Tvs.AsNoTracking().Where(t => db.TvMembers.Any(m => m.TvId == t.Id && m.UserId == userId))
        : db.Tvs.AsNoTracking().Where(t => t.IsDefault);

    private static readonly System.Linq.Expressions.Expression<Func<ConfiguredTv, TvTarget>> ToTarget =
        tv => new TvTarget(tv.Id, tv.AgentSlug, tv.Name, tv.IsDefault);
}

internal static class TvSelectionEndpointFilter
{
    public static async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var path = context.HttpContext.Request.Path.Value;
        if (path is not null && (path.EndsWith("/info", StringComparison.Ordinal)
            || path.StartsWith("/api/v1/tv/config", StringComparison.Ordinal)
            || path.StartsWith("/api/v1/tv/tvs", StringComparison.Ordinal)
            || path.StartsWith("/api/v1/tv/siri", StringComparison.Ordinal)))
        {
            return await next(context);
        }

        var current = context.HttpContext.RequestServices.GetRequiredService<ITvCurrentSelection>();
        var user = context.HttpContext.RequestServices.GetRequiredService<ICurrentUser>();
        if (user.UserId is not { } userId)
        {
            return TvProblems.Unauthenticated();
        }

        Guid? requestedId = null;
        if (context.HttpContext.Request.Query.TryGetValue("tvId", out var raw))
        {
            if (raw.Count != 1 || !Guid.TryParse(raw[0], out var parsed))
            {
                return Results.NotFound();
            }

            requestedId = parsed;
        }

        var principal = context.HttpContext.User;
        var isOwner = string.Equals(AccountRoles.Of(principal), AccountRoles.Owner, StringComparison.Ordinal);
        var selected = await context.HttpContext.RequestServices.GetRequiredService<TvSelectionService>()
            .ResolveAsync(userId, isOwner, requestedId, context.HttpContext.RequestAborted);
        if (selected is null)
        {
            return Results.NotFound();
        }

        current.Set(selected);
        return await next(context);
    }
}
