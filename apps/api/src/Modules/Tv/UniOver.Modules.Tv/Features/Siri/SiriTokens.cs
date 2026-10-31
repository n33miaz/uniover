using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Siri;

/// <param name="Name">Rótulo da chave (ex.: "iPhone do Neemias"), só para o administrador reconhecê-la na lista.</param>
/// <param name="TvId">A TV que a chave controla; uma chave vale para uma TV só.</param>
/// <param name="Actions">As ações permitidas, pelo código (<see cref="SiriActions"/>); só elas valem.</param>
/// <param name="ExpiresInDays">Validade em dias (1 a 365); ausente significa sem prazo.</param>
internal sealed record CreateSiriTokenRequest(string? Name, Guid? TvId, IReadOnlyList<string?>? Actions, int? ExpiresInDays);

internal sealed record SiriTokenSummary(
    Guid Id, string Name, Guid TvId, string TvName, IReadOnlyList<string> Actions, DateTimeOffset CreatedAt,
    DateTimeOffset? ExpiresAt, DateTimeOffset? LastUsedAt);

internal sealed record SiriTokenListResponse(IReadOnlyList<SiriTokenSummary> Items);

/// <summary>A chave recém-criada: <see cref="Token"/> é o único momento em que o texto claro existe.</summary>
internal sealed record CreatedSiriToken(
    Guid Id, string Name, Guid TvId, IReadOnlyList<string> Actions, DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt, string Token);

internal enum CreateSiriTokenFailure
{
    Invalid,
    TvNotFound,
    TooMany,
}

internal sealed class SiriTokensHandler(TvDbContext db, ITvCommandAudit audit, TimeProvider time)
{
    public async Task<SiriTokenListResponse> ListAsync(Guid userId, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var rows = await db.SiriTokens.AsNoTracking()
            .Where(t => t.UserId == userId && t.RevokedAt == null && (t.ExpiresAt == null || t.ExpiresAt > now))
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(cancellationToken);

        var tvIds = rows.Select(t => t.TvId).Distinct().ToList();
        var names = await db.Tvs.AsNoTracking().Where(t => tvIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, cancellationToken);
        return new SiriTokenListResponse([.. rows.Select(t => new SiriTokenSummary(
            t.Id, t.Name, t.TvId, names.GetValueOrDefault(t.TvId, string.Empty), t.Actions, t.CreatedAt, t.ExpiresAt, t.LastUsedAt))]);
    }

    /// <summary>
    /// Cria a chave. A lista de ações é normalizada (sem repetição, só códigos do catálogo) e os apps têm de ser atalhos
    /// INSTALADOS da própria TV. Devolve o texto claro uma única vez; no banco vai só o hash.
    /// </summary>
    public async Task<(CreatedSiriToken? Created, CreateSiriTokenFailure? Failure)> CreateAsync(
        CreateSiriTokenRequest request, TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(origin);

        var name = LabelText.Normalize(request.Name);
        if (!name.IsValid || name.Value.Length is 0 or > SiriToken.NameMax)
        {
            return (null, CreateSiriTokenFailure.Invalid);
        }

        if (request.ExpiresInDays is { } days && (days < 1 || days > SiriToken.MaxExpiryDays))
        {
            return (null, CreateSiriTokenFailure.Invalid);
        }

        var actions = Normalize(request.Actions);
        if (actions is null || request.TvId is not { } tvId || tvId == Guid.Empty)
        {
            return (null, CreateSiriTokenFailure.Invalid);
        }

        var tv = await db.Tvs.AsNoTracking().SingleOrDefaultAsync(t => t.Id == tvId, cancellationToken);
        if (tv is null)
        {
            return (null, CreateSiriTokenFailure.TvNotFound);
        }

        var appIds = actions.Select(SiriActions.AppIdOf).OfType<Guid>().ToList();
        if (appIds.Count > 0)
        {
            var installed = await db.Shortcuts.AsNoTracking()
                .Where(s => s.TvId == tvId && s.Installed && appIds.Contains(s.Id))
                .CountAsync(cancellationToken);
            if (installed != appIds.Count)
            {
                return (null, CreateSiriTokenFailure.Invalid);
            }
        }

        var now = time.GetUtcNow();
        var active = await db.SiriTokens.CountAsync(
            t => t.UserId == origin.UserId && t.RevokedAt == null && (t.ExpiresAt == null || t.ExpiresAt > now), cancellationToken);
        if (active >= SiriToken.MaxActivePerUser)
        {
            return (null, CreateSiriTokenFailure.TooMany);
        }

        var (secret, hash) = SiriSecrets.New();
        var token = SiriToken.Create(
            origin.UserId, tvId, name.Value, hash, actions, now, request.ExpiresInDays is { } d ? now.AddDays(d) : null);
        db.SiriTokens.Add(token);

        // A chave e a linha da trilha saem no mesmo SaveChanges (o audit usa este mesmo contexto): não há chave sem rastro.
        await audit.RecordAsync(
            CommandAuditEntry.Create(
                origin.UserId, tv.AgentSlug, TvCommandNames.SiriTokenCreate, token.Name, ok: true, errorCode: null, latencyMs: null,
                origin.Client, now, tvId),
            cancellationToken);

        return (new CreatedSiriToken(token.Id, token.Name, tvId, token.Actions, token.CreatedAt, token.ExpiresAt, secret), null);
    }

