using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using UniOver.Modules.Devices.Features.Tokens;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Identity.Bootstrap;

namespace UniOver.IntegrationTests.Devices.Pairing;

internal sealed record DevicesAppOptions
{
    public string Environment { get; init; } = "Development";

    /// <summary><c>false</c> dispensa a passkey ao aprovar (só vale em Development); o padrão é o do appsettings.</summary>
    public bool? RequireStepUp { get; init; }

    public int? MaxActive { get; init; }

    public int? PairingPermitted { get; init; }

    public int? ExpiresMinutes { get; init; }

    public bool ForwardedHeaders { get; init; }

    public int? TokenCacheSeconds { get; init; }

    public int? TokenFailureLimit { get; init; }

    public DbCommandInterceptor? CommandInterceptor { get; init; }

    /// <summary>
    /// Graça de presença (segundos). Zero por padrão nos testes: a queda aparece na hora, que é o que quase todos
    /// conferem; os testes da graça pedem o valor que querem.
    /// </summary>
    public int PresenceGraceSeconds { get; init; }
}

internal sealed record Started(Guid PairingId, string DeviceCode, string UserCode, JsonElement Body);

/// <summary>
/// Host real contra Postgres real, com os dois módulos migrados (Identity para o login e a passkey, Devices para o
/// pareamento), relógio falso e captura de log. As rotas de pareamento são exercitadas por HTTP, como o agente e
/// o app fariam.
/// </summary>
internal sealed class DevicesApp : IAsyncDisposable
{
    /// <summary>Aprovar pareamento exige a mesma confirmação de criar uma TV.</summary>
    public const string ApproveAction = "tv.bind-agent";

    private readonly EdgeFactory _root;
    private readonly WebApplicationFactory<Program> _factory;

    private DevicesApp(
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
    }

    public TestDatabase Database { get; }

    public FakeTimeProvider Time { get; }

    public CapturingLoggerProvider Logs { get; }

    public string OwnerEmail { get; }

