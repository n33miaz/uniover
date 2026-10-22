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
/// O IP vira dado de auditoria (e chave do limite de taxa), então um cliente não pode escolhê-lo. Atrás do Render a cadeia
/// de <c>X-Forwarded-For</c> traz o cliente seguido de saltos INTERNOS (10.x.x.x, em número e valor variáveis): vale o
/// primeiro endereço PÚBLICO lido da direita para a esquerda, e tudo à esquerda dele (o que o cliente escreveu) é ignorado.
/// A regra por peer (público ou privado, IPv6) está em <see cref="ForwardedChainTests"/>; aqui é o caminho inteiro, até a trilha.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class ClientIpTests(PostgresFixture postgres)
{
    private const string RealClient = "203.0.113.7";
    private const string Forged = "6.6.6.6";
    private const string InternalHop = "10.26.16.133";

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
    public async Task BehindTheRender_TheInternalHopsAfterTheClientAreSkipped_AndTheClientIsAudited()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        // O que o Render monta: o cliente e, depois dele, saltos internos que mudam a cada requisição.
        (await AuditedIpAsync(app, forwardedFor: $"{RealClient}, {InternalHop}")).Should().Be(RealClient);
        (await AuditedIpAsync(app, forwardedFor: $"{RealClient}, 10.27.0.14, 10.25.120.122")).Should().Be(RealClient);
    }

    [Fact]
    public async Task AClientCannotChooseTheAuditedIp_WhateverItForgesToTheLeftOfTheRealClientAndTheInternalHops()
    {
        await using var app = await StartAsync(forwardedHeaders: true);

        (await AuditedIpAsync(app, forwardedFor: $"{Forged}, {RealClient}, {InternalHop}")).Should().Be(RealClient);
        (await AuditedIpAsync(app, forwardedFor: $"{Forged}, 10.9.9.9, {RealClient}, {InternalHop}, 10.27.0.14")).Should().Be(RealClient);
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
    public void TheForwardedHeadersOptions_TrustOnlyTheInternalNetworks_AndNeverAnEmptyList()
    {
        var options = ForwardedHeadersExtensions.CreateOptions();

        options.ForwardLimit.Should().Be(ForwardedHeadersExtensions.ForwardLimit).And.BeInRange(2, 16,
            "o Render põe mais de um salto interno: o limite de 1 lia o salto, não o cliente");
        options.RequireHeaderSymmetry.Should().BeFalse();
        options.ForwardedHeaders.Should().Be(ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto);

        // Lista vazia significaria "confia em qualquer origem": o cliente escolheria o próprio IP.
        options.KnownIPNetworks.Should().NotBeEmpty();
        options.KnownProxies.Should().BeEmpty("os endereços de laço local entram como rede, na lista de redes");
        options.KnownIPNetworks.Select(n => n.ToString()).Should().BeEquivalentTo(
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128", "fc00::/7", "fe80::/10");
    }
}
