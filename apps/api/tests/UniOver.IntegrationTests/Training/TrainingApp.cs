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
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.IntegrationTests.Training;

internal sealed record TrainingAppOptions
{
    public string Environment { get; init; } = "Development";

    /// <summary><c>false</c> deixa o schema <c>training</c> sem migrar: prova que a partida não toca no módulo.</summary>
    public bool MigrateTraining { get; init; } = true;

    public int CommandsPermitted { get; init; } = 100000;

    /// <summary>Cliente do wger de mentira no lugar do HTTP real.</summary>
    public IWgerClient? Wger { get; init; }

    public IOffClient? Off { get; init; }

    public bool PhotoStorageEnabled { get; init; }

    public IProgressPhotoObjectStore? Photos { get; init; }

    public long? PhotoMaxAccountBytes { get; init; }

    public int? PhotoMaxAccountPhotos { get; init; }

    public string? OffContact { get; init; }

    public int MaxItems { get; init; } = 1000;

    public int PageSize { get; init; } = 50;

    /// <summary>Registra o SQL do EF no log capturado (para provar quando o módulo consulta o banco).</summary>
    public bool CaptureSql { get; init; }

    /// <summary>
    /// Relógio falso no lugar do relógio do sistema (<see cref="TrainingApp.Time"/>), para os testes que andam o tempo
    /// (o cache curto das permissões). Desligado por padrão: os testes de dados do Treino usam o relógio de verdade.
    /// </summary>
    public bool FakeClock { get; init; }

