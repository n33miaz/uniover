using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// A regra do IP do cliente atrás do proxy, com o mesmo middleware e as mesmas opções que o Host usa, variando o PEER (quem
/// abriu a conexão com o app) e a cadeia de <c>X-Forwarded-For</c>. Sem banco: é só a regra. O que se prova é que NADA que o
/// cliente escreve à esquerda do endereço real chega a virar o IP, que um peer público não é proxy de ninguém, e que da
/// borda da Cloudflare (e das faixas configuradas) só UM salto é descartado depois dos internos.
/// </summary>
public class ForwardedChainTests
{
    private const string RenderHop = "10.26.16.133";
    private const string RealClient = "198.51.100.4";
    private const string Forged = "203.0.113.77";

    /// <summary>Roda o middleware e devolve o IP e o esquema que o resto do pipeline enxergaria.</summary>
    private static async Task<(string? Ip, string Scheme)> RunAsync(
        string? peer, string? forwardedFor, string? proto = null, ForwardedClientIp? clientIp = null, params string[] moreForwardedForLines)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http";
        context.Connection.RemoteIpAddress = peer is null ? null : IPAddress.Parse(peer);
        if (forwardedFor is not null)
        {
            context.Request.Headers.Append("X-Forwarded-For", forwardedFor);
        }

        foreach (var line in moreForwardedForLines)
        {
            context.Request.Headers.Append("X-Forwarded-For", line);
        }

        if (proto is not null)
        {
            context.Request.Headers["X-Forwarded-Proto"] = proto;
        }

