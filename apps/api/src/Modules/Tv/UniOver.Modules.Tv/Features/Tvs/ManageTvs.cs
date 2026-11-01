using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Tvs;

internal sealed record TvSummary(
    Guid Id, string Name, bool IsDefault, string? AgentSlug, string? Kind, bool Online, IReadOnlyList<string> Capabilities,
    bool AllowBackgroundAppClosing = false, bool FocusModeEnabled = false, bool ShortAnimationsEnabled = false,
    IReadOnlyList<string>? RestrictedBackgroundPackages = null, bool FocusClosesBackground = false,
    bool PermissionNeeded = false, bool AutoMaintenanceEnabled = true);
internal sealed record TvListResponse(IReadOnlyList<TvSummary> Items);
internal sealed record CreateTvRequest(string? AgentSlug, string? Name);
internal sealed record UpdateTvRequest(string? AgentSlug, string? Name, bool? AllowBackgroundAppClosing = null,
    bool? FocusModeEnabled = null, bool? ShortAnimationsEnabled = null, IReadOnlyList<string?>? RestrictedBackgroundPackages = null,
    bool? FocusClosesBackground = null, bool? AutoMaintenanceEnabled = null);
internal sealed record TvMembersResponse(IReadOnlyList<Guid> UserIds);
internal sealed record UpdateTvMembersRequest(IReadOnlyList<Guid>? UserIds);

/// <summary>Uma limpeza como o administrador a vê em Sistema: o que fez, o que pulou e por quê (<c>Reason</c> é um código).</summary>
internal sealed record TvCleanupReportItem(
    string Kind, string Trigger, DateTimeOffset StartedAt, int DurationMs, int? MemoryBeforeMb, int? MemoryAfterMb,
    int ClosedApps, IReadOnlyList<string> ClosedPackages, int? BackgroundProcesses, int? SessionOpenMs, string Result,
    string? Reason);

internal sealed record TvCleanupReportsResponse(IReadOnlyList<TvCleanupReportItem> Items);
internal sealed record TvAppOption(string Package, string Label);
internal sealed record TvAppsResponse(IReadOnlyList<TvAppOption> Items);