    /// <summary>Revoga uma chave da própria conta; falso se ela não existe (ou é de outra conta). Revogar de novo é inofensivo.</summary>
    public async Task<bool> RevokeAsync(Guid id, TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(origin);

        var token = await db.SiriTokens.SingleOrDefaultAsync(t => t.Id == id && t.UserId == origin.UserId, cancellationToken);
        if (token is null)
        {
            return false;
        }

        var now = time.GetUtcNow();
        var firstTime = token.RevokedAt is null;
        token.Revoke(now);
        if (!firstTime)
        {
            return true;
        }

        // A revogação e a linha da trilha também saem juntas.
        await audit.RecordAsync(
            CommandAuditEntry.Create(
                origin.UserId, null, TvCommandNames.SiriTokenRevoke, token.Name, ok: true, errorCode: null, latencyMs: null,
                origin.Client, now, token.TvId),
            cancellationToken);
        return true;
    }

    /// <summary>Códigos únicos e bem formados, no máximo <see cref="SiriToken.MaxActions"/>; nulo se algum for inválido ou se a lista for vazia.</summary>
    private static List<string>? Normalize(IReadOnlyList<string?>? requested)
    {
        if (requested is null or { Count: 0 or > SiriToken.MaxActions * 2 })
        {
            return null;
        }

        var result = new List<string>();
        foreach (var raw in requested)
        {
            var code = raw?.Trim();
            if (string.IsNullOrEmpty(code) || !SiriActions.IsWellFormed(code))
            {
                return null;
            }

            // O id do app volta ao formato canônico, para "mesmo app" não virar dois códigos.
            if (SiriActions.AppIdOf(code) is { } appId)
            {
                code = SiriActions.AppCode(appId);
            }

            if (!result.Contains(code, StringComparer.Ordinal))
            {
                result.Add(code);
            }
        }

        return result.Count <= SiriToken.MaxActions ? result : null;
    }
}

internal static class SiriTokensEndpoint
{
    public static void MapSiriTokens(this IEndpointRouteBuilder group)
    {
        group.MapGet("/siri/tokens", ListAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<SiriTokenListResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        // Criar uma chave entrega poder de comando a quem a tiver: pede a passkey, como criar uma TV ou um convite.
        group.MapPost("/siri/tokens", CreateAsync).RequireAuthorization(StepUp.Policy(TvAuth.SiriTokenAction))
            .Produces<CreatedSiriToken>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapDelete("/siri/tokens/{id:guid}", RevokeAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound);
    }

    private static async Task<IResult> ListAsync(ICurrentUser current, SiriTokensHandler handler, CancellationToken cancellationToken) =>
        current.UserId is { } userId
            ? TypedResults.Ok(await handler.ListAsync(userId, cancellationToken))
            : TvProblems.Unauthenticated();

    private static async Task<IResult> CreateAsync(
        CreateSiriTokenRequest? request, ICurrentUser current, HttpContext http, SiriTokensHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var invalid = ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
        {
            ["body"] = ["Informe um nome, a TV e ao menos uma ação válida."],
        });
        if (request is null)
        {
            return invalid;
        }

        var (created, failure) = await handler.CreateAsync(request, origin, cancellationToken);
        return failure switch
        {
            null => TypedResults.Created($"/api/v1/tv/siri/tokens/{created!.Id}", created),
            CreateSiriTokenFailure.TvNotFound => TypedResults.NotFound(),
            CreateSiriTokenFailure.TooMany => Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: $"Já existem {SiriToken.MaxActivePerUser} chaves ativas. Revogue uma antes de criar outra.",
                type: ProblemDetailsExtensions.TypeBase + "siri-too-many-tokens"),
            _ => invalid,
        };
    }

    private static async Task<IResult> RevokeAsync(
        Guid id, ICurrentUser current, HttpContext http, SiriTokensHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        return await handler.RevokeAsync(id, origin, cancellationToken) ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
