using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Identity.Features.GetModuleInfo;

/// <summary>
/// Depende de <see cref="ITvModule"/> (contrato) só para provar o caminho permitido entre módulos:
/// o nome vem da resposta do Tv, nunca de um tipo interno dele.
/// </summary>
public sealed class GetModuleInfoHandler(string version, ITvModule tv)
{
    public async Task<IdentityModuleInfo> HandleAsync(CancellationToken cancellationToken = default)
    {
        var tvInfo = await tv.GetInfoAsync(cancellationToken);
        return new IdentityModuleInfo(IdentityModule.Name, version, [tvInfo.Module]);
    }
}