        // A mesma ordem do Host: o protocolo (biblioteca) e depois o IP (regra própria).
        var ipMiddleware = new ForwardedClientIpMiddleware(_ => Task.CompletedTask, clientIp ?? ForwardedHeadersExtensions.CreateClientIp([]));
        var middleware = new ForwardedHeadersMiddleware(
            ipMiddleware.InvokeAsync, NullLoggerFactory.Instance, Options.Create(ForwardedHeadersExtensions.CreateProtocolOptions()));
        await middleware.Invoke(context);
        return (context.Connection.RemoteIpAddress?.ToString(), context.Request.Scheme);
    }

    // ----- (a) peer interno: o primeiro público da direita para a esquerda é o cliente, e o que está à esquerda nunca é lido -----

    [Theory]
    [InlineData($"{RealClient}, {RenderHop}")]
    [InlineData($"{RealClient}, 10.27.0.14, 10.25.120.122")]
    [InlineData($"{RealClient}, 172.16.5.9, 192.168.1.20, 127.0.0.1")]
    [InlineData($"{RealClient}")]
    public async Task BehindAnInternalPeer_TheInternalHopsAreSkipped_AndTheClientIsTheFirstPublicAddress(string chain)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        ip.Should().Be(RealClient);
    }

    [Theory]
    [InlineData($"{Forged}, {RealClient}, 10.1.2.3")]
    [InlineData($"6.6.6.6, {Forged}, {RealClient}, 10.1.2.3, 10.4.5.6")]
    [InlineData($"{Forged}, 10.9.9.9, {RealClient}, 10.1.2.3")]
    [InlineData($"::1, {Forged}, 2001:db8::99, {RealClient}, {RenderHop}")]
    public async Task EntriesForgedToTheLeftOfTheRealClient_NeverBecomeTheIp(string chain)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        ip.Should().Be(RealClient, "só vale o primeiro público lido da direita; o que o cliente escreveu antes dele é ignorado");
    }

    [Fact]
    public async Task ForgedEntriesOnAnotherHeaderLine_BehaveTheSameAsOnTheSameLine()
    {
        // O cliente manda uma linha do cabeçalho e o proxy acrescenta outra: o valor combinado é o mesmo.
        var (ip, _) = await RunAsync(RenderHop, Forged, moreForwardedForLines: [$"{RealClient}, {RenderHop}"]);

        ip.Should().Be(RealClient);
    }

    [Fact]
    public async Task AGarbageEntryNextToThePeer_StopsTheReading_WithoutFallingBackToAnEarlierEntry()
    {
        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, {RealClient}, isto-nao-e-um-ip");

        ip.Should().Be(RenderHop, "a leitura para no que não é endereço; nada à esquerda é lido");
    }

    [Fact]
    public async Task WithNoForwardedHeader_ThePeerIsKept()
    {
        var (ip, _) = await RunAsync(RenderHop, forwardedFor: null);

        ip.Should().Be(RenderHop);
    }

    [Fact]
    public async Task TheProtocolFollowsTheSameTrust()
    {
        var (_, trusted) = await RunAsync(RenderHop, $"{RealClient}, {RenderHop}", proto: "https");
        var (_, untrusted) = await RunAsync("198.51.100.50", $"{RealClient}, {RenderHop}", proto: "https");

        trusted.Should().Be("https");
        untrusted.Should().Be("http", "de um peer público o cabeçalho de protocolo também não vale");
    }

    // ----- (b) peer público: ninguém confiável à frente, o cabeçalho é ignorado por inteiro -----

    [Theory]
    [InlineData($"{Forged}")]
    [InlineData($"{Forged}, {RealClient}")]
    [InlineData($"{Forged}, 10.0.0.1")]
    [InlineData("10.0.0.1")]
    public async Task APublicPeer_IsNotAProxy_AndTheHeaderIsIgnoredEntirely(string chain)
    {
        var (ip, _) = await RunAsync("198.51.100.50", chain);

        ip.Should().Be("198.51.100.50");
    }

    // ----- (c) cadeia só de internos: nunca aparece um público -----

    [Theory]
    [InlineData("10.1.1.1, 10.2.2.2")]
    [InlineData("192.168.0.9")]
    [InlineData("172.20.1.1, 127.0.0.1")]
    public async Task AChainOfOnlyInternalAddresses_NeverProducesAPublicOne(string chain)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        IPAddress.Parse(ip!).Should().Match<IPAddress>(
            address => ForwardedHeadersExtensions.InternalNetworks.Any(n => n.Contains(address)),
            "sem nenhum endereço público na cadeia o IP continua interno (o peer ou o último salto lido), nunca um valor escolhido de fora");
    }

    [Fact]
    public async Task ALongChainBeyondTheLimit_NeverProducesAForgedPublicAddress()
    {
        var hops = string.Join(", ", Enumerable.Range(1, ForwardedHeadersExtensions.ForwardLimit + 2).Select(i => $"10.0.0.{i}"));

        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, {hops}");

        IPAddress.Parse(ip!).ToString().Should().StartWith("10.0.0.", "só as últimas entradas, todas internas, são lidas");
    }

    // ----- (d) IPv6 -----

    [Theory]
    [InlineData("fd00::5", "2001:db8::7, fd00::9", "2001:db8::7")]
    [InlineData("fd12:3456::1", "2001:db8::7, fd00::9, fe80::1", "2001:db8::7")]
    [InlineData("::1", "2001:db8::7", "2001:db8::7")]
    [InlineData("10.0.0.5", "2001:db8::7, 10.1.1.1", "2001:db8::7")]
    [InlineData("::ffff:10.0.0.5", "198.51.100.4", "198.51.100.4")]
    public async Task IPv6_TheSameRuleApplies(string peer, string chain, string expected)
    {
        var (ip, _) = await RunAsync(peer, chain);

        ip.Should().Be(expected);
    }

    [Fact]
    public async Task IPv6_AForgedEntryToTheLeftOfTheRealClientIsIgnored()
    {
        var (ip, _) = await RunAsync("fd00::5", "2001:db8::bad, 2001:db8::7, fd00::9");

        ip.Should().Be("2001:db8::7");
    }

    [Fact]
    public async Task IPv6_APublicPeerIsNotAProxy()
    {
        var (ip, _) = await RunAsync("2001:db8::50", "::1, 198.51.100.4");

        ip.Should().Be("2001:db8::50");
    }

    // ----- (e) a borda da Cloudflare: NO MÁXIMO UM salto público descartado entre o cliente e os saltos internos -----

    private const string CloudflareEdge = "172.71.238.26";

    /// <summary>Um endereço de saída DENTRO de faixa da Cloudflare: quem navega pela rede dela (WARP) pode chegar assim.</summary>
    private const string ClientInsideCloudflare = "104.23.160.4";

    private static readonly ForwardedClientIp BuiltIn = ForwardedHeadersExtensions.CreateClientIp([]);

    [Theory]
    [InlineData($"{RealClient}, {CloudflareEdge}, {RenderHop}")]
    [InlineData($"{RealClient}, 104.22.17.9, 10.27.0.14, 10.25.120.122")]
    [InlineData($"{RealClient}, 104.23.160.4, {RenderHop}")]
    [InlineData($"{RealClient}, 172.64.0.1, {RenderHop}")]
    [InlineData($"{RealClient}, 162.158.90.11, {RenderHop}")]
    public async Task TheProductionChain_SkipsTheCloudflareEdge_AndTheClientIsTheRealAddress(string chain)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        ip.Should().Be(RealClient, "a borda da Cloudflare é proxy, não cliente: era o IP dela que ia para a auditoria");
    }

    [Theory]
    [InlineData($"1.2.3.4, {RealClient}, {CloudflareEdge}, 10.0.0.5")]
    [InlineData($"{Forged}, 1.2.3.4, {RealClient}, 104.22.17.9, 10.0.0.5, {RenderHop}")]
    [InlineData($"172.71.0.9, 10.0.0.1, {RealClient}, {CloudflareEdge}, 10.0.0.5")]
    public async Task BehindCloudflare_EntriesForgedToTheLeftOfTheRealClient_NeverBecomeTheIp(string chain)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        ip.Should().Be(RealClient);
    }

    [Theory]
    [InlineData($"{Forged}, {ClientInsideCloudflare}, {CloudflareEdge}, 10.0.0.5", ClientInsideCloudflare)]
    [InlineData($"{Forged}, 1.2.3.4, 172.68.1.1, 104.22.17.9, 10.0.0.5, {RenderHop}", "172.68.1.1")]
    [InlineData($"{Forged}, 104.28.5.5, {CloudflareEdge}, 10.0.0.5", "104.28.5.5")]
    [InlineData($"{Forged}, 2606:4700:10::1, {CloudflareEdge}, 10.0.0.5", "2606:4700:10::1")]
    [InlineData($"{Forged}, 2a06:98c0:3600::103, 2400:cb00:12::1, fd00::9", "2a06:98c0:3600::103")]
    public async Task AClientLeavingThroughCloudflare_IsTheClient_AndItsForgedEntryIsNeverRead(string chain, string expected)
    {
        var (ip, _) = await RunAsync(RenderHop, chain);

        ip.Should().Be(expected, "só UMA borda é descartada: o endereço que ela viu conectar é o cliente, mesmo em faixa da Cloudflare");
    }

    [Fact]
    public async Task OfTwoCloudflareAddressesInARow_TheLeftOneIsTheClient()
    {
        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, {RealClient}, {ClientInsideCloudflare}, {CloudflareEdge}, 10.0.0.5");

        ip.Should().Be(ClientInsideCloudflare, "o que está à esquerda dele (até um endereço com cara de cliente real) foi escrito por ele");
    }

    [Fact]
    public async Task AnInternalLookingEntryLeftOfTheEdge_IsTakenAsTheClient_AndTheReadingStops()
    {
        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, 10.9.9.9, {CloudflareEdge}, 10.0.0.5");

        ip.Should().Be("10.9.9.9", "depois da borda a leitura não continua: a entrada seguinte é quem conectou nela");
    }

    [Theory]
    [InlineData(CloudflareEdge, $"{Forged}, {RealClient}")]
    [InlineData("2606:4700::1", "2001:db8::bad, 2001:db8::7")]
    public async Task ACloudflareAddressAsTheDirectPeer_IsNotAProxy_AndTheHeaderIsIgnored(string peer, string chain)
    {
        var (ip, scheme) = await RunAsync(peer, chain, proto: "https");

        ip.Should().Be(peer, "só o balanceador interno entrega a cadeia; uma conexão direta de faixa da Cloudflare não vale");
        scheme.Should().Be("http");
    }

    [Theory]
    [InlineData("10.0.0.5", "2001:db8::7, 2606:4700:10::6816:1109, 10.1.1.1", "2001:db8::7")]
    [InlineData("fd00::5", "2001:db8::bad, 2001:db8::7, 2a06:98c0:3600::103, fd00::9", "2001:db8::7")]
    [InlineData("::ffff:10.0.0.5", "198.51.100.4, 2400:cb00:12::1, 10.1.1.1", "198.51.100.4")]
    public async Task IPv6_TheCloudflareEdgeIsSkippedToo(string peer, string chain, string expected)
    {
        var (ip, _) = await RunAsync(peer, chain);

        ip.Should().Be(expected);
    }

    [Theory]
    [InlineData("172.16.0.0", true, false)]
    [InlineData("172.31.255.255", true, false)]
    [InlineData("172.32.0.1", false, false)]
    [InlineData("172.63.255.255", false, false)]
    [InlineData("172.64.0.0", false, true)]
    [InlineData("172.71.255.255", false, true)]
    [InlineData("172.72.0.1", false, false)]
    [InlineData("104.15.255.255", false, false)]
    [InlineData("104.16.0.0", false, true)]
    [InlineData("104.27.255.255", false, true)]
    [InlineData("104.28.0.1", false, false)]
    [InlineData("2606:4700:ffff::1", false, true)]
    [InlineData("2606:4701::1", false, false)]
    [InlineData("2a06:98c7:ffff::1", false, true)]
    [InlineData("2a06:98c8::1", false, false)]
    [InlineData("fd00::9", true, false)]
    [InlineData("198.51.100.4", false, false)]
    public void TheEdgesOfTheRanges_AreExact(string address, bool isInternal, bool isEdge)
    {
        var ip = IPAddress.Parse(address);

        ForwardedClientIp.IsInternal(ip).Should().Be(isInternal);
        BuiltIn.IsEdge(ip).Should().Be(isEdge, "172.64.0.0/13 da Cloudflare e a privada 172.16.0.0/12 não se confundem nem cobrem o que fica entre elas");
    }

    [Theory]
    [InlineData("172.32.0.1")]
    [InlineData("172.63.255.255")]
    [InlineData("172.72.0.1")]
    public async Task AnAddressBetweenThePrivateAndTheCloudflare172Ranges_IsAClient_NotAProxy(string client)
    {
        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, {client}, 10.0.0.5");

        ip.Should().Be(client);
    }

    [Fact]
    public async Task AChainThatEndsAtTheEdge_ProducesTheEdge_NeverAValueChosenFromOutside()
    {
        var (ip, _) = await RunAsync(RenderHop, $"{CloudflareEdge}, 10.1.1.1");

        ip.Should().Be(CloudflareEdge);
    }

    [Fact]
    public async Task AnEntryWithAPort_IsReadAsItsAddress()
    {
        var (ip, _) = await RunAsync(RenderHop, $"{Forged}, {RealClient}:51234, [2606:4700:10::1]:443, 10.0.0.5:8080");

        ip.Should().Be(RealClient);
    }

    // ----- (f) faixas de borda a mais pela configuração: somadas às embutidas, com o mesmo limite de uma por cadeia -----

    private static IConfiguration Configuration(params string[] trustedNetworks) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(trustedNetworks.Select((network, i) =>
                new KeyValuePair<string, string?>($"{ForwardedHeadersExtensions.TrustedNetworksKey}:{i}", network)))
            .Build();

    [Fact]
    public async Task AConfiguredExtraRange_IsAnEdge_OnTopOfTheBuiltInOnes()
    {
        var extended = ForwardedHeadersExtensions.CreateClientIp(Configuration("192.0.2.0/24", "2001:db8:ff::/48"));
        const string chain = $"{Forged}, {RealClient}, 192.0.2.44, 10.0.0.5";

        var (builtIn, _) = await RunAsync(RenderHop, chain);
        var (configured, _) = await RunAsync(RenderHop, chain, clientIp: extended);
        var (configuredV6, _) = await RunAsync(RenderHop, $"{RealClient}, 2001:db8:ff::1, 10.0.0.5", clientIp: extended);
        var (cloudflareStill, _) = await RunAsync(RenderHop, $"{Forged}, {RealClient}, {CloudflareEdge}, 10.0.0.5", clientIp: extended);
        var (onlyOne, _) = await RunAsync(RenderHop, $"{Forged}, 192.0.2.44, {CloudflareEdge}, 10.0.0.5", clientIp: extended);

        builtIn.Should().Be("192.0.2.44", "sem a configuração a faixa não é borda: a leitura para nela");
        configured.Should().Be(RealClient, "a faixa configurada é descartada como borda");
        configuredV6.Should().Be(RealClient);
        cloudflareStill.Should().Be(RealClient, "as embutidas continuam valendo");
        onlyOne.Should().Be("192.0.2.44", "o limite de uma borda por cadeia vale para a soma das faixas");
    }

    [Fact]
    public void WithoutTheSetting_OrWithItEmpty_TheEdgeListIsTheBuiltInOne()
    {
        var cloudflare = ForwardedHeadersExtensions.CloudflareNetworks;

        BuiltIn.EdgeNetworks.Should().Equal(cloudflare);
        ForwardedHeadersExtensions.CreateClientIp(Configuration()).EdgeNetworks.Should().Equal(cloudflare);
        ForwardedHeadersExtensions.CreateClientIp(Configuration("172.64.0.0/13")).EdgeNetworks
            .Should().Equal(cloudflare, "uma faixa repetida não entra duas vezes");
        BuiltIn.EdgeNetworks.Should().NotBeEmpty();
    }

    [Theory]
    [InlineData("isto-nao-e-rede")]
    [InlineData("203.0.113.0/40")]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void AnInvalidOrCatchAllConfiguredRange_FailsLoudly_InsteadOfBeingIgnored(string network)
    {
        var act = () => ForwardedHeadersExtensions.CreateClientIp(Configuration(network));

        act.Should().Throw<InvalidOperationException>().WithMessage($"*{ForwardedHeadersExtensions.TrustedNetworksKey}*");
    }

    [Fact]
    public void TheProtocolOptions_TrustOnlyTheInternalNetworks_AndNeverAnEmptyList()
    {
        var options = ForwardedHeadersExtensions.CreateProtocolOptions();

        options.ForwardedHeaders.Should().Be(ForwardedHeaders.XForwardedProto, "o IP é da regra própria, não da biblioteca");
        options.ForwardLimit.Should().Be(1);

        // Lista vazia significaria "confia em qualquer origem": o cliente escolheria o protocolo.
        options.KnownProxies.Should().BeEmpty("os endereços de laço local entram como rede, na lista de redes");
        options.KnownIPNetworks.Select(n => n.ToString()).Should().BeEquivalentTo(
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128", "fc00::/7", "fe80::/10");
        ForwardedHeadersExtensions.ForwardLimit.Should().BeInRange(3, 16,
            "depois do cliente vêm a borda da Cloudflare e mais de um salto interno do Render");
    }

    [Fact]
    public void TheEmbeddedCloudflareList_IsThePublishedOne()
    {
        ForwardedHeadersExtensions.CloudflareNetworks.Select(n => n.ToString()).Should().BeEquivalentTo(
            "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
            "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
            "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
            "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32");
    }
}
