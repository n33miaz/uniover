using AwesomeAssertions;
using UniOver.Modules.Identity.Features.GetModuleInfo;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Identity.Tests;

public class GetModuleInfoHandlerTests
{
    // Dublê do contrato do Tv: o teste de unidade não precisa do módulo real, só da interface pública.
    private sealed class FakeTv : ITvModule
    {
        public Task<ModuleInfo> GetInfoAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(new ModuleInfo("tv", "9.9.9"));
    }

    [Fact]
    public async Task HandleAsync_ReturnsVersionAndDependsOnTv()
    {
        var handler = new GetModuleInfoHandler("1.2.3", new FakeTv());

        var info = await handler.HandleAsync(TestContext.Current.CancellationToken);

        info.Module.Should().Be("identity");
        info.Version.Should().Be("1.2.3");
        info.DependsOn.Should().Equal("tv");
    }
}
