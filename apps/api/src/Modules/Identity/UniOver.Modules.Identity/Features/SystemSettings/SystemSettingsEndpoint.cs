using System.Globalization;
using System.Net.Mail;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.SystemSettings;

internal sealed record SaveSystemSettingRequest(JsonElement Value);

internal static class SystemSettingsEndpoint
{
    public static void MapSystemSettings(this IEndpointRouteBuilder group)
    {
        // Só o dono lê: o contato e o estado do bucket não são assunto de convidado.
        group.MapGet("/system-settings", ReadAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<IReadOnlyList<SystemSettingValue>>().ProducesProblem(401).ProducesProblem(403);
        group.MapPut("/system-settings/{key}", SaveAsync)
            .RequireAuthorization(StepUp.Policy(StepUpActions.SystemSettingsChange))
            .RequireRateLimiting(RateLimitPolicies.Login)
            .Produces<SystemSettingValue>().ProducesProblem(400).ProducesProblem(401).ProducesProblem(403).ProducesProblem(409);
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
        IConfiguration configuration, TimeProvider time, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } ownerId) return IdentityProblems.Unauthenticated();
        if (!TryNormalize(key, request?.Value ?? default, out var valueJson))
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["value"] = ["Valor inválido para esta configuração."],
            });

        if (key == SystemSettingKeys.PhotoStorageEnabled && valueJson == "true" && !HasPhotoBucket(configuration))
            return Results.Problem(statusCode: 409,
                title: "O bucket de fotos precisa de endereço, região, nome e credenciais no servidor antes de ser ligado.",
                type: ProblemDetailsExtensions.TypeBase + "photo-bucket-not-configured");

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
            case SystemSettingKeys.PhotoStorageEnabled when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                json = value.GetBoolean() ? "true" : "false";
                return true;
            default:
                return false;
        }
    }

    // A região fica de fora: o Treino tem um padrão para ela (us-east-2), então "sem região no ambiente" ainda é um bucket
    // completo para ele, e exigi-la aqui travaria quem usa o padrão.
    private static readonly string[] BucketFields = ["Bucket", "AccessKey", "SecretKey"];

    /// <summary>Mesma regra do módulo de Treino para "bucket completo"; o Identity não o referencia, então lê a configuração.</summary>
    private static bool HasPhotoBucket(IConfiguration configuration)
    {
        var prefix = "Modules:Training:Photos:Storage:";
        return Uri.TryCreate(configuration[prefix + "ServiceUrl"], UriKind.Absolute, out var url)
            && url.Scheme == Uri.UriSchemeHttps
            && BucketFields.All(name => !string.IsNullOrWhiteSpace(configuration[prefix + name]));
    }
}
