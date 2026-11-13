using System.Globalization;
using System.Net.Mail;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.SystemSettings;

internal sealed record SaveSystemSettingRequest(JsonElement Value);

internal static class SystemSettingsEndpoint
{
    public static void MapSystemSettings(this IEndpointRouteBuilder group)
    {
        // Só o dono lê: o contato e os limites do sistema não são assunto de convidado.
        group.MapGet("/system-settings", ReadAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<SystemSettingValue>>().ProducesProblem(401).ProducesProblem(403);
        group.MapPut("/system-settings/{key}", SaveAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.SystemSettingsChange))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<SystemSettingValue>().ProducesProblem(400).ProducesProblem(401).ProducesProblem(403).ProducesProblem(409);
        group.MapDelete("/system-settings/{key}", ResetAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.SystemSettingsChange))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<SystemSettingValue>().ProducesProblem(401).ProducesProblem(403);
    }

    private static async Task<IResult> ReadAsync(SystemSettingsService settings, CancellationToken cancellationToken)
    {
        var values = new List<SystemSettingValue>();
        foreach (var key in SystemSettingKeys.All)
            values.Add(await settings.ReadAsync(key, cancellationToken));
        return TypedResults.Ok(values);
    }

    private static async Task<IResult> SaveAsync(
        string key, SaveSystemSettingRequest? request, HttpContext http, ICurrentUser current,
        IdentityDbContext db, SystemSettingsService settings, LoginAuditWriter audit,
        TimeProvider time, ITvCleanupSettingsPublisher? cleanupPublisher,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } ownerId) return IdentityProblems.Unauthenticated();
        if (!TryNormalize(key, request?.Value ?? default, out var valueJson))
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["value"] = ["Valor inválido para esta configuração."],
            });

        var row = await db.SystemSettings.SingleOrDefaultAsync(s => s.Key == key, cancellationToken);
        if (row is null)
        {
            row = new SystemSetting { Key = key };
            db.SystemSettings.Add(row);
        }
        row.ValueJson = valueJson;
        row.UpdatedBy = ownerId;
        row.UpdatedAt = time.GetUtcNow();
        // A trilha registra a chave, nunca o contato nem credenciais.
        audit.Add(ownerId, AuditEvents.SystemSettingChanged, ClientInfo.From(http), key);
        try { await db.SaveChangesAsync(cancellationToken); }
        // Duas primeiras gravações da mesma chave ao mesmo tempo: a segunda perde na chave primária e tenta de novo.
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return Results.Problem(statusCode: 409, title: "A configuração mudou ao mesmo tempo. Tente de novo.",
                type: ProblemDetailsExtensions.TypeBase + "system-setting-conflict");
        }
        settings.Invalidate(key);
        if (IsTvCleanupKey(key) && cleanupPublisher is not null)
            await cleanupPublisher.PublishAsync(cancellationToken: cancellationToken);
        return TypedResults.Ok(await settings.ReadAsync(key, cancellationToken));
    }

    private static bool TryNormalize(string key, JsonElement value, out string json)
    {
        json = string.Empty;
        switch (key)
        {
            case SystemSettingKeys.OffContact when value.ValueKind == JsonValueKind.String:
                var contact = value.GetString()?.Trim();
                if (contact is null || contact.Length is < 3 or > 200 || contact.Any(char.IsControl)
                    || !MailAddress.TryCreate(contact, out var address) || address.Address != contact) return false;
                json = JsonSerializer.Serialize(contact);
                return true;
            case SystemSettingKeys.MaxComputersPerGuest when value.ValueKind == JsonValueKind.Number:
                if (!value.TryGetInt32(out var limit) || limit is < 1 or > 20) return false;
                json = limit.ToString(CultureInfo.InvariantCulture);
                return true;
            case SystemSettingKeys.AgentOfflineMinutes when value.ValueKind == JsonValueKind.Number:
                if (!value.TryGetInt32(out var minutes) || minutes is < 1 or > 1440) return false;
                json = minutes.ToString(CultureInfo.InvariantCulture);
                return true;
            case SystemSettingKeys.TvLightCleanupEnabled when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
            case SystemSettingKeys.TvDeepCleanupEnabled when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                json = value.GetBoolean() ? "true" : "false";
                return true;
            case SystemSettingKeys.TvDeepCleanupMemoryThresholdMb when value.ValueKind == JsonValueKind.Number:
                if (!value.TryGetInt32(out var threshold) || threshold is < 64 or > 512) return false;
                json = threshold.ToString(CultureInfo.InvariantCulture);
                return true;
            case SystemSettingKeys.HomeSoonModules when value.ValueKind == JsonValueKind.Array:
                var ids = new List<string>();
                foreach (var item in value.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String || item.GetString() is not { } id || !IsHomeModuleId(id)) return false;
                    if (!ids.Contains(id, StringComparer.Ordinal)) ids.Add(id);
                }
                if (ids.Count > MaxHomeSoonModules) return false;
                json = JsonSerializer.Serialize(ids);
                return true;
            default:
                return false;
        }
    }

    /// <summary>Mesma forma que a Início aceita para o id de um módulo: minúsculas, dígitos e hífen, de 1 a 40 caracteres.</summary>
    private static bool IsHomeModuleId(string id) =>
        id.Length is >= 1 and <= 40
        && (char.IsAsciiLetterLower(id[0]) || char.IsAsciiDigit(id[0]))
        && id.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');

    private const int MaxHomeSoonModules = 20;

    private static async Task<IResult> ResetAsync(
        string key, HttpContext http, ICurrentUser current, IdentityDbContext db, SystemSettingsService settings,
        LoginAuditWriter audit, ITvCleanupSettingsPublisher? cleanupPublisher, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } ownerId) return IdentityProblems.Unauthenticated();
        if (!SystemSettingKeys.All.Contains(key, StringComparer.Ordinal)) return Results.BadRequest();

        var row = await db.SystemSettings.SingleOrDefaultAsync(s => s.Key == key, cancellationToken);
        if (row is not null)
        {
            db.SystemSettings.Remove(row);
            audit.Add(ownerId, AuditEvents.SystemSettingChanged, ClientInfo.From(http), key);
            await db.SaveChangesAsync(cancellationToken);
        }
        settings.Invalidate(key);
        if (IsTvCleanupKey(key) && cleanupPublisher is not null)
            await cleanupPublisher.PublishAsync(cancellationToken: cancellationToken);
        return TypedResults.Ok(await settings.ReadAsync(key, cancellationToken));
    }

    private static bool IsTvCleanupKey(string key) => key is SystemSettingKeys.TvLightCleanupEnabled
        or SystemSettingKeys.TvDeepCleanupEnabled or SystemSettingKeys.TvDeepCleanupMemoryThresholdMb;
}
