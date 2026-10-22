using System.Net;
using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// A regra do IP do cliente atrás do proxy, com o mesmo middleware e as mesmas opções que o Host usa, variando o PEER (quem
/// abriu a conexão com o app) e a cadeia de <c>X-Forwarded-For</c>. Sem banco: é só a regra. O que se prova é que NADA que o
/// cliente escreve à esquerda do endereço público real chega a virar o IP, e que um peer público não é proxy de ninguém.
/// </summary>
public class ForwardedChainTests
{
    private const string RenderHop = "10.26.16.133";
    private const string RealClient = "198.51.100.4";
    private const string Forged = "203.0.113.77";

    /// <summary>Roda o middleware e devolve o IP e o esquema que o resto do pipeline enxergaria.</summary>
    private static async Task<(string? Ip, string Scheme)> RunAsync(string? peer, string? forwardedFor, string? proto = null, params string[] moreForwardedForLines)
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

        var middleware = new ForwardedHeadersMiddleware(
            _ => Task.CompletedTask, NullLoggerFactory.Instance, Options.Create(ForwardedHeadersExtensions.CreateOptions()));
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
        var (ip, _) = await RunAsync(RenderHop, Forged, proto: null, $"{RealClient}, {RenderHop}");

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
}
