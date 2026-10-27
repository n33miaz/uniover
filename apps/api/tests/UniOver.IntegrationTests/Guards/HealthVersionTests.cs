using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Guards;

/// <summary>A esteira só confirma o deploy quando esta rota pública expõe exatamente o commit em execução.</summary>
[Collection(PostgresGroup.Name)]
public sealed class HealthVersionTests(PostgresFixture postgres)
{
    [Fact]
    public async Task VersionEndpoint_ReturnsThePublishedCommitAndProductVersionWithoutCaching()
    {
        await using var factory = await GuardHost.StartAsync(postgres, "Production", "ABCDEF123456");
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
            AllowAutoRedirect = false,
        });

        using var response = await client.GetAsync("/health/version", TestContext.Current.CancellationToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl?.NoStore.Should().BeTrue();
        var payload = await IdentityApp.JsonAsync(response);
        payload.GetProperty("commit").GetString().Should().Be("abcdef123456");
        payload.GetProperty("version").GetString().Should().Be("0.5.0");
    }
}
