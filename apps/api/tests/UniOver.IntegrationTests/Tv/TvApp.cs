using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Npgsql;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.IntegrationTests.Tv;

internal sealed record TvAppOptions
{
    /// <summary>Limite da política de comandos; o padrão alto não atrapalha os testes que não falam de limite.</summary>
    public int CommandsPermitted { get; init; } = 100000;

    /// <summary>Slug do agente que controla a TV. O pareamento de "PC Casa" produz exatamente <c>pc-casa</c>.</summary>
    public string AgentId { get; init; } = TvApp.AgentSlug;
}

/// <summary>Os eventos de integração que um assinante de teste recebeu da outbox do módulo Tv.</summary>
internal sealed class TvEventsProbe
{
    public System.Collections.Concurrent.ConcurrentQueue<TvStateChanged> States { get; } = new();

    public System.Collections.Concurrent.ConcurrentQueue<TvWatchdogRecorded> Watchdogs { get; } = new();
}

internal sealed class StateChangedProbeHandler(TvEventsProbe probe) : IIntegrationEventHandler<TvStateChanged>
{
    public Task HandleAsync(TvStateChanged integrationEvent, CancellationToken cancellationToken)
    {
        probe.States.Enqueue(integrationEvent);
        return Task.CompletedTask;
    }
}

internal sealed class WatchdogProbeHandler(TvEventsProbe probe) : IIntegrationEventHandler<TvWatchdogRecorded>
{
    public Task HandleAsync(TvWatchdogRecorded integrationEvent, CancellationToken cancellationToken)
    {
        probe.Watchdogs.Enqueue(integrationEvent);
        return Task.CompletedTask;
    }
}

/// <summary>
/// Host real + Postgres real com Identity, Devices e Tv migrados, o dono logado e um agente pareado (o que controla a
/// TV), relógio falso e captura de log. O agente da TV é o <see cref="FakeAgent"/> que fala o contrato de verdade
/// pelo WebSocket do servidor de teste.
/// </summary>
internal sealed class TvApp : IAsyncDisposable
{
    public const string AgentSlug = "pc-casa";
    public const string ClientIp = "198.51.100.9";
    public const string UserAgentText = "pwa-teste/1.0";

    private readonly EdgeFactory _root;
    private readonly WebApplicationFactory<Program> _factory;

