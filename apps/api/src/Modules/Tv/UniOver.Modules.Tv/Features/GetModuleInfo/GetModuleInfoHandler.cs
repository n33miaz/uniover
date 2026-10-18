using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Tv.Features.GetModuleInfo;

public sealed class GetModuleInfoHandler(string version)
{
    public ModuleInfo Handle() => new(TvModule.Name, version);
}
