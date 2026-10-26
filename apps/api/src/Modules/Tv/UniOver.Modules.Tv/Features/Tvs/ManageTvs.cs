using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

internal sealed record TvSummary(Guid Id, string Name, bool IsDefault, string? AgentSlug, string? Kind, bool Online, IReadOnlyList<string> Capabilities);
internal sealed record TvListResponse(IReadOnlyList<TvSummary> Items);
internal sealed record CreateTvRequest(string? AgentSlug, string? Name);
internal sealed record UpdateTvRequest(string? AgentSlug, string? Name);
internal sealed record TvMembersResponse(IReadOnlyList<Guid> UserIds);
internal sealed record UpdateTvMembersRequest(IReadOnlyList<Guid>? UserIds);

/// <summary>
/// Administração das TVs e das filiações. O tipo vem da capacidade anunciada pelo agente conectado em vez de uma
/// configuração duplicada: <c>tv.kind.android</c> e <c>tv.kind.samsung</c> são declarações que o agente já envia à API.
/// </summary>
internal sealed class ManageTvsHandler(TvDbContext db, IAgentDirectory agents, IAgentPresenceReader presence, TimeProvider time)
{
    public async Task<TvListResponse> ListAsync(IReadOnlyList<TvTarget> visible, bool isOwner, CancellationToken cancellationToken)
    {
        var ids = visible.Select(t => t.Id).ToHashSet();
        var tvs = await db.Tvs.AsNoTracking().Where(t => isOwner || ids.Contains(t.Id)).OrderByDescending(t => t.IsDefault).ThenBy(t => t.Name).ToListAsync(cancellationToken);
        return new TvListResponse([.. tvs.Select(ToSummary).Select(tv => isOwner ? tv : tv with { AgentSlug = null })]);
    }

    public async Task<(TvSummary? Tv, string? Error)> CreateAsync(CreateTvRequest request, Guid userId, CancellationToken cancellationToken)
    {
        var errors = Validate(request.AgentSlug, request.Name, requireAgent: true, out var name);
        if (errors.Count > 0)
        {
            return (null, "invalid");
        }

        var listing = await agents.FindAsync(request.AgentSlug!, cancellationToken);
        if (listing is null || listing.Revoked)
        {
            return (null, "invalid");
        }

        if (await db.Tvs.AnyAsync(t => t.AgentSlug == listing.Slug, cancellationToken))
        {
            return (null, "agent-in-use");
        }

        var tv = ConfiguredTv.Create(name, listing.Slug, isDefault: false, userId, time.GetUtcNow());
        db.Tvs.Add(tv);
        await db.SaveChangesAsync(cancellationToken);
        return (ToSummary(tv), null);
    }