    /// <summary>
    /// Interceptador de comandos SQL do <see cref="TrainingDbContext"/> da aplicação: os testes de corrida o usam para
    /// parar um pedido num ponto exato (entre dois comandos) e deixar outro passar, sem espera fixa.
    /// </summary>
    public DbCommandInterceptor? CommandInterceptor { get; init; }
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
        string ownerEmail, string ownerPassword, FakeTimeProvider? time)
    {
        _root = root;
        _factory = factory;
        Database = database;
        Logs = logs;
        Time = time;
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

    /// <summary>O relógio falso, só quando <see cref="TrainingAppOptions.FakeClock"/> está ligado.</summary>
    public FakeTimeProvider? Time { get; }

    public CapturingLoggerProvider Logs { get; }

    public string OwnerEmail { get; }

    public string OwnerPassword { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _factory.Services;

    /// <summary>
    /// Liga o armazenamento privado das fotos de progresso com credenciais sintéticas. As rotas das fotos só existem
    /// quando a configuração as liga, então as varreduras que olham o Treino inteiro precisam deste ajuste.
    /// </summary>
    public static void EnablePhotoStorage(IDictionary<string, string?> settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        settings["Modules:Training:Photos:Storage:Enabled"] = "true";
        settings["Modules:Training:Photos:Storage:ServiceUrl"] = "https://objects.example.test";
        settings["Modules:Training:Photos:Storage:Bucket"] = "private-test";
        settings["Modules:Training:Photos:Storage:AccessKey"] = "synthetic-access";
        settings["Modules:Training:Photos:Storage:SecretKey"] = "synthetic-secret";
    }

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
        var time = options.FakeClock
            ? new FakeTimeProvider(
                new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond, TimeSpan.Zero))
            : null;

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
        if (options.OffContact is not null) settings["TRAINING_OFF_CONTACT"] = options.OffContact;
        if (options.PhotoStorageEnabled) EnablePhotoStorage(settings);
        if (options.PhotoMaxAccountBytes is { } maxAccountBytes)
            settings["Modules:Training:Photos:MaxAccountBytes"] = maxAccountBytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (options.PhotoMaxAccountPhotos is { } maxAccountPhotos)
            settings["Modules:Training:Photos:MaxAccountPhotos"] = maxAccountPhotos.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (options.CaptureSql)
        {
            settings["Logging:LogLevel:Microsoft.EntityFrameworkCore.Database.Command"] = "Information";
        }

        var root = new EdgeFactory(options.Environment, settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<ILoggerProvider>(logs);
            if (time is not null)
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(time);
            }

            if (options.Wger is { } wger)
            {
                services.RemoveAll<IWgerClient>();
                services.AddSingleton(wger);
            }

            if (options.Off is { } off)
            {
                services.RemoveAll<IOffClient>();
                services.AddSingleton(off);
            }

            if (options.CommandInterceptor is { } commandInterceptor)
            {
                services.ConfigureDbContext<TrainingDbContext>(builder => builder.AddInterceptors(commandInterceptor));
            }

            if (options.Photos is { } photos)
            {
                services.RemoveAll<IProgressPhotoObjectStore>();
                services.AddSingleton(photos);
                services.AddSingleton<IProgressPhotoObjectStore>(photos);
            }
        }));

        var app = new TrainingApp(root, factory, database, logs, ownerEmail, password, time);
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

    /// <summary>
    /// Pessoa convidada nova com as permissões dadas (convite gravado direto no banco, aceite pelo HTTP de verdade). Cada
    /// uma aceita vinda de um IP próprio: o limite do aceite é por IP, e uma matriz de testes cria várias pessoas.
    /// </summary>
    public async Task<GuestSession> NewGuestAsync(string label, IReadOnlyCollection<string>? permissions, int ipSuffix)
    {
        var (_, token) = await GuestSeed.InsertInviteAsync(
            Database, Time?.GetUtcNow() ?? DateTimeOffset.UtcNow, label, permissions: permissions);
        return await AcceptInviteAsync(token, ipSuffix);
    }

    /// <summary>Aceita um convite (o segredo do link) com e-mail e senha novos e devolve a sessão da pessoa.</summary>
    public async Task<GuestSession> AcceptInviteAsync(string inviteToken, int ipSuffix)
    {
        var email = GuestSeed.NewEmail();
        var password = GuestSeed.NewPassword();
        using var response = await GuestSeed.AcceptAsync(
            Client, inviteToken, email, password, forwardedFor: $"203.0.113.{ipSuffix}");
        var login = await GuestSeed.ReadLoginAsync(response);

        await using var identity = IdentityApp.CreateContext(Database.OwnerConnection);
        var user = await identity.Users.SingleAsync(u => u.Email == email, TestContext.Current.CancellationToken);
        return new GuestSession(user.Id, email, password, login);
    }

    /// <summary>Cadastra a passkey do administrador num autenticador virtual (pré-requisito das ações que pedem confirmação).</summary>
    public async Task RegisterPasskeyAsync(LoggedIn owner, VirtualAuthenticator authenticator)
    {
        using var options = await SendAsync(
            HttpMethod.Post, "/api/v1/identity/passkeys/registration/options", new { password = OwnerPassword }, owner.AccessToken);
        options.EnsureSuccessStatusCode();
        var body = await JsonAsync(options);

        using var complete = await SendAsync(
            HttpMethod.Post,
            "/api/v1/identity/passkeys/registration/complete",
            new
            {
                challengeId = body.GetProperty("challengeId").GetGuid(),
                name = "teste",
                credential = authenticator.CreateAttestation(body.GetProperty("options")),
            },
            owner.AccessToken);
        complete.EnsureSuccessStatusCode();
    }

    /// <summary>Confirmação por passkey de uma ação do administrador (vale por poucos minutos e só para essa ação).</summary>
    public async Task ConfirmAsync(LoggedIn owner, VirtualAuthenticator authenticator, string action)
    {
        using var options = await SendAsync(HttpMethod.Post, "/api/v1/identity/step-up/options", new { action }, owner.AccessToken);
        options.EnsureSuccessStatusCode();
        var body = await JsonAsync(options);

        using var complete = await SendAsync(
            HttpMethod.Post,
            "/api/v1/identity/step-up/complete",
            new
            {
                challengeId = body.GetProperty("challengeId").GetGuid(),
                credential = authenticator.CreateAssertion(body.GetProperty("options")),
            },
            owner.AccessToken);
        complete.EnsureSuccessStatusCode();
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
