using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports;

namespace UniOver.IntegrationTests.Training;

internal sealed record TrainingAppOptions
{
    public string Environment { get; init; } = "Development";

    /// <summary><c>false</c> deixa o schema <c>training</c> sem migrar: prova que a partida não toca no módulo.</summary>
    public bool MigrateTraining { get; init; } = true;

    public int CommandsPermitted { get; init; } = 100000;

    /// <summary>Cliente do wger de mentira no lugar do HTTP real.</summary>
    public IWgerClient? Wger { get; init; }

    public int MaxItems { get; init; } = 1000;

    public int PageSize { get; init; } = 50;

    /// <summary>Registra o SQL do EF no log capturado (para provar quando o módulo consulta o banco).</summary>
    public bool CaptureSql { get; init; }
}

/// <summary>
/// Host real contra Postgres real, com Identity (login) e Training migrados, como o app vai para o ar. O papel
/// <i>runtime</i> sem DDL é o que a aplicação usa; o papel dono só serve ao teste para inspecionar o banco.
/// </summary>
internal sealed class TrainingApp : IAsyncDisposable
{
    private readonly EdgeFactory _root;
    private readonly WebApplicationFactory<Program> _factory;

    private TrainingApp(
        EdgeFactory root, WebApplicationFactory<Program> factory, TestDatabase database, CapturingLoggerProvider logs,
        string ownerEmail, string ownerPassword)
    {
        _root = root;
        _factory = factory;
        Database = database;
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

    public CapturingLoggerProvider Logs { get; }

    public string OwnerEmail { get; }

    public string OwnerPassword { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _factory.Services;

    public static async Task<TrainingApp> StartAsync(PostgresFixture postgres, TrainingAppOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);
        options ??= new TrainingAppOptions();

        var database = await postgres.CreateDatabaseAsync();
        await using (var identity = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await identity.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        // O despachante da outbox do Devices varre o schema dele na partida; migrado, a partida fica sem ruído de erro.
        await using (var devices = DevicesApp.CreateContext(database.OwnerConnection))
        {
            await devices.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        if (options.MigrateTraining)
        {
            await using var training = CreateContext(database.OwnerConnection);
            await training.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        var password = IdentityApp.NewPassword();
        var ownerEmail = "dono@uniover.test";
        var logs = new CapturingLoggerProvider();

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = IdentityApp.NewKey(),
            ["Modules:Identity:Passkeys:RpId"] = "localhost",
            ["Modules:Identity:Passkeys:Origins:0"] = "https://localhost",
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["RateLimiting:commands:Permitted"] = options.CommandsPermitted.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Modules:Training:Import:Wger:DelayMs"] = "0",
            ["Modules:Training:Import:Wger:MaxItems"] = options.MaxItems.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Modules:Training:Import:Wger:PageSize"] = options.PageSize.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["UNIOVER_OWNER_EMAIL"] = ownerEmail,
            ["UNIOVER_OWNER_PASSWORD"] = password,
        };
        if (options.CaptureSql)
        {
            settings["Logging:LogLevel:Microsoft.EntityFrameworkCore.Database.Command"] = "Information";
        }

        var root = new EdgeFactory(options.Environment, settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<ILoggerProvider>(logs);
            if (options.Wger is { } wger)
            {
                services.RemoveAll<IWgerClient>();
                services.AddSingleton(wger);
            }
        }));

        var app = new TrainingApp(root, factory, database, logs, ownerEmail, password);
        await factory.Services.GetRequiredService<OwnerBootstrapService>().Completion;
        return app;
    }

    public static TrainingDbContext CreateContext(string connection)
    {
        var builder = new DbContextOptionsBuilder<TrainingDbContext>();
        ModuleDatabase.Configure(builder, connection, TrainingDbContext.SchemaName, typeof(TrainingDbContext).Assembly);
        return new TrainingDbContext(builder.Options);
    }

    /// <summary>Contexto com o papel dono, só para o teste inspecionar o banco.</summary>
    public TrainingDbContext Db() => CreateContext(Database.OwnerConnection);

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

    /// <summary>Id do usuário dono da conta de teste (a claim <c>sub</c> do token).</summary>
    public static Guid UserIdOf(LoggedIn login)
    {
        ArgumentNullException.ThrowIfNull(login);
        var payload = login.AccessToken.Split('.')[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
        using var json = JsonDocument.Parse(Convert.FromBase64String(payload));
        return Guid.Parse(json.RootElement.GetProperty("sub").GetString()!);
    }

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

        if (idempotencyKey is { } key)
        {
            request.Headers.Add("Idempotency-Key", key.ToString());
        }

        return await Client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    public static Task<JsonElement> JsonAsync(HttpResponseMessage response) => IdentityApp.JsonAsync(response);

    /// <summary>Corpo padrão de um exercício próprio; cada teste troca só o que importa.</summary>
    public static object CustomBody(
        DateTimeOffset clientUpdatedAt, string name = "Meu supino", bool deleted = false, decimal? stepKg = 2.5m, string[]? instructions = null) =>
        new
        {
            name,
            primaryMuscles = new[] { "chest" },
            secondaryMuscles = new[] { "triceps" },
            equipment = "barbell",
            recordType = "weight_reps",
            stepKg,
            instructions = instructions ?? ["Deite no banco."],
            clientUpdatedAt,
            deleted,
        };

    public Task<HttpResponseMessage> PutCustomAsync(LoggedIn? login, Guid id, object body, Guid? key = null) =>
        SendAsync(HttpMethod.Put, $"/api/v1/training/exercises/{id}", body, login?.AccessToken, key ?? Guid.NewGuid());

    public Task<HttpResponseMessage> PullAsync(LoggedIn? login, string? after = null, int? limit = null)
    {
        var query = new List<string>();
        if (after is not null)
        {
            query.Add("after=" + Uri.EscapeDataString(after));
        }

        if (limit is not null)
        {
            query.Add("limit=" + limit);
        }

        var url = "/api/v1/training/exercises" + (query.Count > 0 ? "?" + string.Join('&', query) : string.Empty);
        return SendAsync(HttpMethod.Get, url, bearer: login?.AccessToken);
    }

    /// <summary>Lê todas as páginas (até esgotar) e devolve cada página como veio, em ordem.</summary>
    public async Task<List<JsonElement>> PullAllPagesAsync(LoggedIn login, int limit)
    {
        var pages = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            using var response = await PullAsync(login, cursor, limit);
            response.EnsureSuccessStatusCode();
            var page = await JsonAsync(response);
            pages.Add(page.Clone());
            var items = page.GetProperty("items").GetArrayLength();
            var next = page.GetProperty("nextCursor").GetString();
            if (items == 0 || next is null || next == cursor)
            {
                return pages;
            }

            cursor = next;
        }

        throw new InvalidOperationException("A leitura incremental não terminou.");
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _root.DisposeAsync();

        // Cada teste tem o seu banco e, portanto, os seus pools: fechá-los evita esgotar o max_connections do contêiner.
        NpgsqlConnection.ClearAllPools();
    }
}

internal static class TrainingAssertions
{
    public static HttpResponseMessage ShouldBe(this HttpResponseMessage response, System.Net.HttpStatusCode status)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.StatusCode.Should().Be(status);
        return response;
    }

    public static async Task<string> ProblemTypeAsync(HttpResponseMessage response)
    {
        var body = await TrainingApp.JsonAsync(response);
        return body.GetProperty("type").GetString()!;
    }
}
