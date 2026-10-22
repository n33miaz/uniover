using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Contracts.Agents;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>Um agente pareado de verdade (pelo fluxo HTTP do pareamento), pronto para conectar.</summary>
internal sealed record PairedAgent(Guid Id, string Slug, string Token);

/// <summary>
/// Host real + Postgres real com o dono logado e um agente pareado, para os testes do transporte. Reaproveita o
/// <see cref="DevicesApp"/> (relógio falso, captura de log) e acrescenta o servidor de teste para o WebSocket, o
/// bilhete de stream para o SSE e a prova de "nenhuma escrita no banco".
/// </summary>
internal sealed class TransportApp : IAsyncDisposable
{
    private TransportApp(DevicesApp app, LoggedIn login, PairedAgent agent)
    {
        App = app;
        Login = login;
        Agent = agent;
        Server = (TestServer)app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>();
    }

    public DevicesApp App { get; }

    public LoggedIn Login { get; }

    public PairedAgent Agent { get; }

    public TestServer Server { get; }

    public IAgentGateway Gateway => App.Services.GetRequiredService<IAgentGateway>();

    public IAgentPresenceReader Presence => App.Services.GetRequiredService<IAgentPresenceReader>();

    public static async Task<TransportApp> StartAsync(PostgresFixture postgres, DevicesAppOptions? options = null)
    {
        // Sem passkey ao aprovar (só vale em Development): o pareamento aqui é só meio para ter um token real.
        options = (options ?? new DevicesAppOptions()) with { RequireStepUp = false };
        var app = await DevicesApp.StartAsync(postgres, options);
        var login = await app.LoginAsync();
        var (id, slug, token, _) = await app.PairAsync(login);
        return new TransportApp(app, login, new PairedAgent(id, slug, token));
    }

    public Task<FakeAgent> ConnectAsync() => FakeAgent.ConnectAsync(Server, Agent.Slug, Agent.Token);

    public Task<PairedAgent> PairAnotherAsync(string name) => PairAsync(name);

    private async Task<PairedAgent> PairAsync(string name)
    {
        var (id, slug, token, _) = await App.PairAsync(Login, name);
        return new PairedAgent(id, slug, token);
    }

    /// <summary>Pedido HTTP comum (sem upgrade) à rota de conexão, para conferir o que a abertura responde.</summary>
    public async Task<HttpStatusCode> HandshakeStatusAsync(string slug, string? bearer, string query = "")
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/devices/agents/{slug}/ws{query}");
        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }

        using var response = await App.Client.SendAsync(request, TestContext.Current.CancellationToken);
        return response.StatusCode;
    }

    /// <summary>Pede o bilhete de stream (o cookie <c>uo_st</c>) como o PWA faz.</summary>
    public async Task<string> StreamTicketAsync()
    {
        using var response = await App.SendAsync(
            HttpMethod.Post, "/api/v1/identity/auth/stream-ticket", bearer: Login.AccessToken);
        response.EnsureSuccessStatusCode();
        return IdentityApp.Cookies(response).Single(c => c.Name == "uo_st").Value;
    }

    /// <summary>Abre o fluxo SSE; devolve a resposta já com os cabeçalhos (o corpo segue aberto).</summary>
    public async Task<HttpResponseMessage> OpenEventsAsync(string? cookieTicket, string query = "")
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/devices/events{query}");
        if (cookieTicket is not null)
        {
            request.Headers.Add("Cookie", $"uo_st={cookieTicket}");
        }

        return await App.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, TestContext.Current.CancellationToken);
    }

    public static async Task WaitUntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow + FakeAgent.Patience;
        while (DateTime.UtcNow < deadline)
        {
            if (condition())
            {
                return;
            }

            await Task.Delay(25, TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"Condição não atingida a tempo: {what}.");
    }

    public static JsonNode TvKeyBody(string key = "VOLUME_UP") => new JsonObject { ["key"] = key };

    // ---- prova de que nada é gravado ----

    /// <summary>
    /// Impressão de todas as tabelas dos schemas <c>devices</c> e <c>identity</c> (contagem, maior <c>xmin</c> e hash
    /// do conteúdo). Qualquer INSERT, UPDATE ou DELETE muda a impressão.
    /// </summary>
    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "Nomes de tabela lidos do catálogo do próprio banco de teste.")]
    public async Task<string> DatabaseFingerprintAsync()
    {
        await using var connection = new NpgsqlConnection(App.Database.OwnerConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);

        var tables = new List<string>();
        await using (var list = new NpgsqlCommand(
            "SELECT table_schema || '.' || table_name FROM information_schema.tables " +
            "WHERE table_schema IN ('devices','identity') AND table_type = 'BASE TABLE' ORDER BY 1", connection))
        await using (var reader = await list.ExecuteReaderAsync(TestContext.Current.CancellationToken))
        {
            while (await reader.ReadAsync(TestContext.Current.CancellationToken))
            {
                tables.Add(reader.GetString(0));
            }
        }

        var parts = new List<string>();
        foreach (var table in tables)
        {
            var parts2 = table.Split('.');
            var quoted = $"\"{parts2[0]}\".\"{parts2[1]}\"";
            await using var command = new NpgsqlCommand(
                $"SELECT count(*), coalesce(max(t.xmin::text::bigint), 0), coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') FROM {quoted} t",
                connection);
            await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
            await reader.ReadAsync(TestContext.Current.CancellationToken);
            parts.Add($"{table}:{reader.GetInt64(0)}:{reader.GetInt64(1)}:{reader.GetString(2)}");
        }

        return string.Join('|', parts);
    }

    public ValueTask DisposeAsync() => App.DisposeAsync();
}
