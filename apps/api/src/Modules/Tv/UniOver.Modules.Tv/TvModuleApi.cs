using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Features.GetModuleInfo;

namespace UniOver.Modules.Tv;

/// <summary>Implementação em processo de <see cref="ITvModule"/>.</summary>
internal sealed class TvModuleApi(GetModuleInfoHandler handler) : ITvModule
{
    public Task<ModuleInfo> GetInfoAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(handler.Handle());
}
