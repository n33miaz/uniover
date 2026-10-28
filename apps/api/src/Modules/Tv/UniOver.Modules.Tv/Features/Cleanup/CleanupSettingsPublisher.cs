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

    public async Task PublishAsync(string? agentSlug = null, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
        var tvs = await db.Tvs.AsNoTracking()
            .Where(tv => agentSlug == null || tv.AgentSlug == agentSlug)
            .Select(tv => new { tv.AgentSlug, tv.AllowBackgroundAppClosing })
            .ToListAsync(cancellationToken);
        var targets = tvs
            .Where(tv => presence.Get(tv.AgentSlug) is { Connected: true } info
                && info.Capabilities.Contains(Capability, StringComparer.Ordinal))
            .ToList();
        if (targets.Count == 0)
            return;

        var light = await settings.TvLightCleanupEnabledAsync(cancellationToken);
        var deep = await settings.TvDeepCleanupEnabledAsync(cancellationToken);
        var threshold = await settings.TvDeepCleanupMemoryThresholdMbAsync(cancellationToken);
        foreach (var tv in targets)
        {
            var body = JsonSerializer.SerializeToElement(new
            {
                lightEnabled = light,
                deepEnabled = deep,
                deepThresholdMb = threshold,
                closeBackgroundApps = tv.AllowBackgroundAppClosing,
            });
            await sender.PostAsync(tv.AgentSlug, new TvMessage("tv.cleanup.config.v1", body), cancellationToken);
        }
    }
}
