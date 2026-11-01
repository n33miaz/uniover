using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Preferences;

/// <summary>Uma linha da Início no corpo: o id do módulo e se ele aparece.</summary>
internal sealed record HomeEntryDto(string? Id, bool Enabled);

/// <param name="Version">Zero enquanto a conta nunca gravou; sobe um a cada gravação.</param>
/// <param name="UpdatedAt">Quando a última gravação aconteceu; nulo se nunca houve.</param>
/// <param name="Home">Os módulos na ordem escolhida; nulo quando a conta usa a Início padrão.</param>
internal sealed record AccountPreferencesResponse(int Version, DateTimeOffset? UpdatedAt, IReadOnlyList<HomeEntryDto>? Home);

/// <param name="BaseVersion">A versão que o aparelho tinha lido; sem ela não há como saber se algo mais novo seria apagado.</param>
/// <param name="Home">A Início completa (substitui a anterior); nulo volta ao padrão.</param>
internal sealed record SavePreferencesRequest(int? BaseVersion, IReadOnlyList<HomeEntryDto>? Home);

internal sealed record SavePreferencesResult(bool Saved, AccountPreferencesResponse Current);

/// <summary>
/// As preferências da própria conta: o que a pessoa personalizou vale em qualquer aparelho. Ninguém lê nem grava as de
/// outra conta por esta rota (o id vem sempre do token); quem vê um resumo das dos outros é o dono, em Pessoas.
/// </summary>
internal sealed class PreferencesHandler(IdentityDbContext db, TimeProvider time)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<AccountPreferencesResponse> GetAsync(Guid userId, CancellationToken cancellationToken)
    {
        var row = await db.AccountPreferences.AsNoTracking().SingleOrDefaultAsync(p => p.UserId == userId, cancellationToken);
        return ToResponse(row);
    }

    /// <summary>
    /// Grava se, e só se, a versão do banco ainda é a que o aparelho leu (o mais novo vence, mas ninguém apaga o que
    /// não viu). Devolve a gravação nova ou, na recusa, a conta como está para o aparelho adotá-la.
    /// </summary>
    public async Task<SavePreferencesResult> SaveAsync(
        Guid userId, int baseVersion, IReadOnlyList<HomeEntryDto>? home, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var homeJson = home is null ? null : JsonSerializer.Serialize(home.Select(e => new HomeEntry(e.Id!, e.Enabled)), Json);

        if (baseVersion == 0)
        {
            // Primeira gravação: a chave da conta garante UM vencedor quando dois aparelhos gravam juntos.
            db.AccountPreferences.Add(AccountPreferences.Create(userId, homeJson, now));
            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                db.ChangeTracker.Clear();
                return new SavePreferencesResult(false, await GetAsync(userId, cancellationToken));
            }

            return new SavePreferencesResult(true, await GetAsync(userId, cancellationToken));
        }

        // O UPDATE condicional é o que decide o vencedor: só quem encontra a versão que leu consegue gravar.
        var changed = await db.AccountPreferences
            .Where(p => p.UserId == userId && p.Version == baseVersion)
            .ExecuteUpdateAsync(
                s => s.SetProperty(p => p.HomeJson, homeJson)
                    .SetProperty(p => p.Version, p => p.Version + 1)
                    .SetProperty(p => p.UpdatedAt, now),
                cancellationToken);
        return new SavePreferencesResult(changed == 1, await GetAsync(userId, cancellationToken));
    }

    /// <summary>A lista como a conta guarda; um JSON que não lê vale como padrão em vez de derrubar a leitura.</summary>
    internal static IReadOnlyList<HomeEntry>? ReadHome(string? homeJson)
    {
        if (string.IsNullOrWhiteSpace(homeJson))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<List<HomeEntry>>(homeJson, Json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static AccountPreferencesResponse ToResponse(AccountPreferences? row) =>
        row is null
            ? new AccountPreferencesResponse(0, null, null)
            : new AccountPreferencesResponse(
                row.Version, row.UpdatedAt, ReadHome(row.HomeJson)?.Select(e => new HomeEntryDto(e.Id, e.Enabled)).ToList());
}

internal static class PreferencesEndpoint
{
    public static void MapPreferences(this IEndpointRouteBuilder group)
    {
        group.MapGet("/me/preferences", GetAsync)
            .RequireAuthorization(IdentityAuth.AccountSessionPolicy)
            .Produces<AccountPreferencesResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
        group.MapPut("/me/preferences", PutAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Profile)
            .Produces<AccountPreferencesResponse>()
            .Produces<AccountPreferencesResponse>(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static async Task<IResult> GetAsync(ICurrentUser current, PreferencesHandler handler, CancellationToken ct) =>
        current.UserId is { } userId
            ? TypedResults.Ok(await handler.GetAsync(userId, ct))
            : IdentityProblems.Unauthenticated();

    private static async Task<IResult> PutAsync(
        ICurrentUser current, SavePreferencesRequest? request, PreferencesHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        if (request is not { BaseVersion: >= 0 and var baseVersion })
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["baseVersion"] = ["Informe a versão em que a alteração se baseou (zero se nunca gravou)."],
            });
        }

        var error = HomePreferenceRules.Validate(request.Home?.Select(e => e is null ? null : new HomeEntry(e.Id ?? string.Empty, e.Enabled)).ToList());
        if (error is not null)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]> { ["home"] = [error] });
        }

        var result = await handler.SaveAsync(userId, baseVersion, request.Home, ct);

        // 409 leva a conta como está, para o aparelho adotá-la sem outra ida ao servidor.
        return result.Saved ? TypedResults.Ok(result.Current) : TypedResults.Json(result.Current, statusCode: StatusCodes.Status409Conflict);
    }
}
