using System.Net.Http.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// O IP vira dado de auditoria, então um cliente não pode escolhê-lo. Atrás do proxy do Render vale a ÚLTIMA entrada de
/// <c>X-Forwarded-For</c> (a que o proxy acrescentou); tudo que o cliente mandou antes dela é ignorado.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ClientIpTests(PostgresFixture postgres)
{
    private const string RealClient = "203.0.113.7";
    private const string Forged = "6.6.6.6";

    private async Task<IdentityApp> StartAsync(bool forwardedHeaders) =>
        await IdentityApp.StartAsync(postgres, new IdentityAppOptions { ForwardedHeaders = forwardedHeaders });

    /// <summary>Um login que falha (e-mail desconhecido) e o IP que a trilha guardou para ele.</summary>
    private static async Task<string?> AuditedIpAsync(IdentityApp app, Func<HttpRequestMessage, Task>? shape = null, string? forwardedFor = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = $"x{Guid.NewGuid():N}@uniover.test", password = "qualquer-senha-123" }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        if (shape is not null)
        {
            await shape(request);
        }

        using var response = await app.Client.SendAsync(request, Ct);
        ((int)response.StatusCode).Should().Be(401);

        await using var db = app.Db();
        var row = await db.LoginAudit.AsNoTracking()
            .Where(a => a.Event == AuditEvents.LoginFailed)
            .OrderByDescending(a => a.OccurredAt)
            .FirstAsync(Ct);
        return row.Ip;
    }

    [Fact]
    public async Task AClientCannotChooseTheAuditedIp_TheProxysAppendedEntryWins()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        // Uma linha só, como o proxy a monta ao acrescentar o IP de quem conectou: o que o cliente mandou vem antes.
        (await AuditedIpAsync(app, forwardedFor: $"{Forged}, {RealClient}")).Should().Be(RealClient);
    }

    [Fact]
    public async Task AClientCannotChooseTheAuditedIp_EvenWithAWholeForgedChain()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        (await AuditedIpAsync(app, forwardedFor: $"{Forged}, 7.7.7.7, 8.8.8.8, {RealClient}")).Should().Be(RealClient);
    }

    [Fact]
    public async Task AClientCannotChooseTheAuditedIp_WhenTheProxyAddsASecondHeaderLine()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        var ip = await AuditedIpAsync(app, request =>
        {
            // Duas linhas do mesmo cabeçalho: a do cliente e a que o proxy acrescentou.
            request.Headers.Add("X-Forwarded-For", Forged);
            request.Headers.Add("X-Forwarded-For", RealClient);
            return Task.CompletedTask;
        });

        ip.Should().Be(RealClient);
    }

    [Fact]
    public async Task AGarbageLastEntry_NeverFallsBackToAnEarlierOneTheClientWrote()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        var ip = await AuditedIpAsync(app, forwardedFor: $"{Forged}, isto-nao-e-um-ip");

        ip.Should().NotBe(Forged);
    }

    [Fact]
    public async Task WithTheFlagOff_TheHeaderIsIgnored_SoItCannotForgeAnythingEither()
    {
        await using var app = await StartAsync(forwardedHeaders: false);

        var ip = await AuditedIpAsync(app, forwardedFor: $"{Forged}, {RealClient}");

        ip.Should().NotBe(Forged).And.NotBe(RealClient, "sem o proxy confiável o cabeçalho não vale nada");
    }

    [Fact]
    public async Task AnOwnerWhoIsLoggedIn_SeesTheRealIpInTheTrailThroughTheEndpoint()
    {
        var database = await MigratedDatabaseAsync(postgres);
        await using var app = await StartAppAsync(postgres, database, forwardedHeaders: true);
        var owner = await app.LoginAsync();

        using var failed = await app.LoginRawAsync("alguem@uniover.test", "senha-errada-123", forwardedFor: $"{Forged}, {RealClient}");
        failed.StatusCode.Should().Be(System.Net.HttpStatusCode.Unauthorized);
        var page = await GetJsonAsync(app, owner.AccessToken, "?action=login_failed&limit=10");

        var item = page.GetProperty("items").EnumerateArray().Single();
        item.GetProperty("ip").GetString().Should().Be(RealClient);
    }

    [Fact]
    public void TheForwardedHeadersOptions_ReadOnlyTheLastEntry_AndTrustAnyProxyOnPurpose()
    {
        var options = ForwardedHeadersExtensions.CreateOptions();

        options.ForwardLimit.Should().Be(1, "só a última entrada (a do proxy da frente) é lida");
        options.ForwardedHeaders.Should().Be(ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto);
        options.KnownProxies.Should().BeEmpty();
        options.KnownIPNetworks.Should().BeEmpty();
    }
}
