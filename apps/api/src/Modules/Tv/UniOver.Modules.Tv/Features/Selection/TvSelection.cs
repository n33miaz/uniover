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
/// A ausência completa de filiação preserva as contas antigas na TV padrão; basta uma filiação existir para a conta sair
/// desse modo de compatibilidade.
/// </summary>
internal sealed class TvSelectionService(TvDbContext db, ITvAgentResolver defaultAgent)
{
    public async Task<IReadOnlyList<TvTarget>> ListVisibleAsync(Guid userId, bool isOwner, CancellationToken cancellationToken)
    {
        IQueryable<ConfiguredTv> visible = isOwner
            ? db.Tvs.AsNoTracking()
            : await VisibleForMemberAsync(userId, cancellationToken);
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
            visible = await VisibleForMemberAsync(userId, cancellationToken);
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

    private async Task<IQueryable<ConfiguredTv>> VisibleForMemberAsync(Guid userId, CancellationToken cancellationToken)
    {
        var hasMembership = await db.TvMembers.AsNoTracking().AnyAsync(m => m.UserId == userId, cancellationToken);
        return hasMembership
            ? db.Tvs.AsNoTracking().Where(t => db.TvMembers.Any(m => m.TvId == t.Id && m.UserId == userId))
            : db.Tvs.AsNoTracking().Where(t => t.IsDefault);
    }

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
            || path.StartsWith("/api/v1/tv/tvs", StringComparison.Ordinal)))
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
