using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.IntegrationTests.Identity.Passkeys;

internal sealed record PasskeyAppOptions
{
    public string Environment { get; init; } = "Development";

    /// <summary>Validade da confirmação em minutos; o teste de expiração usa um valor pequeno.</summary>
    public int? StepUpMinutes { get; init; }

    public bool PasskeyConfiguration { get; init; } = true;

    public DbCommandInterceptor? CommandInterceptor { get; init; }

    public IReadOnlyDictionary<string, string?>? Extra { get; init; }
}

/// <summary>
/// Host real contra Postgres real, com relógio falso e rotas de teste que usam a política de confirmação como
/// outro módulo usaria: só pelo helper do BuildingBlocks, sem tocar no interior do Identity. O <c>IdentityApp</c>
/// não aceita rotas extras, por isso este arranjo próprio reaproveita as mesmas peças (fábrica, banco, relógio).
/// </summary>
internal sealed class PasskeyApp : IAsyncDisposable
{
    public const string DangerousRoute = "/api/test/dangerous";
    public const string OtherDangerousRoute = "/api/test/other-dangerous";
    public const string DangerousAction = "teste.acao";
    public const string OtherAction = "teste.outra";
    public const string TvControlRoute = "/api/test/permission/tv-control";
    public const string TvEditShortcutsRoute = "/api/test/permission/tv-edit-shortcuts";
    public const string TrainingRoute = "/api/test/permission/training";

    private readonly EdgeFactory _root;
    private readonly WebApplicationFactory<Program> _factory;

    private PasskeyApp(EdgeFactory root, WebApplicationFactory<Program> factory, TestDatabase database,
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

    /// <summary>A chave com que o servidor assina os tokens, para fabricar um token como um atacante com a chave faria.</summary>
    public string SigningKey { get; private init; } = string.Empty;

    public static async Task<PasskeyApp> StartAsync(PostgresFixture postgres, PasskeyAppOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);
        options ??= new PasskeyAppOptions();

        var database = await postgres.CreateDatabaseAsync();
        await using (var context = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await context.Database.MigrateAsync(TestContext.Current.CancellationToken);
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
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["Logging:LogLevel:Default"] = "Debug",
            ["UNIOVER_OWNER_EMAIL"] = ownerEmail,
            ["UNIOVER_OWNER_PASSWORD"] = password,
        };
        if (options.PasskeyConfiguration)
        {
            settings["Modules:Identity:Passkeys:RpId"] = "localhost";
            settings["Modules:Identity:Passkeys:Origins:0"] = "https://localhost";
        }

        if (options.StepUpMinutes is { } minutes)
        {
            settings["Modules:Identity:StepUp:Minutes"] = minutes.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        foreach (var (name, value) in options.Extra ?? new Dictionary<string, string?>())
        {
            settings[name] = value;
        }

        var root = new EdgeFactory(options.Environment, settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(time);
            services.AddSingleton<ILoggerProvider>(logs);
            services.AddSingleton<IStartupFilter, TestRoutesFilter>();
            if (options.CommandInterceptor is { } commandInterceptor)
            {
                services.ConfigureDbContext<IdentityDbContext>(builder => builder.AddInterceptors(commandInterceptor));
            }
        }));

        var app = new PasskeyApp(root, factory, database, time, logs, ownerEmail, password) { SigningKey = signingKey };
        await factory.Services.GetRequiredService<OwnerBootstrapService>().Completion;
        return app;
    }

    /// <summary>Contexto com o papel dono, só para o teste inspecionar o banco.</summary>
    public IdentityDbContext Db() => IdentityApp.CreateContext(Database.OwnerConnection);

    public async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string url, object? body = null, string? bearer = null, Guid? idempotencyKey = null)
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

    public static async Task<JsonElement> JsonAsync(HttpResponseMessage response) => await IdentityApp.JsonAsync(response);

    /// <summary>Pede as opções de cadastro com a senha certa e devolve (desafio, opções).</summary>
    public async Task<(Guid ChallengeId, JsonElement Options)> BeginRegistrationAsync(LoggedIn login, string? password = null)
    {
        using var response = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = password ?? OwnerPassword }, login.AccessToken);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var body = await JsonAsync(response);
        return (body.GetProperty("challengeId").GetGuid(), body.GetProperty("options"));
    }

    public Task<HttpResponseMessage> CompleteRegistrationRawAsync(
        LoggedIn login, Guid challengeId, object credential, string? name = null) =>
        SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/complete", new { challengeId, name, credential }, login.AccessToken);

    /// <summary>Cadastro completo com sucesso; devolve o corpo da resposta (201).</summary>
    public async Task<JsonElement> RegisterAsync(LoggedIn login, VirtualAuthenticator authenticator, string? name = null)
    {
        var (challengeId, options) = await BeginRegistrationAsync(login);
        using var response = await CompleteRegistrationRawAsync(login, challengeId, authenticator.CreateAttestation(options), name);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.Created);
        return await JsonAsync(response);
    }

    public async Task<(Guid ChallengeId, JsonElement Options)> BeginStepUpAsync(LoggedIn login, string action)
    {
        using var response = await SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/options", new { action }, login.AccessToken);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var body = await JsonAsync(response);
        return (body.GetProperty("challengeId").GetGuid(), body.GetProperty("options"));
    }

    public Task<HttpResponseMessage> CompleteStepUpRawAsync(LoggedIn login, Guid challengeId, object credential) =>
        SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/complete", new { challengeId, credential }, login.AccessToken);

    /// <summary>Confirmação completa (opções e resposta do autenticador); devolve a resposta final do servidor.</summary>
    public async Task<HttpResponseMessage> ConfirmAsync(LoggedIn login, VirtualAuthenticator authenticator, string action)
    {
        var (challengeId, options) = await BeginStepUpAsync(login, action);
        return await CompleteStepUpRawAsync(login, challengeId, authenticator.CreateAssertion(options));
    }

    public Task<HttpResponseMessage> CallDangerousAsync(LoggedIn login, string route = DangerousRoute) =>
        SendAsync(HttpMethod.Post, route, bearer: login.AccessToken);

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _root.DisposeAsync();

        // Cada teste tem o seu banco e, portanto, os seus pools: fechá-los evita esgotar o max_connections do contêiner.
        NpgsqlConnection.ClearAllPools();
    }

    private sealed class TestRoutesFilter : IStartupFilter
    {
        private const string RouteBuilderKey = "__EndpointRouteBuilder";

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);

            var routes = (IEndpointRouteBuilder)app.Properties[RouteBuilderKey]!;
            routes.MapPost(DangerousRoute, () => Results.Ok("feito")).RequireAuthorization(StepUp.Policy(DangerousAction));
            routes.MapPost(OtherDangerousRoute, () => Results.Ok("feito")).RequireAuthorization(StepUp.Policy(OtherAction));

            // Rotas de módulo fictícias: usam a política por permissão do jeito que a TV e o Treino vão usar (só pelo
            // helper do BuildingBlocks), para provar o motor de autorização sem tocar em rota de outro módulo.
            routes.MapGet(TvControlRoute, () => Results.Ok("ok")).RequireAuthorization(AccessPermissions.Policy(AccessPermissions.TvControl));
            routes.MapGet(TvEditShortcutsRoute, () => Results.Ok("ok")).RequireAuthorization(AccessPermissions.Policy(AccessPermissions.TvEditShortcuts));
            routes.MapGet(TrainingRoute, () => Results.Ok("ok")).RequireAuthorization(AccessPermissions.Policy(AccessPermissions.TrainingModule));
        };
    }
}
