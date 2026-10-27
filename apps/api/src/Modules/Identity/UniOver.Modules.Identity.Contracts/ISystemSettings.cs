namespace UniOver.Modules.Identity.Contracts;

/// <summary>Valores editáveis do sistema; consumidores não conhecem a persistência do Identity.</summary>
public interface ISystemSettings
{
    Task<string> OffContactAsync(CancellationToken cancellationToken = default);
    Task<int> MaxComputersPerGuestAsync(CancellationToken cancellationToken = default);
    Task<bool> PhotoStorageEnabledAsync(CancellationToken cancellationToken = default);
}
