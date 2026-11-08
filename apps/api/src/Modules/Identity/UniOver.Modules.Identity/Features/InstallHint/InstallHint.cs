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

namespace UniOver.Modules.Identity.Features.InstallHint;

/// <param name="Scopes">A resposta por app (raiz, tv, treino). Funde com a que a conta já tem: nada que já valia se desfaz.</param>
internal sealed record SaveInstallHintRequest(Dictionary<string, InstallHintScope?>? Scopes);

/// <summary>
/// A resposta da própria conta à dica "adicionar à tela de início". Fica numa tabela só dela (não em
/// <c>account_preferences</c>): a Início usa versão e conflito, e uma resposta da dica gravada na mesma linha poderia
/// fazer a primeira gravação da Início conflitar e apagar a personalização do aparelho. O id vem sempre do token.
/// </summary>
internal sealed class InstallHintHandler(IdentityDbContext db, TimeProvider time)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Quantas vezes refazer a fusão se a criação da linha perder a corrida para outra gravação.</summary>
    private const int Attempts = 3;

    public async Task<IReadOnlyDictionary<string, InstallHintScope>> GetAsync(Guid userId, CancellationToken cancellationToken)
    {
        var json = await db.InstallHintAnswers.AsNoTracking()
            .Where(a => a.UserId == userId)
            .Select(a => a.AnswersJson)
            .SingleOrDefaultAsync(cancellationToken);
        return Read(json) ?? new Dictionary<string, InstallHintScope>();
    }

    /// <summary>
    /// Funde a resposta com a da conta (ver <see cref="InstallHintRules.Merge"/>) e devolve o resultado. Serializada por
    /// conta e, mesmo assim, tolerante à criação concorrente da linha (violação de chave única): refaz a fusão em vez de
    /// falhar. Nulo se a fusão passaria do limite de apps.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, InstallHintScope>?> MergeAsync(
        Guid userId, IReadOnlyDictionary<string, InstallHintScope?> incoming, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            await db.Database.ExecuteSqlAsync(
                $"SELECT pg_advisory_xact_lock(hashtextextended({"install-hint:" + userId.ToString("N")}, 0))", cancellationToken);

            var now = time.GetUtcNow();
            var row = await db.InstallHintAnswers.SingleOrDefaultAsync(a => a.UserId == userId, cancellationToken);
            var merged = InstallHintRules.Merge(Read(row?.AnswersJson), incoming, now);
            if (merged.Count > InstallHintRules.MaxScopes)
            {
                return null;
            }

            var json = JsonSerializer.Serialize(merged, Json);
            if (row is null)
            {
                db.InstallHintAnswers.Add(InstallHintAnswers.Create(userId, json, now));
            }
            else
            {
                row.Replace(json, now);
            }

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return merged;
            }
            catch (DbUpdateException ex) when (attempt < Attempts && ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>A resposta como a conta guarda; um JSON que não lê vale como "nunca respondeu".</summary>
    internal static IReadOnlyDictionary<string, InstallHintScope>? Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, InstallHintScope>>(json, Json);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

internal static class InstallHintEndpoint
{
    public static void MapInstallHint(this IEndpointRouteBuilder group)
    {
        group.MapGet("/me/install-hint", GetAsync)
            .RequireAuthorization(IdentityAuth.AccountSessionPolicy)
            .Produces<IReadOnlyDictionary<string, InstallHintScope>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
        group.MapPut("/me/install-hint", PutAsync)
            .RequireAuthorization(IdentityAuth.ActiveAccountSessionPolicy)
            .RequireRateLimiting(RateLimitPolicies.Profile)
            .Produces<IReadOnlyDictionary<string, InstallHintScope>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static async Task<IResult> GetAsync(ICurrentUser current, InstallHintHandler handler, CancellationToken ct) =>
        current.UserId is { } userId
            ? TypedResults.Ok(await handler.GetAsync(userId, ct))
            : IdentityProblems.Unauthenticated();

    private static async Task<IResult> PutAsync(
        ICurrentUser current, SaveInstallHintRequest? request, InstallHintHandler handler, CancellationToken ct)
    {
        if (current.UserId is not { } userId)
        {
            return IdentityProblems.Unauthenticated();
        }

        var incoming = request?.Scopes is { } scopes ? new Dictionary<string, InstallHintScope?>(scopes, StringComparer.Ordinal) : null;
        var error = InstallHintRules.Validate(incoming);
        var merged = error is null ? await handler.MergeAsync(userId, incoming!, ct) : null;
        if (error is not null || merged is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["scopes"] = [error ?? $"A dica aceita no máximo {InstallHintRules.MaxScopes} apps."],
            });
        }

        return TypedResults.Ok(merged);
    }
}
