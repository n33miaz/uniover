using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Ports;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Cleanup;

/// <summary>
/// Publica a configuração no mesmo canal de comandos, só para agente que a declarou. Cada TV leva a preferência dela
/// de fechar apps em segundo plano (desligada por padrão); os ajustes gerais vêm do Sistema.
/// </summary>
internal sealed class CleanupSettingsPublisher(
    ISystemSettings settings, IAgentPresenceReader presence, ITvCommandSender sender, IServiceScopeFactory scopes)
    : ITvCleanupSettingsPublisher
{
    public const string Capability = "tv.cleanup.automatic.v1";

    /// <summary>
    /// Quem a anuncia entende os campos dos ajustes leves. O schema v1 antigo recusa campo desconhecido e descartaria a
    /// mensagem inteira (inclusive a limpeza que já funciona), então os demais agentes recebem exatamente o corpo antigo.
    /// </summary>
    public const string LightSettingsCapability = "tv.light-settings.v1";

    /// <summary>
    /// Quem a anuncia fecha os apps de fundo no Modo Foco. Mesma razão da capacidade acima: o campo novo só vai a quem
    /// o entende, e o agente só o recebe verdadeiro com o Modo Foco ligado nesta TV.
    /// </summary>
    public const string FocusClosesBackgroundCapability = "tv.focus-closes-background.v1";

    /// <summary>
    /// Quem a anuncia (a TV Samsung) recebe também a preferência da manutenção automática desta TV. O campo só vai a
    /// quem o declara, pelo mesmo motivo das capacidades acima: o schema recusa campo desconhecido.
    /// </summary>
    public const string MaintenanceCapability = "tv.maintenance.v1";

    public async Task PublishAsync(string? agentSlug = null, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
        var tvs = await db.Tvs.AsNoTracking()
            .Where(tv => agentSlug == null || tv.AgentSlug == agentSlug)
            .Select(tv => new { tv.AgentSlug, tv.AllowBackgroundAppClosing, tv.FocusModeEnabled, tv.ShortAnimationsEnabled, tv.RestrictedBackgroundPackages, tv.FocusClosesBackground, tv.AutoMaintenanceEnabled })
            .ToListAsync(cancellationToken);
        var targets = tvs
            .Select(tv => (Tv: tv, Info: presence.Get(tv.AgentSlug)))
            .Where(item => item.Info is { Connected: true } info
                && (info.Capabilities.Contains(Capability, StringComparer.Ordinal)
                    || info.Capabilities.Contains(MaintenanceCapability, StringComparer.Ordinal)))
            .ToList();
        if (targets.Count == 0)
            return;

        var light = await settings.TvLightCleanupEnabledAsync(cancellationToken);
        var deep = await settings.TvDeepCleanupEnabledAsync(cancellationToken);
        var threshold = await settings.TvDeepCleanupMemoryThresholdMbAsync(cancellationToken);
        foreach (var (tv, info) in targets)
        {
            var body = BuildBody(
                info!.Capabilities, tv.AllowBackgroundAppClosing, tv.FocusModeEnabled, tv.ShortAnimationsEnabled,
                tv.RestrictedBackgroundPackages, tv.FocusClosesBackground, light, deep, threshold, tv.AutoMaintenanceEnabled);
            await sender.PostAsync(tv.AgentSlug, new TvMessage("tv.cleanup.config.v1", body), cancellationToken);
        }
    }

    /// <summary>
    /// O corpo que o agente entende: sem <see cref="LightSettingsCapability"/> vai exatamente o corpo antigo, e o campo
    /// <c>focusClosesBackground</c> só existe para quem anuncia <see cref="FocusClosesBackgroundCapability"/>.
    /// </summary>
    internal static JsonElement BuildBody(
        IReadOnlyList<string> capabilities, bool closeBackgroundApps, bool focus, bool shortAnimations, string packages,
        bool focusCloses, bool light, bool deep, int threshold, bool autoMaintenance = true)
    {
        var knowsMaintenance = capabilities.Contains(MaintenanceCapability, StringComparer.Ordinal);
        if (!capabilities.Contains(LightSettingsCapability, StringComparer.Ordinal))
        {
            var old = new Dictionary<string, object>
            {
                ["lightEnabled"] = light,
                ["deepEnabled"] = deep,
                ["deepThresholdMb"] = threshold,
                ["closeBackgroundApps"] = closeBackgroundApps,
            };
            if (knowsMaintenance)
                old["maintenanceEnabled"] = autoMaintenance;
            return JsonSerializer.SerializeToElement(old);
        }

        var knowsFocusCloses = capabilities.Contains(FocusClosesBackgroundCapability, StringComparer.Ordinal);
        var fields = new Dictionary<string, object>
        {
            ["lightEnabled"] = light,
            ["deepEnabled"] = deep,
            ["deepThresholdMb"] = threshold,
            ["closeBackgroundApps"] = closeBackgroundApps,
            ["focusEnabled"] = focus,
            ["shortAnimationsEnabled"] = shortAnimations,
            ["restrictedPackages"] = ReadPackages(packages),
        };
        // Só o Modo Foco ligado nesta TV pode mandar fechar apps: desligado, o campo vai falso.
        if (knowsFocusCloses)
            fields["focusClosesBackground"] = focus && focusCloses;
        if (knowsMaintenance)
            fields["maintenanceEnabled"] = autoMaintenance;
        return JsonSerializer.SerializeToElement(fields);
    }

    private static string[] ReadPackages(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }
}
