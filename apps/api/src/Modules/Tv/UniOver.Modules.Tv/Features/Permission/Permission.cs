using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Permission;

/// <summary>Uma TV que ainda precisa do aceite de alguém na tela dela (o aviso "Permitir" do UniOver).</summary>
internal sealed record PermissionPending(Guid TvId, string Name);

internal sealed record PermissionPendingResponse(IReadOnlyList<PermissionPending> Items);

/// <summary>Como terminou o pedido: o agente é antigo demais para entendê-lo, ou o resultado da entrega.</summary>
internal sealed record PermissionRequestResult(bool Unsupported, TvSendOutcome? Outcome);

/// <summary>
/// A permissão do UniOver na TV Samsung. O agente avisa quando a TV deixa de reconhecê-lo e para de tentar (sem pedir de
/// novo em silêncio); aqui a conta de quem usa a TV descobre isso antes de qualquer tela e pode pedir o aviso outra vez,
/// uma só, quando alguém estiver na frente da TV. Só quem vê a TV vê o estado dela (vale a regra de visibilidade das TVs).
/// </summary>
internal sealed class PermissionHandler(
    TvDbContext db, TvSelectionService selection, TvCommandRunner runner, IAgentPresenceReader presence)
{
    /// <summary>
    /// O agente confirma o pedido logo (ele só olha se a TV responde) e o aceite na TV vem depois, por <c>tv.permission.v1</c>:
    /// a espera aqui é a de um comando comum, nunca o minuto que o aviso fica na tela.
    /// </summary>
    public static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(12);

    /// <summary>
    /// As TVs da conta que precisam do aceite. O administrador vê todas as TVs, mas o aviso é de quem as usa: para ele só
    /// entram a TV padrão e as que ele mesmo usa (filiado); as das outras contas ele resolve em Sistema, na TV.
    /// </summary>
    public async Task<PermissionPendingResponse> PendingAsync(Guid userId, bool isOwner, CancellationToken cancellationToken)
    {
        var visible = await selection.ListVisibleAsync(userId, isOwner, cancellationToken);
        var ids = visible.Select(tv => tv.Id).ToArray();
        var query = db.Tvs.AsNoTracking().Where(tv => ids.Contains(tv.Id) && tv.PermissionNeeded);
        if (isOwner)
        {
            query = query.Where(tv => tv.IsDefault || db.TvMembers.Any(member => member.TvId == tv.Id && member.UserId == userId));
        }

        var items = await query.OrderBy(tv => tv.Name).Select(tv => new PermissionPending(tv.Id, tv.Name)).ToListAsync(cancellationToken);
        return new PermissionPendingResponse(items);
    }

    /// <summary>
    /// Pede o aviso na TV escolhida (a que a requisição já resolveu pela regra de visibilidade). Agente que se apresentou
    /// sem a capacidade não recebe nada: a tela explica que o computador precisa atualizar. Agente que nunca se apresentou
    /// segue para o comando, que responde "fora do ar" como em qualquer outro.
    /// </summary>
    public async Task<PermissionRequestResult> RequestAsync(TvCommandOrigin origin, TvTarget tv, CancellationToken cancellationToken)
    {
        if (presence.Get(tv.AgentSlug) is { } info && !info.Capabilities.Contains(TvCapabilities.PermissionV1, StringComparer.Ordinal))
        {
            return new PermissionRequestResult(true, null);
        }

        var outcome = await runner.RunAsync(
            origin, TvCommandNames.PermissionRequest, null, TvMessages.PermissionRequest(), waitForReply: true, cancellationToken, ReplyTimeout);
        return new PermissionRequestResult(false, outcome);
    }
}

internal static class PermissionEndpoint
{
    public const string UnsupportedType = "permission-unsupported";

    public static void MapPermission(this IEndpointRouteBuilder group)
    {
        group.MapGet("/permission", PendingAsync).RequireAuthorization(TvAuth.Module)
            .Produces<PermissionPendingResponse>().ProducesProblem(StatusCodes.Status401Unauthorized);
        group.MapPost("/permission/request", RequestAsync).RequireAuthorization(TvAuth.Control)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);
    }

    private static async Task<IResult> PendingAsync(
        ICurrentUser current, ClaimsPrincipal principal, PermissionHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return TvProblems.Unauthenticated();
        }

        var isOwner = string.Equals(AccountRoles.Of(principal), AccountRoles.Owner, StringComparison.Ordinal);
        return TypedResults.Ok(await handler.PendingAsync(userId, isOwner, cancellationToken));
    }

    private static async Task<IResult> RequestAsync(
        ICurrentUser current, HttpContext http, ITvCurrentSelection selection, PermissionHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        // Só uma TV salva tem estado de permissão; a reserva por variável de ambiente (sem linha) não tem.
        if (!selection.Current.IsPersisted)
        {
            return TypedResults.NotFound();
        }

        var result = await handler.RequestAsync(origin, selection.Current, cancellationToken);
        if (result.Unsupported)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "O computador da TV precisa ser atualizado para pedir a permissão.",
                type: ProblemDetailsExtensions.TypeBase + UnsupportedType);
        }

        return TvProblems.ToResult(result.Outcome!);
    }
}
