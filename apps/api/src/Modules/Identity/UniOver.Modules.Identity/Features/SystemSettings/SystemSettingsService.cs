using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.SystemSettings;

public static class SystemSettingKeys
{
    public const string OffContact = "training.off-contact";
    public const string MaxComputersPerGuest = "devices.max-per-guest";
    public const string AgentOfflineMinutes = "devices.agent-offline-minutes";
    public const string PhotoStorageEnabled = "training.photo-storage-enabled";
    public static IReadOnlyList<string> All { get; } = [OffContact, MaxComputersPerGuest, AgentOfflineMinutes, PhotoStorageEnabled];
}

public sealed record SystemSettingValue(string Key, JsonElement Value, string Source);

/// <summary>O cache curto cobre as leituras frequentes de Treino e Devices; a escrita o invalida após o commit.</summary>
public sealed class SystemSettingsService(IServiceScopeFactory scopes, IConfiguration configuration, TimeProvider time) : ISystemSettings
{
    private readonly SystemSettingsCache _cache = new(time, TimeSpan.FromSeconds(15));

    public async Task<SystemSettingValue> ReadAsync(string key, CancellationToken cancellationToken = default)
    {
        if (!SystemSettingKeys.All.Contains(key, StringComparer.Ordinal)) throw new ArgumentOutOfRangeException(nameof(key));
        var stored = await _cache.GetAsync(key, async ct =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();
            return await db.SystemSettings.AsNoTracking().Where(s => s.Key == key)
                .Select(s => s.ValueJson).SingleOrDefaultAsync(ct);
        }, cancellationToken);
        if (stored is null) return new(key, EnvironmentValue(key), "server");
        using var document = JsonDocument.Parse(stored);
        return new(key, document.RootElement.Clone(), "app");
    }

    public void Invalidate(string key) => _cache.Invalidate(key);

    public async Task<string> OffContactAsync(CancellationToken cancellationToken = default) =>
        (await ReadAsync(SystemSettingKeys.OffContact, cancellationToken)).Value.GetString() ?? string.Empty;

    public async Task<int> MaxComputersPerGuestAsync(CancellationToken cancellationToken = default) =>
        (await ReadAsync(SystemSettingKeys.MaxComputersPerGuest, cancellationToken)).Value.GetInt32();

    public async Task<int> AgentOfflineMinutesAsync(CancellationToken cancellationToken = default) =>
        (await ReadAsync(SystemSettingKeys.AgentOfflineMinutes, cancellationToken)).Value.GetInt32();

    public async Task<bool> PhotoStorageEnabledAsync(CancellationToken cancellationToken = default) =>
        (await ReadAsync(SystemSettingKeys.PhotoStorageEnabled, cancellationToken)).Value.GetBoolean();

    private JsonElement EnvironmentValue(string key)
    {
        object value = key switch
        {
            SystemSettingKeys.OffContact => configuration["TRAINING_OFF_CONTACT"] ?? configuration["Modules:Training:Foods:OffContact"] ?? string.Empty,
            SystemSettingKeys.MaxComputersPerGuest => int.TryParse(configuration["Modules:Devices:Pairing:MaxPerGuest"], NumberStyles.None,
                CultureInfo.InvariantCulture, out var limit) && limit > 0 ? limit : 2,
            SystemSettingKeys.AgentOfflineMinutes => int.TryParse(configuration["Modules:Devices:Alerts:OfflineMinutes"], NumberStyles.None,
                CultureInfo.InvariantCulture, out var offlineMinutes) && offlineMinutes > 0 ? offlineMinutes : 10,
            _ => bool.TryParse(configuration["Modules:Training:Photos:Storage:Enabled"], out var enabled) && enabled,
        };
        return JsonSerializer.SerializeToElement(value);
    }
}