    public async Task<(TvSummary? Tv, string? Error)> UpdateAsync(Guid id, UpdateTvRequest request, Guid userId, CancellationToken cancellationToken)
    {
        var errors = Validate(request.AgentSlug, request.Name, requireAgent: false, out var name);
        if (errors.Count > 0 || (request.AgentSlug is null && name is null))
        {
            return (null, "invalid");
        }

        var tv = await db.Tvs.SingleOrDefaultAsync(t => t.Id == id, cancellationToken);
        if (tv is null)
        {
            return (null, "missing");
        }

        var agentSlug = tv.AgentSlug;
        if (request.AgentSlug is not null)
        {
            var listing = await agents.FindAsync(request.AgentSlug, cancellationToken);
            if (listing is null || listing.Revoked)
            {
                return (null, "invalid");
            }

            if (listing.Slug != tv.AgentSlug && await db.Tvs.AnyAsync(t => t.AgentSlug == listing.Slug, cancellationToken))
            {
                return (null, "agent-in-use");
            }

            agentSlug = listing.Slug;
        }

        tv.Rebind(agentSlug, name, userId, time.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        return (ToSummary(tv), null);
    }

    public async Task<bool?> DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        // Filiações e marcas mudam na mesma transação, sob o bloqueio que serializa quem mexe nelas.
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await TvMembershipLedger.LockAsync(db, cancellationToken);

        var tv = await db.Tvs.SingleOrDefaultAsync(t => t.Id == id, cancellationToken);
        if (tv is null)
        {
            return null;
        }

        if (tv.IsDefault)
        {
            return false;
        }

        var members = await db.TvMembers.Where(m => m.TvId == id).ToListAsync(cancellationToken);
        await db.TvLayouts.Where(layout => layout.TvId == id).ExecuteDeleteAsync(cancellationToken);
        db.TvMembers.RemoveRange(members);
        db.Tvs.Remove(tv);
        await TvMembershipLedger.ReconcileAsync(db, id, [.. members.Select(m => m.UserId)], [], time.GetUtcNow(), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    public async Task<TvMembersResponse?> MembersAsync(Guid id, CancellationToken cancellationToken)
    {
        if (!await db.Tvs.AnyAsync(t => t.Id == id, cancellationToken))
        {
            return null;
        }

        var users = await db.TvMembers.AsNoTracking().Where(m => m.TvId == id).OrderBy(m => m.UserId).Select(m => m.UserId).ToListAsync(cancellationToken);
        return new TvMembersResponse(users);
    }

    public async Task<TvMembersResponse?> ReplaceMembersAsync(Guid id, IReadOnlyList<Guid>? userIds, CancellationToken cancellationToken)
    {
        if (userIds is null || userIds.Count != userIds.Distinct().Count())
        {
            return null;
        }

        // O que sai e o que entra é calculado sobre as filiações lidas já sob o bloqueio, para a marca de "retirada" sair
        // certa mesmo com outra gravação de filiação ao mesmo tempo. Quem continua na TV não é regravado.
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await TvMembershipLedger.LockAsync(db, cancellationToken);

        if (!await db.Tvs.AnyAsync(t => t.Id == id, cancellationToken))
        {
            return null;
        }

        var current = await db.TvMembers.Where(m => m.TvId == id).ToListAsync(cancellationToken);
        var wanted = userIds.ToHashSet();
        var present = current.Select(m => m.UserId).ToHashSet();
        var removed = current.Where(m => !wanted.Contains(m.UserId)).ToList();
        var added = userIds.Where(userId => !present.Contains(userId)).ToList();

        var now = time.GetUtcNow();
        db.TvMembers.RemoveRange(removed);
        db.TvMembers.AddRange(added.Select(userId => TvMember.Create(id, userId, now)));
        await TvMembershipLedger.ReconcileAsync(db, id, [.. removed.Select(m => m.UserId)], added, now, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new TvMembersResponse([.. userIds.Order()]);
    }

    private TvSummary ToSummary(ConfiguredTv tv)
    {
        var info = presence.Get(tv.AgentSlug);
        var capabilities = info?.Capabilities ?? [];
        var kind = capabilities.Contains("tv.kind.android", StringComparer.Ordinal) ? "android"
            : capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) ? "samsung"
            : null;
        return new TvSummary(tv.Id, tv.Name, tv.IsDefault, tv.AgentSlug, kind, info?.Connected == true, capabilities);
    }

    private static Dictionary<string, string[]> Validate(string? agentSlug, string? name, bool requireAgent, out string? normalizedName)
    {
        var errors = BindAgentValidator.ValidateName(name, out normalizedName);
        if ((requireAgent && !BindAgentValidator.IsPlausibleSlug(agentSlug)) || (agentSlug is not null && !BindAgentValidator.IsPlausibleSlug(agentSlug)))
        {
            errors["agentSlug"] = [BindAgentValidator.AgentRefused];
        }

        return errors;
    }
}

internal static class ManageTvsEndpoint
{
    public static void MapTvs(this IEndpointRouteBuilder group)
    {
        group.MapGet("/tvs", ListAsync).RequireAuthorization(TvAuth.Module).Produces<TvListResponse>();
        group.MapPost("/tvs", CreateAsync).RequireAuthorization(StepUp.Policy(TvAuth.BindAgentAction)).Produces<TvSummary>().ProducesProblem(StatusCodes.Status409Conflict);
        group.MapPatch("/tvs/{id:guid}", UpdateAsync).RequireAuthorization(StepUp.Policy(TvAuth.BindAgentAction)).Produces<TvSummary>().ProducesProblem(StatusCodes.Status409Conflict);
        group.MapDelete("/tvs/{id:guid}", DeleteAsync).RequireAuthorization(StepUp.Policy(TvAuth.BindAgentAction)).Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status409Conflict);
        group.MapGet("/tvs/{id:guid}/members", MembersAsync).RequireAuthorization(UniOverAuth.OwnerPolicy).Produces<TvMembersResponse>();
        group.MapPut("/tvs/{id:guid}/members", ReplaceMembersAsync).RequireAuthorization(StepUp.Policy(TvAuth.BindAgentAction)).Produces<TvMembersResponse>();
    }

    private static async Task<IResult> ListAsync(ICurrentUser current, System.Security.Claims.ClaimsPrincipal principal, TvSelectionService selection, ManageTvsHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId) return TvProblems.Unauthenticated();
        var isOwner = string.Equals(AccountRoles.Of(principal), AccountRoles.Owner, StringComparison.Ordinal);
        var visible = await selection.ListVisibleAsync(userId, isOwner, ct);
        return TypedResults.Ok(await handler.ListAsync(visible, isOwner, ct));
    }

    private static async Task<IResult> CreateAsync(CreateTvRequest? request, ICurrentUser current, ManageTvsHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId || request is null) return TvProblems.Unauthenticated();
        var (tv, error) = await handler.CreateAsync(request, userId, ct);
        return Result(tv, error);
    }

    private static async Task<IResult> UpdateAsync(Guid id, UpdateTvRequest? request, ICurrentUser current, ManageTvsHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId || request is null) return TvProblems.Unauthenticated();
        var (tv, error) = await handler.UpdateAsync(id, request, userId, ct);
        return Result(tv, error);
    }

    private static async Task<IResult> DeleteAsync(Guid id, ManageTvsHandler handler, CancellationToken ct)
    {
        var deleted = await handler.DeleteAsync(id, ct);
        return deleted switch
        {
            null => TypedResults.NotFound(),
            false => Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "A TV padrão não pode ser excluída."),
            _ => TypedResults.NoContent(),
        };
    }

    private static async Task<IResult> MembersAsync(Guid id, ManageTvsHandler handler, CancellationToken ct) =>
        await handler.MembersAsync(id, ct) is { } result ? TypedResults.Ok(result) : TypedResults.NotFound();

    private static async Task<IResult> ReplaceMembersAsync(Guid id, UpdateTvMembersRequest? request, ManageTvsHandler handler, CancellationToken ct) =>
        await handler.ReplaceMembersAsync(id, request?.UserIds, ct) is { } result ? TypedResults.Ok(result) : TypedResults.NotFound();

    private static IResult Result(TvSummary? tv, string? error) => error switch
    {
        null => TypedResults.Ok(tv!),
        "agent-in-use" => Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "O agente já controla outra TV."),
        "missing" => TypedResults.NotFound(),
        _ => ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["Dados da TV inválidos."] }),
    };
}
