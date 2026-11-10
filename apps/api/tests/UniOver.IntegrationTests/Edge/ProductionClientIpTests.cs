using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.AgentProtocol;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Edge;

/// <summary>
/// O IP do cliente atrás do proxy do Render, com o Host real em <c>Production</c> e a configuração que a produção usa. O
/// <c>appsettings.json</c> versionado traz <c>ForwardedHeaders:Enabled=false</c>; quem liga é a variável de ambiente
/// <c>ForwardedHeaders__Enabled=true</c> do serviço no painel (o repositório não a define em nenhum arquivo), que o .NET lê como a
/// chave <c>ForwardedHeaders:Enabled</c>, a mesma que estes testes definem. O IP que a auditoria grava e a chave do limite de taxa
/// saem os dois de <c>Connection.RemoteIpAddress</c>, então é ele que se confere. As regras por salto e por forma da cadeia estão em
/// <see cref="Audit.ForwardedChainTests"/> e <see cref="Audit.ClientIpTests"/>; aqui está o que depende de QUEM abriu a conexão.
/// </summary>
public class ProductionClientIpTests
{
    private const string RenderHop = "10.26.16.133";
    private const string RealClient = "203.0.113.7";
    private const string Forged = "6.6.6.6";

    private static readonly Dictionary<string, string?> Enabled = new()
    {
        ["ConnectionStrings:Default"] = "Host=h;Database=d;Username=u;Password=p",
        ["ForwardedHeaders:Enabled"] = "true",
    };

    private static EdgeFactory Production(string peer, bool forwardedHeaders = true) => new(
        "Production",
        forwardedHeaders ? Enabled : new Dictionary<string, string?> { ["ConnectionStrings:Default"] = Enabled["ConnectionStrings:Default"] },
        withTestEndpoints: true,
        peerAddress: peer);

    private static async Task<string?> ClientIpAsync(HttpClient client, string? forwardedFor)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/test/client-ip");
        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).Trim('"');
    }

    private static async Task<HttpStatusCode> LoginAsync(HttpClient client, string forwardedFor)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/test/login");
        request.Headers.Add("X-Forwarded-For", forwardedFor);
        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        return response.StatusCode;
    }

    [Fact]
    public void TheCommittedDefault_LeavesForwardedHeadersOff_SoProductionMustTurnThemOnExplicitly()
    {
        var appsettings = Path.Combine(OpenApiContractTests.RepositoryRoot(), "apps", "api", "src", "UniOver.Host", "appsettings.json");

        File.ReadAllText(appsettings).Should().MatchRegex("\"ForwardedHeaders\"\\s*:\\s*\\{\\s*\"Enabled\"\\s*:\\s*false\\s*\\}",
            "mudar o padrão versionado exige prova de que o proxy de produção acrescenta o IP real à cadeia");
    }

    [Fact]
    public async Task InProductionBehindTheRenderProxy_TheAuditedIpIsTheClientOfTheChain_NotTheProxyHop()
    {
        await using var factory = Production(RenderHop);
        using var client = factory.CreateClient();

        (await ClientIpAsync(client, $"{RealClient}, 10.27.0.14, 10.25.120.122")).Should().Be(RealClient);
        (await ClientIpAsync(client, RealClient)).Should().Be(RealClient);
        (await ClientIpAsync(client, null)).Should().Be(RenderHop, "sem cabeçalho não há cliente a descascar: vale o salto");
    }

    [Fact]
    public async Task InProductionBehindTheRenderProxy_AnEntryTheClientForgedToTheLeftIsIgnored()
    {
        await using var factory = Production(RenderHop);
        using var client = factory.CreateClient();

        (await ClientIpAsync(client, $"{Forged}, {RealClient}, {RenderHop}")).Should().Be(RealClient);
        (await ClientIpAsync(client, $"{Forged}, 10.9.9.9, {RealClient}, {RenderHop}")).Should().Be(RealClient);
    }

    [Theory]
    [InlineData("198.51.100.9")]
    [InlineData("2001:db8::9")]
    public async Task AHeaderFromAPeerOutsideTheTrustedRange_IsIgnored_AndTheIpIsThePeer(string publicPeer)
    {
        // Conexão direta de um endereço público, sem o proxy da frente: o X-Forwarded-For é do cliente e não vale nada.
        await using var factory = Production(publicPeer);
        using var client = factory.CreateClient();

        (await ClientIpAsync(client, Forged)).Should().Be(publicPeer);
        (await ClientIpAsync(client, $"{Forged}, {RealClient}")).Should().Be(publicPeer);
        (await ClientIpAsync(client, $"{Forged}, {RealClient}, {RenderHop}")).Should().Be(publicPeer,
            "dizer que passou por um salto interno não torna o peer público um proxy confiável");
    }

    [Fact]
    public async Task TheRateLimitPartitionFollowsTheRealClient_AndAPublicPeerCannotChooseItsOwnPartition()
    {
        await using var behindProxy = Production(RenderHop);
        using var viaProxy = behindProxy.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await LoginAsync(viaProxy, $"{RealClient}, 10.26.16.{100 + i}")).Should().Be(HttpStatusCode.OK);
        }

        (await LoginAsync(viaProxy, $"{RealClient}, 10.27.0.14")).Should().Be(HttpStatusCode.TooManyRequests,
            "o mesmo cliente por outros saltos internos cai na mesma partição");
        (await LoginAsync(viaProxy, "198.51.100.1, 10.26.16.100")).Should().Be(HttpStatusCode.OK, "outro cliente tem o seu limite");

        await using var direct = Production("198.51.100.9");
        using var viaDirect = direct.CreateClient();

        for (var i = 0; i < 5; i++)
        {
            (await LoginAsync(viaDirect, $"203.0.113.{i + 1}")).Should().Be(HttpStatusCode.OK);
        }

        (await LoginAsync(viaDirect, "203.0.113.200")).Should().Be(HttpStatusCode.TooManyRequests,
            "quem conecta direto não escolhe a partição pelo cabeçalho: trocá-lo não renova o limite");
    }

    [Fact]
    public async Task WithTheFlagLeftAtTheCommittedDefault_EveryCallerIsTheProxyHop_WhichIsWhyProductionMustEnableIt()
    {
        // O que aconteceria se a variável do painel faltasse: todo cliente teria o IP do salto do Render, e o limite do login
        // trancaria o próprio dono junto com qualquer outro.
        await using var factory = Production(RenderHop, forwardedHeaders: false);
        using var client = factory.CreateClient();

        (await ClientIpAsync(client, $"{RealClient}, {RenderHop}")).Should().Be(RenderHop);
        (await ClientIpAsync(client, Forged)).Should().Be(RenderHop);
    }
}