/// <summary>
/// Administração das TVs e das filiações. O tipo vem da capacidade anunciada pelo agente conectado em vez de uma
/// configuração duplicada: <c>tv.kind.android</c> e <c>tv.kind.samsung</c> são declarações que o agente já envia à API.
/// </summary>
internal sealed class ManageTvsHandler(
    TvDbContext db, IAgentDirectory agents, IAgentPresenceReader presence, TimeProvider time, ITvCommandAudit audit,
    ITvCleanupSettingsPublisher cleanupPublisher)
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

    public async Task<(TvSummary? Tv, string? Error)> UpdateAsync(Guid id, UpdateTvRequest request, TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        var userId = origin.UserId;
        var errors = Validate(request.AgentSlug, request.Name, requireAgent: false, out var name);
        if (!ConfiguredTv.IsValidRestrictedPackages(request.RestrictedBackgroundPackages))
        {
            return (null, "invalid-packages");
        }

        if (errors.Count > 0 || (request.AgentSlug is null && name is null && request.AllowBackgroundAppClosing is null
            && request.FocusModeEnabled is null && request.ShortAnimationsEnabled is null && request.RestrictedBackgroundPackages is null
            && request.FocusClosesBackground is null && request.AutoMaintenanceEnabled is null))
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

        // Samsung (Tizen) não tem esses ajustes: ligar algum é recusado de forma explícita; desligar é sempre aceito.
        if (WantsLightSettings(request) && presence.Get(agentSlug)?.Capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) == true)
        {
            return (null, "unsupported");
        }

        // Agente presente que não entende o fechamento no Modo Foco: ligar a opção seria um interruptor que não faz nada.
        if (IsFocusClosesUnsupported(request, presence.Get(agentSlug)))
        {
            return (null, "unsupported");
        }

        var now = time.GetUtcNow();
        var previousSlug = tv.AgentSlug;
        tv.Rebind(agentSlug, name, userId, now);
        var agentChanged = !string.Equals(previousSlug, agentSlug, StringComparison.Ordinal);
        var closingChanged = request.AllowBackgroundAppClosing is { } allow && tv.SetBackgroundAppClosing(allow, userId, now);
        var maintenanceChanged = request.AutoMaintenanceEnabled is { } maintenance
            && tv.SetAutoMaintenance(maintenance, userId, now);
        var lightChanged = tv.SetLightSettings(request.FocusModeEnabled, request.ShortAnimationsEnabled,
            request.RestrictedBackgroundPackages?.OfType<string>().ToArray(), userId, now, request.FocusClosesBackground);
        if (closingChanged || lightChanged || maintenanceChanged)
        {
            // O EfCommandAudit usa este mesmo TvDbContext: um SaveChanges grava a TV e a trilha juntas.
            await audit.RecordAsync(
                CommandAuditEntry.Create(
                    userId, tv.AgentSlug, TvCommandNames.CleanupSetting,
                    // A trilha guarda só o que mudou, nunca a lista de pacotes: o texto é curto e estável.
                    (closingChanged, lightChanged, maintenanceChanged) switch
                    {
                        (false, false, true) => tv.AutoMaintenanceEnabled ? "auto-maintenance=on" : "auto-maintenance=off",
                        (true, false, false) => tv.AllowBackgroundAppClosing ? "background-app-closing=on" : "background-app-closing=off",
                        (true, true, false) => "background-app-closing+light-settings",
                        (false, true, false) => "light-settings",
                        _ => "cleanup-settings",
                    },
                    ok: true, errorCode: null, latencyMs: null, origin.Client, now, tv.Id),
                cancellationToken);
        }
        else
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        if (agentChanged)
        {
            // O computador antigo para o que tinha agendado nesta TV; o novo recebe as preferências dela.
            await PublishUnboundAsync(previousSlug, cancellationToken);
        }

        if (closingChanged || lightChanged || maintenanceChanged || agentChanged)
        {
            await PublishCleanupSettingsAsync(tv.AgentSlug, cancellationToken);
        }

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
        await PublishUnboundAsync(tv.AgentSlug, cancellationToken);
        return true;
    }

    /// <summary>As últimas limpezas desta TV, da mais nova para a mais antiga; <c>null</c> se a TV não existe.</summary>
    public async Task<TvCleanupReportsResponse?> CleanupReportsAsync(Guid id, CancellationToken cancellationToken)
    {
        if (!await db.Tvs.AnyAsync(t => t.Id == id, cancellationToken))
        {
            return null;
        }

        var rows = await db.CleanupReports.AsNoTracking().Where(r => r.TvId == id)
            .OrderByDescending(r => r.StartedAt).Take(CleanupReportsShown).ToListAsync(cancellationToken);
        return new TvCleanupReportsResponse([.. rows.Select(r => new TvCleanupReportItem(
            r.Kind, r.Trigger, r.StartedAt, r.DurationMs, r.MemoryBeforeMb, r.MemoryAfterMb, r.ClosedApps,
            PackagesOf(r.AppsClosed), r.BackgroundProcesses, r.SessionOpenMs, r.Result, r.Reason))]);
    }

    /// <summary>
    /// Só o <c>true</c> é recusado, e só quando o agente já se apresentou sem a capacidade. Agente que nunca se conectou desde
    /// que a API subiu não é conhecido: a preferência fica guardada e só chega a quem a anunciar.
    /// </summary>
    internal static bool IsFocusClosesUnsupported(UpdateTvRequest request, AgentPresenceInfo? info) =>
        request.FocusClosesBackground == true && info is not null
        && !info.Capabilities.Contains(Cleanup.CleanupSettingsPublisher.FocusClosesBackgroundCapability, StringComparer.Ordinal);

    private static bool WantsLightSettings(UpdateTvRequest request) =>
        request.FocusModeEnabled == true || request.ShortAnimationsEnabled == true || request.RestrictedBackgroundPackages is { Count: > 0 }
        || request.FocusClosesBackground == true;

    public async Task<TvAppsResponse?> AppsAsync(Guid id, CancellationToken cancellationToken)
    {
        if (!await db.Tvs.AnyAsync(t => t.Id == id, cancellationToken)) return null;
        var apps = await db.Shortcuts.AsNoTracking().Where(s => s.TvId == id && s.Installed)
            .OrderBy(s => s.CustomLabel ?? s.TvLabel ?? s.Package)
            .Select(s => new TvAppOption(s.Package, s.CustomLabel ?? s.TvLabel ?? s.Package)).ToListAsync(cancellationToken);
        // A lista de bloqueio é a mesma que SetLightSettings aplica: o que não pode ser restringido nem é oferecido.
        return new TvAppsResponse([.. apps.Where(a => ConfiguredTv.CanRestrictInBackground(a.Package))]);
    }

    private const int CleanupReportsShown = 10;

    private static string[] PackagesOf(string json)
    {
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<string[]>(json) ?? [];
        }
        catch (System.Text.Json.JsonException)
        {
            return [];
        }
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

    /// <summary>A mudança já está gravada; se o agente não receber agora, recebe ao conectar de novo.</summary>
    private async Task PublishCleanupSettingsAsync(string agentSlug, CancellationToken cancellationToken)
    {
        try
        {
            await cleanupPublisher.PublishAsync(agentSlug, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Entrega é melhor esforço: o administrador não deve ver erro numa preferência que ficou salva.
        }
    }

    /// <summary>Mesma regra de <see cref="PublishCleanupSettingsAsync"/>: a mudança já está gravada e a entrega é melhor esforço.</summary>
    private async Task PublishUnboundAsync(string agentSlug, CancellationToken cancellationToken)
    {
        try
        {
            await cleanupPublisher.PublishUnboundAsync(agentSlug, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
        }
    }

    private TvSummary ToSummary(ConfiguredTv tv)
    {
        var info = presence.Get(tv.AgentSlug);
        var capabilities = info?.Capabilities ?? [];
        var kind = capabilities.Contains("tv.kind.android", StringComparer.Ordinal) ? "android"
            : capabilities.Contains("tv.kind.samsung", StringComparer.Ordinal) ? "samsung"
            : null;
        return new TvSummary(tv.Id, tv.Name, tv.IsDefault, tv.AgentSlug, kind, info?.Connected == true, capabilities,
            tv.AllowBackgroundAppClosing, tv.FocusModeEnabled, tv.ShortAnimationsEnabled, tv.BackgroundPackages(), tv.FocusClosesBackground,
            tv.PermissionNeeded, tv.AutoMaintenanceEnabled);
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
        group.MapGet("/tvs/{id:guid}/cleanup-reports", CleanupReportsAsync).RequireAuthorization(UniOverAuth.OwnerPolicy).Produces<TvCleanupReportsResponse>();
        group.MapGet("/tvs/{id:guid}/apps", AppsAsync).RequireAuthorization(UniOverAuth.OwnerPolicy).Produces<TvAppsResponse>();
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

    private static async Task<IResult> UpdateAsync(Guid id, UpdateTvRequest? request, ICurrentUser current, HttpContext http, ManageTvsHandler handler, CancellationToken ct)
    {
        if (request is null || TvHttp.OriginOf(current, http) is not { } origin) return TvProblems.Unauthenticated();
        var (tv, error) = await handler.UpdateAsync(id, request, origin, ct);
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

    private static async Task<IResult> CleanupReportsAsync(Guid id, ManageTvsHandler handler, CancellationToken ct) =>
        await handler.CleanupReportsAsync(id, ct) is { } result ? TypedResults.Ok(result) : TypedResults.NotFound();

    private static async Task<IResult> AppsAsync(Guid id, ManageTvsHandler handler, CancellationToken ct) =>
        await handler.AppsAsync(id, ct) is { } result ? TypedResults.Ok(result) : TypedResults.NotFound();

    private static async Task<IResult> ReplaceMembersAsync(Guid id, UpdateTvMembersRequest? request, ManageTvsHandler handler, CancellationToken ct) =>
        await handler.ReplaceMembersAsync(id, request?.UserIds, ct) is { } result ? TypedResults.Ok(result) : TypedResults.NotFound();

    private static IResult Result(TvSummary? tv, string? error) => error switch
    {
        null => TypedResults.Ok(tv!),
        "agent-in-use" => Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "O agente já controla outra TV."),
        "missing" => TypedResults.NotFound(),
        // Tipo próprio: a tela não pode confundir esta recusa com o 409 de "computador já em uso".
        "unsupported" => Results.Problem(
            statusCode: StatusCodes.Status409Conflict, title: "Esta TV não suporta esses ajustes.",
            type: ProblemDetailsExtensions.TypeBase + "tv-light-settings-unsupported"),
        "invalid-packages" => ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
        {
            ["restrictedBackgroundPackages"] = ["Escolha até 100 apps válidos, sem repetir e sem apps do sistema, do lançador, do teclado ou do controle remoto."],
        }),
        _ => ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["Dados da TV inválidos."] }),
    };
}
