namespace UniOver.Modules.Tv.Contracts;

/// <summary>
/// API pública em processo do módulo Tv. Se o Tv virar um deploy separado, quem usa esta interface
/// passa a receber um cliente HTTP com o mesmo contrato.
/// </summary>
public interface ITvModule
{
    Task<ModuleInfo> GetInfoAsync(CancellationToken cancellationToken = default);
}