    private TvApp(
        EdgeFactory root, WebApplicationFactory<Program> factory, TestDatabase database,
        FakeTimeProvider time, CapturingLoggerProvider logs, string ownerEmail, string ownerPassword)
    {
        _root = root;
        _factory = factory;
        Database = database;
        Time = time;
        Logs = logs;
        OwnerEmail = ownerEmail;
        OwnerPassword = ownerPassword;
        Client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
            AllowAutoRedirect = false,
        });
        Server = (TestServer)factory.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>();
    }

    public TestDatabase Database { get; }

    public FakeTimeProvider Time { get; }

    public CapturingLoggerProvider Logs { get; }

    public string OwnerEmail { get; }

    public string OwnerPassword { get; }

    public HttpClient Client { get; }

    public TestServer Server { get; }

    public IServiceProvider Services => _factory.Services;

    public string SigningKey { get; private init; } = string.Empty;

    /// <summary>Token de acesso de outro usuário (a conta é única, então ele é assinado com a chave do teste).</summary>
    public string OtherUserToken() => IdentityApp.CraftToken(
        SigningKey, Time.GetUtcNow().AddMinutes(-1), Time.GetUtcNow().AddHours(1), subject: Guid.NewGuid());

    public LoggedIn Login { get; private set; } = null!;

    public PairedAgent Agent { get; private set; } = null!;

    public TvEventsProbe Events => Services.GetRequiredService<TvEventsProbe>();

    public IAgentPresenceReader Presence => Services.GetRequiredService<IAgentPresenceReader>();

    public static async Task<TvApp> StartAsync(PostgresFixture postgres, TvAppOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);
        options ??= new TvAppOptions();

        var database = await postgres.CreateDatabaseAsync();
        await using (var identity = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await identity.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        await using (var devices = DevicesApp.CreateContext(database.OwnerConnection))
        {
            await devices.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        await using (var tv = CreateContext(database.OwnerConnection))
        {
            await tv.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        var password = IdentityApp.NewPassword();
        var ownerEmail = "dono@uniover.test";
        var time = new FakeTimeProvider(
            new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond, TimeSpan.Zero));
        var logs = new CapturingLoggerProvider();

        var signingKey = IdentityApp.NewKey();
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = signingKey,
            ["Modules:Identity:Passkeys:RpId"] = "localhost",
            ["Modules:Identity:Passkeys:Origins:0"] = "https://localhost",
            ["Modules:Devices:Pairing:RequireStepUp"] = "false",
            ["Modules:Tv:AgentId"] = options.AgentId,
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["RateLimiting:pairing:Permitted"] = "100000",
            ["RateLimiting:commands:Permitted"] = options.CommandsPermitted.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Logging:LogLevel:Default"] = "Debug",

            // O IP real do cliente só aparece na auditoria com os cabeçalhos de proxy ligados.
            ["ForwardedHeaders:Enabled"] = "true",
            ["UNIOVER_OWNER_EMAIL"] = ownerEmail,
            ["UNIOVER_OWNER_PASSWORD"] = password,
        };

        var root = new EdgeFactory("Development", settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(time);
            services.AddSingleton<ILoggerProvider>(logs);
            services.AddSingleton<TvEventsProbe>();
            services.AddScoped<IIntegrationEventHandler<TvStateChanged>, StateChangedProbeHandler>();
            services.AddScoped<IIntegrationEventHandler<TvWatchdogRecorded>, WatchdogProbeHandler>();
        }));

        var app = new TvApp(root, factory, database, time, logs, ownerEmail, password) { SigningKey = signingKey };
        await factory.Services.GetRequiredService<OwnerBootstrapService>().Completion;
        app.Login = await app.LoginAsync();
        app.Agent = await app.PairAsync("PC Casa");
        return app;
    }

    public static TvDbContext CreateContext(string connection)
    {
        var builder = new DbContextOptionsBuilder<TvDbContext>();
        ModuleDatabase.Configure(builder, connection, TvDbContext.SchemaName, typeof(TvDbContext).Assembly);
        return new TvDbContext(builder.Options);
    }

    /// <summary>Contexto com o papel dono, só para o teste inspecionar o banco.</summary>
    public TvDbContext Db() => CreateContext(Database.OwnerConnection);

    /// <summary>Contexto do Identity com o papel dono, só para o teste inspecionar o banco.</summary>
    public Modules.Identity.Persistence.IdentityDbContext Identity() => IdentityApp.CreateContext(Database.OwnerConnection);

    public Task<FakeAgent> ConnectAsync() => ConnectAsync(Agent);

    public Task<FakeAgent> ConnectAsync(PairedAgent agent) => FakeAgent.ConnectAsync(Server, agent.Slug, agent.Token);

    public async Task<FakeAgent> ConnectAndWaitAsync()
    {
        var agent = await ConnectAsync();
        await WaitUntilAsync(() => Presence.Get(Agent.Slug)?.Connected == true, "agente conectado");
        return agent;
    }

    public async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string url, object? body = null, string? bearer = "", string? forwardedFor = ClientIp, string? userAgent = UserAgentText)
    {
        using var request = new HttpRequestMessage(method, url);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        // "" significa "o dono logado"; nulo significa "sem credencial".
        var token = bearer == string.Empty ? Login.AccessToken : bearer;
        if (token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        if (userAgent is not null)
        {
            request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        }

        return await Client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    public Task<HttpResponseMessage> PostAsync(string url, object? body = null, string? bearer = "") =>
        SendAsync(HttpMethod.Post, url, body, bearer);

    public Task<HttpResponseMessage> GetAsync(string url, string? bearer = "") =>
        SendAsync(HttpMethod.Get, url, bearer: bearer);

    public static Task<JsonElement> JsonAsync(HttpResponseMessage response) => IdentityApp.JsonAsync(response);

    private async Task<LoggedIn> LoginAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = OwnerEmail, password = OwnerPassword }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        using var response = await Client.SendAsync(request, TestContext.Current.CancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await IdentityApp.JsonAsync(response);
        var cookie = IdentityApp.Cookies(response).Single(c => c.Name == "uo_rt");
        return new LoggedIn(body.GetProperty("accessToken").GetString()!, cookie.Value, cookie, body);
    }

    /// <summary>Pareamento completo pelo fluxo HTTP (start, aprovação, consulta) para ter um token de dispositivo real.</summary>
    public async Task<PairedAgent> PairAsync(string name)
    {
        using var start = await SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/start", new { agentName = name, platform = "windows", agentVersion = "0.1.0" }, bearer: null);
        start.EnsureSuccessStatusCode();
        var started = await JsonAsync(start);

        using var approve = await SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode = started.GetProperty("userCode").GetString() });
        approve.EnsureSuccessStatusCode();
        var agentId = (await JsonAsync(approve)).GetProperty("id").GetGuid();

        using var poll = await SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/poll",
            new { pairingId = started.GetProperty("pairingId").GetGuid(), deviceCode = started.GetProperty("deviceCode").GetString() },
            bearer: null);
        poll.EnsureSuccessStatusCode();
        var polled = await JsonAsync(poll);
        return new PairedAgent(agentId, polled.GetProperty("agentId").GetString()!, polled.GetProperty("deviceToken").GetString()!);
    }

    // ---- SSE ----

    public async Task<string> StreamTicketAsync()
    {
        using var response = await PostAsync("/api/v1/identity/auth/stream-ticket");
        response.EnsureSuccessStatusCode();
        return IdentityApp.Cookies(response).Single(c => c.Name == "uo_st").Value;
    }

    public async Task<HttpResponseMessage> OpenEventsAsync(string? cookieTicket, string query = "")
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/tv/events{query}");
        if (cookieTicket is not null)
        {
            request.Headers.Add("Cookie", $"uo_st={cookieTicket}");
        }

        return await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, TestContext.Current.CancellationToken);
    }

    // ---- conversa com o agente falso ----

    public static JsonObject Ok() => new() { ["ok"] = true };

    public static JsonObject Failed(string code) =>
        new() { ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = "falhou" } };

    /// <summary>Lê o próximo comando que a API mandou ao agente falso.</summary>
    public static async Task<JsonElement> NextCommandAsync(FakeAgent agent) => (await agent.ReceiveAsync())!.Value;

    /// <summary>Responde o comando como o agente de verdade: <c>command.result.v1</c> apontando para o id dele.</summary>
    public static Task ReplyAsync(FakeAgent agent, JsonElement command, JsonObject? result = null) =>
        agent.SendTextAsync(agent.Envelope("command.result.v1", result ?? Ok(), command.GetProperty("id").GetGuid()));

    public static JsonObject StateBody(string power = "on", int? volume = 12, string? app = "com.exemplo.video", string connection = "hot") =>
        new()
        {
            ["power"] = power,
            ["volume"] = volume,
            ["app"] = app,
            ["connection"] = connection,
        };

    public static JsonObject AppsBody(params (string Package, string? Label)[] apps) =>
        new()
        {
            ["apps"] = new JsonArray([.. apps.Select(a => (JsonNode)new JsonObject { ["package"] = a.Package, ["label"] = a.Label })]),
            ["at"] = "2026-10-19T12:00:00Z",
        };

    // ---- esperas ----

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

    public static async Task WaitUntilAsync(Func<Task<bool>> condition, string what)
    {
        var deadline = DateTime.UtcNow + FakeAgent.Patience;
        while (DateTime.UtcNow < deadline)
        {
            if (await condition())
            {
                return;
            }

            await Task.Delay(25, TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"Condição não atingida a tempo: {what}.");
    }

    /// <summary>
    /// Anda o relógio falso em passos curtos até a condição valer: a gravação do estado espera alguns segundos no
    /// relógio injetado, e o temporizador só nasce depois que a mensagem do agente é tratada.
    /// </summary>
    public async Task AdvanceUntilAsync(Func<Task<bool>> condition, string what)
    {
        var deadline = DateTime.UtcNow + FakeAgent.Patience;
        while (DateTime.UtcNow < deadline)
        {
            if (await condition())
            {
                return;
            }

            Time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(25, TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"Condição não atingida a tempo: {what}.");
    }

    /// <summary>
    /// Deixa o relógio andar um pouco em passos curtos (cerca de um segundo real): o temporizador da gravação nasce em
    /// outra tarefa, depois da mensagem do agente, e um único salto grande poderia vir antes dele existir.
    /// </summary>
    public async Task SettleAsync()
    {
        for (var i = 0; i < 20; i++)
        {
            Time.Advance(TimeSpan.FromSeconds(2));
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
    }

    /// <summary>Anda o relógio enquanto a tarefa não termina (o prazo de espera do agente corre no relógio injetado).</summary>
    public async Task<T> AdvanceWhilePendingAsync<T>(Task<T> task)
    {
        var deadline = DateTime.UtcNow + FakeAgent.Patience;
        while (!task.IsCompleted)
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException("A requisição não terminou mesmo com o relógio andando.");
            }

            Time.Advance(TimeSpan.FromSeconds(10));
            await Task.Delay(25, TestContext.Current.CancellationToken);
        }

        return await task;
    }

    public async Task WaitForOutboxAsync(int expectedProcessed)
    {
        await WaitUntilAsync(async () =>
        {
            await using var db = Db();
            return await db.Set<OutboxMessage>().CountAsync(m => m.ProcessedAt != null, TestContext.Current.CancellationToken) >= expectedProcessed;
        }, $"outbox do Tv com {expectedProcessed} evento(s) entregue(s)");
    }

    /// <summary>
    /// Impressão de todas as tabelas do schema <c>tv</c> (contagem, maior <c>xmin</c> e hash do conteúdo). Qualquer
    /// INSERT, UPDATE ou DELETE muda a impressão.
    /// </summary>
    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "Nomes de tabela lidos do catálogo do próprio banco de teste.")]
    public async Task<string> TvFingerprintAsync(params string[] excludeTables)
    {
        await using var connection = new NpgsqlConnection(Database.OwnerConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);

        var tables = new List<string>();
        await using (var list = new NpgsqlCommand(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'tv' AND table_type = 'BASE TABLE' ORDER BY 1", connection))
        await using (var reader = await list.ExecuteReaderAsync(TestContext.Current.CancellationToken))
        {
            while (await reader.ReadAsync(TestContext.Current.CancellationToken))
            {
                tables.Add(reader.GetString(0));
            }
        }

        var parts = new List<string>();
        foreach (var table in tables.Where(t => !excludeTables.Contains(t, StringComparer.Ordinal)))
        {
            await using var command = new NpgsqlCommand(
                $"SELECT count(*), coalesce(max(t.xmin::text::bigint), 0), coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') FROM \"tv\".\"{table}\" t",
                connection);
            await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
            await reader.ReadAsync(TestContext.Current.CancellationToken);
            parts.Add($"{table}:{reader.GetInt64(0)}:{reader.GetInt64(1)}:{reader.GetString(2)}");
        }

        return string.Join('|', parts);
    }

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "SQL fixo do teste, sem texto de usuário.")]
    public async Task ExecuteSqlAsync(string sql)
    {
        await using var connection = new NpgsqlConnection(Database.OwnerConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _root.DisposeAsync();

        // Cada teste tem o seu banco e, portanto, os seus pools: fechá-los evita esgotar o max_connections do contêiner.
        NpgsqlConnection.ClearAllPools();
    }
}