    public string OwnerPassword { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _factory.Services;

    public static async Task<DevicesApp> StartAsync(PostgresFixture postgres, DevicesAppOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);
        options ??= new DevicesAppOptions();

        var database = await postgres.CreateDatabaseAsync();
        await using (var identity = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await identity.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        await using (var devices = CreateContext(database.OwnerConnection))
        {
            await devices.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        // A aprovação com "Para quem" cria a TV no mesmo commit, então o schema do módulo TV precisa existir.
        await using (var tv = Tv.TvApp.CreateContext(database.OwnerConnection))
        {
            await tv.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        var password = IdentityApp.NewPassword();
        var ownerEmail = "dono@uniover.test";
        var time = new FakeTimeProvider(
            new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond, TimeSpan.Zero));
        var logs = new CapturingLoggerProvider();

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = IdentityApp.NewKey(),
            ["Modules:Identity:Passkeys:RpId"] = "localhost",
            ["Modules:Identity:Passkeys:Origins:0"] = "https://localhost",
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["RateLimiting:pairing:Permitted"] = (options.PairingPermitted ?? 100000).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Logging:LogLevel:Default"] = "Debug",
            ["Modules:Devices:Transport:PresenceGraceSeconds"] = options.PresenceGraceSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["ForwardedHeaders:Enabled"] = options.ForwardedHeaders ? "true" : "false",
            ["UNIOVER_OWNER_EMAIL"] = ownerEmail,
            ["UNIOVER_OWNER_PASSWORD"] = password,
        };
        if (options.RequireStepUp is { } require)
        {
            settings["Modules:Devices:Pairing:RequireStepUp"] = require ? "true" : "false";
        }

        if (options.MaxActive is { } max)
        {
            settings["Modules:Devices:Pairing:MaxActive"] = max.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (options.ExpiresMinutes is { } minutes)
        {
            settings["Modules:Devices:Pairing:ExpiresMinutes"] = minutes.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (options.TokenFailureLimit is { } failureLimit)
        {
            settings["Modules:Devices:TokenFailureLimit"] = failureLimit.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (options.TokenCacheSeconds is { } cache)
        {
            settings["Modules:Devices:TokenCacheSeconds"] = cache.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        var root = new EdgeFactory(options.Environment, settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(time);
            services.AddSingleton<ILoggerProvider>(logs);
            if (options.CommandInterceptor is { } commandInterceptor)
            {
                services.ConfigureDbContext<DevicesDbContext>(builder => builder.AddInterceptors(commandInterceptor));
            }
        }));

        var app = new DevicesApp(root, factory, database, time, logs, ownerEmail, password);
        await factory.Services.GetRequiredService<OwnerBootstrapService>().Completion;
        return app;
    }

    public static DevicesDbContext CreateContext(string connection)
    {
        var builder = new DbContextOptionsBuilder<DevicesDbContext>();
        ModuleDatabase.Configure(builder, connection, DevicesDbContext.SchemaName, typeof(DevicesDbContext).Assembly);
        return new DevicesDbContext(builder.Options);
    }

    /// <summary>Contexto com o papel dono, só para o teste inspecionar o banco.</summary>
    public DevicesDbContext Db() => CreateContext(Database.OwnerConnection);

    public async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string url, object? body = null, string? bearer = null, string? forwardedFor = null, string? userAgent = null,
        Guid? idempotencyKey = null)
    {
        using var request = new HttpRequestMessage(method, url);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }

        if (forwardedFor is not null)
        {
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        }

        if (userAgent is not null)
        {
            request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        }

        if (method == HttpMethod.Post || method == HttpMethod.Put || method == HttpMethod.Patch || method == HttpMethod.Delete)
        {
            request.Headers.Add("Idempotency-Key", (idempotencyKey ?? Guid.NewGuid()).ToString());
        }

        return await Client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    public async Task<LoggedIn> LoginAsync()
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

    public static Task<JsonElement> JsonAsync(HttpResponseMessage response) => IdentityApp.JsonAsync(response);

    // ---- convidado que pareia a própria TV ----

    /// <summary>Ação que o convidado confirma com a senha para aprovar a própria TV.</summary>
    public const string PairSelfAction = "devices.pair-self";

    /// <summary>Convidado novo, ativo, com as permissões dadas (padrão: só ver a TV).</summary>
    public Task<GuestSession> NewGuestAsync(IReadOnlyCollection<string>? permissions = null, string label = "Raphael") =>
        GuestSeed.CreateGuestAsync(Client, Database, Time.GetUtcNow(), label, permissions ?? ["module:tv"]);

    /// <summary>Entra de novo com o e-mail e a senha do convidado: uma sessão nova, sem nenhuma confirmação.</summary>
    public async Task<LoggedIn> LoginAsync(GuestSession guest)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/identity/auth/login")
        {
            Content = JsonContent.Create(new { email = guest.Email, password = guest.Password }),
        };
        request.Headers.Add(IdentityApp.ClientHeader, "web");
        using var response = await Client.SendAsync(request, TestContext.Current.CancellationToken);
        return await GuestSeed.ReadLoginAsync(response);
    }

    /// <summary>Reconfirma a ação com a senha (o passo forte do convidado, que não tem passkey).</summary>
    public Task<HttpResponseMessage> ConfirmWithPasswordRawAsync(LoggedIn login, string password, string action = PairSelfAction) =>
        SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/password", new { action, password }, login.AccessToken);

    public async Task ConfirmWithPasswordAsync(GuestSession guest, string action = PairSelfAction)
    {
        using var response = await ConfirmWithPasswordRawAsync(guest.Login, guest.Password, action);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
    }

    /// <summary>Aprova pela rota do convidado (corpo livre, para testar o que sobra e o que é ignorado).</summary>
    public Task<HttpResponseMessage> ApproveOwnRawAsync(LoggedIn? login, object body) =>
        SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/approve-own", body, login?.AccessToken);

    public Task<HttpResponseMessage> ListAgentsRawAsync(LoggedIn? login) =>
        SendAsync(HttpMethod.Get, "/api/v1/devices/agents", null, login?.AccessToken);

    // ---- pareamento ----

    public async Task<Started> StartAsync(
        string agentName = "PC Casa", string platform = "windows", string agentVersion = "0.1.0",
        string? forwardedFor = null, string? userAgent = null)
    {
        using var response = await SendAsync(
            HttpMethod.Post, "/api/v1/devices/pairing/start", new { agentName, platform, agentVersion },
            forwardedFor: forwardedFor, userAgent: userAgent);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var body = await JsonAsync(response);
        return new Started(
            body.GetProperty("pairingId").GetGuid(),
            body.GetProperty("deviceCode").GetString()!,
            body.GetProperty("userCode").GetString()!,
            body);
    }

    public Task<HttpResponseMessage> PollRawAsync(Guid pairingId, string deviceCode) =>
        SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/poll", new { pairingId, deviceCode });

    public Task<HttpResponseMessage> ApproveRawAsync(LoggedIn? login, string userCode, string? name = null, string? forwardedFor = null) =>
        SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode, name }, login?.AccessToken, forwardedFor);

    /// <summary>Aprova pedindo também a TV: <paramref name="tvMemberIds"/> (mesmo vazio) liga o computador a uma TV nova.</summary>
    public Task<HttpResponseMessage> ApproveWithTvRawAsync(
        LoggedIn? login, string userCode, IReadOnlyList<Guid> tvMemberIds, string? name = null, string? tvName = null) =>
        SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/approve", new { userCode, name, tvName, tvMemberIds }, login?.AccessToken);

    public Task<HttpResponseMessage> DenyRawAsync(LoggedIn? login, string userCode) =>
        SendAsync(HttpMethod.Post, "/api/v1/devices/pairing/deny", new { userCode }, login?.AccessToken);

    public Task<HttpResponseMessage> RevokeRawAsync(LoggedIn? login, Guid agentId, string? reason = null, string? forwardedFor = null) =>
        SendAsync(HttpMethod.Post, $"/api/v1/devices/agents/{agentId}/revoke", reason is null ? new { } : new { reason }, login?.AccessToken, forwardedFor);

    /// <summary>Aprova e devolve o corpo (200 esperado). Só vale quando a passkey não é exigida ou já foi confirmada.</summary>
    public async Task<JsonElement> ApproveAsync(LoggedIn login, string userCode, string? name = null)
    {
        using var response = await ApproveRawAsync(login, userCode, name);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        return await JsonAsync(response);
    }

    /// <summary>Fluxo completo até o token: start, aprovação e a consulta aprovada. Devolve (id do agente, slug, token).</summary>
    public async Task<(Guid AgentId, string Slug, string Token, Started Started)> PairAsync(LoggedIn login, string name = "PC Casa")
    {
        var started = await StartAsync(name);
        var agent = await ApproveAsync(login, started.UserCode);
        using var poll = await PollRawAsync(started.PairingId, started.DeviceCode);
        poll.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var body = await JsonAsync(poll);
        body.GetProperty("status").GetString().Should().Be("approved");
        return (agent.GetProperty("id").GetGuid(), body.GetProperty("agentId").GetString()!, body.GetProperty("deviceToken").GetString()!, started);
    }

    public async Task<DeviceTokenValidation> ValidateAsync(string? token)
    {
        using var scope = Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<IDeviceTokenValidator>()
            .ValidateAsync(token, TestContext.Current.CancellationToken);
    }

    // ---- passkey (confirmação da aprovação) ----

    public async Task RegisterPasskeyAsync(LoggedIn login, VirtualAuthenticator authenticator)
    {
        using var begin = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = OwnerPassword }, login.AccessToken);
        begin.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var opened = await JsonAsync(begin);
        var challengeId = opened.GetProperty("challengeId").GetGuid();

        using var done = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/complete",
            new { challengeId, name = "teste", credential = authenticator.CreateAttestation(opened.GetProperty("options")) },
            login.AccessToken);
        done.StatusCode.Should().Be(System.Net.HttpStatusCode.Created);
    }

    /// <summary>Confirma a ação de aprovar pareamento com a passkey virtual (vale alguns minutos nesta sessão).</summary>
    public Task ConfirmApproveAsync(LoggedIn login, VirtualAuthenticator authenticator) =>
        ConfirmStepUpAsync(login, authenticator, ApproveAction);

    /// <summary>Confirma uma ação perigosa qualquer com a passkey virtual (vale alguns minutos nesta sessão).</summary>
    public async Task ConfirmStepUpAsync(LoggedIn login, VirtualAuthenticator authenticator, string action)
    {
        using var begin = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/options", new { action }, login.AccessToken);
        begin.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var opened = await JsonAsync(begin);

        using var done = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/step-up/complete",
            new { challengeId = opened.GetProperty("challengeId").GetGuid(), credential = authenticator.CreateAssertion(opened.GetProperty("options")) },
            login.AccessToken);
        done.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
    }

    /// <summary>Espera a outbox do módulo esvaziar (o despachante acorda por sinal); falha se passar do prazo.</summary>
    public async Task WaitForOutboxAsync(int expectedProcessed)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            await using var db = Db();
            var processed = await db.Set<UniOver.BuildingBlocks.Messaging.OutboxMessage>()
                .CountAsync(m => m.ProcessedAt != null, TestContext.Current.CancellationToken);
            if (processed >= expectedProcessed)
            {
                return;
            }

            await Task.Delay(100, TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"A outbox não entregou {expectedProcessed} evento(s) a tempo.");
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _root.DisposeAsync();

        // Cada teste tem o seu banco e, portanto, os seus pools: fechá-los evita esgotar o max_connections do contêiner.
        NpgsqlConnection.ClearAllPools();
    }
}
