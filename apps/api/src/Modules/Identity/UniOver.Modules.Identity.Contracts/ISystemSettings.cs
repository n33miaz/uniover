namespace UniOver.Modules.Identity.Contracts;

/// <summary>Valores editáveis do sistema; consumidores não conhecem a persistência do Identity.</summary>
public interface ISystemSettings
{
    Task<string> OffContactAsync(CancellationToken cancellationToken = default);
    Task<int> MaxComputersPerGuestAsync(CancellationToken cancellationToken = default);
    Task<int> AgentOfflineMinutesAsync(CancellationToken cancellationToken = default);
    Task<bool> PhotoStorageEnabledAsync(CancellationToken cancellationToken = default);
    Task<bool> TvLightCleanupEnabledAsync(CancellationToken cancellationToken = default);
    Task<bool> TvDeepCleanupEnabledAsync(CancellationToken cancellationToken = default);
    Task<int> TvDeepCleanupMemoryThresholdMbAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Entrega ao agente as preferências de limpeza depois de uma alteração já confirmada. Sem <paramref name="agentSlug"/>
/// vale para todos os computadores com TV; com ele, só para o computador indicado (o que acabou de conectar).
/// </summary>
public interface ITvCleanupSettingsPublisher
{
    Task PublishAsync(string? agentSlug = null, CancellationToken cancellationToken = default);

    /// <summary>
    /// Avisa o computador que deixou de controlar uma TV (trocado por outro ou TV removida) para ele parar o que
    /// ainda tinha agendado nela. Sem implementação, nada é enviado.
    /// </summary>
    Task PublishUnboundAsync(string agentSlug, CancellationToken cancellationToken = default) => Task.CompletedTask;
}
