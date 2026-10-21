using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using UniOver.Modules.Identity.Bootstrap;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.IntegrationTests.Identity;

/// <summary>Tudo que muda de um teste para outro; o padrão é um app migrado, com o dono semeado.</summary>
internal sealed record IdentityAppOptions
{
    /// <summary>Reaproveita o banco de uma instância anterior (simula reinício do processo).</summary>
    public TestDatabase? Database { get; init; }

    public bool Migrate { get; init; } = true;

    public DateTimeOffset? Start { get; init; }

    public string? SigningKey { get; init; }

    public string? PreviousSigningKey { get; init; }

    public string? OwnerEmail { get; init; } = "dono@uniover.test";

    public string? OwnerPassword { get; init; }

    public bool ForwardedHeaders { get; init; }

    public IReadOnlyDictionary<string, string?>? Extra { get; init; }
}

/// <summary>Cookie de uma resposta, com os atributos em minúsculas para comparar sem depender da caixa.</summary>
internal sealed record ParsedCookie(string Name, string Value, IReadOnlyDictionary<string, string?> Attributes, string Raw)
{
    public bool Has(string attribute) => Attributes.ContainsKey(attribute);

    public string? Get(string attribute) => Attributes.TryGetValue(attribute, out var value) ? value : null;

    public bool IsDeletion => Value.Length == 0 || (Get("expires") is { } e && DateTimeOffset.Parse(e, System.Globalization.CultureInfo.InvariantCulture) < DateTimeOffset.UtcNow.AddYears(-1));
}

internal sealed record LoggedIn(string AccessToken, string RefreshSecret, ParsedCookie RefreshCookie, JsonElement Body);

/// <summary>
/// Host real contra um Postgres real (Testcontainers), com relógio falso, captura de log e rotas de teste.
/// Os cookies são tratados à mão: assim os atributos do Set-Cookie são conferidos como saem do servidor e cada
/// teste escolhe exatamente que cookie envia a cada rota.
/// </summary>
internal sealed class IdentityApp : IAsyncDisposable
{
    public const string ClientHeader = "X-UniOver-Client";

    private readonly EdgeFactory _root;
    private readonly WebApplicationFactory<Program> _factory;

    private IdentityApp(
        EdgeFactory root,
        WebApplicationFactory<Program> factory,
        TestDatabase database,
        FakeTimeProvider time,
        CapturingLoggerProvider logs,
        string signingKey,
        string ownerEmail,
        string ownerPassword)
    {
        _root = root;
        _factory = factory;
        Database = database;
        Time = time;
        Logs = logs;
        SigningKey = signingKey;
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

    public string SigningKey { get; }

    public string OwnerEmail { get; }

    public string OwnerPassword { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _factory.Services;

    public static string NewKey() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    public static string NewPassword() => "pw-" + Guid.NewGuid().ToString("N");

    public static async Task<IdentityApp> StartAsync(PostgresFixture postgres, IdentityAppOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);
        options ??= new IdentityAppOptions();

        var database = options.Database ?? await postgres.CreateDatabaseAsync();
        if (options.Migrate && options.Database is null)
        {
            await using var context = CreateContext(database.OwnerConnection);
            await context.Database.MigrateAsync(TestContext.Current.CancellationToken);
        }

        var key = options.SigningKey ?? NewKey();
        var password = options.OwnerPassword ?? NewPassword();
        var start = options.Start ?? new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var logs = new CapturingLoggerProvider();

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = key,
            ["Modules:Identity:Jwt:PreviousSigningKey"] = options.PreviousSigningKey,
            // O limite por IP (5/min) dispararia antes do bloqueio por conta que estes testes querem provar.
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["Logging:LogLevel:Default"] = "Debug",
            ["ForwardedHeaders:Enabled"] = options.ForwardedHeaders ? "true" : "false",
        };
        if (options.OwnerEmail is not null)
        {
            settings["UNIOVER_OWNER_EMAIL"] = options.OwnerEmail;
            settings["UNIOVER_OWNER_PASSWORD"] = password;
        }

        foreach (var (name, value) in options.Extra ?? new Dictionary<string, string?>())
        {
            settings[name] = value;
        }

        var root = new EdgeFactory("Development", settings);
        var factory = root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(time);
            services.AddSingleton<ILoggerProvider>(logs);
            services.AddSingleton<IStartupFilter, TestRoutesFilter>();
        }));

        var app = new IdentityApp(root, factory, database, time, logs, key, options.OwnerEmail ?? "dono@uniover.test", password);

        // O seed roda em segundo plano depois da partida; o teste só começa quando ele terminou.
        await app.Bootstrap.Completion;
        return app;
    }

    public static IdentityDbContext CreateContext(string connection)
    {
        var builder = new DbContextOptionsBuilder<IdentityDbContext>();
        ModuleDatabase.Configure(builder, connection, IdentityDbContext.SchemaName, typeof(IdentityDbContext).Assembly);
        return new IdentityDbContext(builder.Options);
    }

    /// <summary>Contexto com o papel dono, só para o teste inspecionar o banco.</summary>
    public IdentityDbContext Db() => CreateContext(Database.OwnerConnection);

    public OwnerBootstrapService Bootstrap => _factory.Services.GetRequiredService<OwnerBootstrapService>();

    public async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string url,
        object? body = null,
        string? bearer = null,
        string? cookie = null,
        bool clientHeader = true,
        string? forwardedFor = null,
        string? userAgent = null)
    {
        using var request = new HttpRequestMessage(method, url);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        if (clientHeader)
        {
            request.Headers.Add(ClientHeader, "web");
        }

        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }

        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
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

    public Task<HttpResponseMessage> LoginRawAsync(string email, string password, string? forwardedFor = null, string? userAgent = null) =>
        SendAsync(HttpMethod.Post, "/api/v1/identity/auth/login", new { email, password }, forwardedFor: forwardedFor, userAgent: userAgent);

    public async Task<LoggedIn> LoginAsync(string? email = null, string? password = null)
    {
        using var response = await LoginRawAsync(email ?? OwnerEmail, password ?? OwnerPassword);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
        var cookie = Cookies(response).Single(c => c.Name == "uo_rt");
        return new LoggedIn(body.GetProperty("accessToken").GetString()!, cookie.Value, cookie, body);
    }

    public Task<HttpResponseMessage> RefreshRawAsync(string? secret, bool clientHeader = true) =>
        SendAsync(HttpMethod.Post, "/api/v1/identity/auth/refresh", cookie: secret is null ? null : "uo_rt=" + secret, clientHeader: clientHeader);

    public Task<HttpResponseMessage> GetAsync(string url, string? bearer = null, string? cookie = null) =>
        SendAsync(HttpMethod.Get, url, bearer: bearer, cookie: cookie, clientHeader: false);

    public static IReadOnlyList<ParsedCookie> Cookies(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (!response.Headers.TryGetValues("Set-Cookie", out var values))
        {
            return [];
        }

        return [.. values.Select(Parse)];
    }

    public static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);

    /// <summary>
    /// Assina um JWT com uma chave do teste (a mesma que o módulo usa ou outra), para os cenários de validação. O papel
    /// padrão é o dono, como em todo token que o servidor emite hoje; <c>role: null</c> assina um token SEM a claim de
    /// papel (o formato antigo, que já não vale como nada).
    /// </summary>
    public static string CraftToken(
        string base64Key,
        DateTimeOffset notBefore,
        DateTimeOffset expires,
        string audience = UniOverAuth.ApiAudience,
        string issuer = UniOverAuth.Issuer,
        Guid? subject = null,
        string algorithm = SecurityAlgorithms.HmacSha256,
        string? role = AccountRoles.Owner,
        IReadOnlyDictionary<string, object>? extraClaims = null)
    {
        var key = new SymmetricSecurityKey(Convert.FromBase64String(base64Key));
        var claims = new Dictionary<string, object>
        {
            [UniOverAuth.SubjectClaim] = (subject ?? Guid.NewGuid()).ToString(),
            [UniOverAuth.SessionClaim] = Guid.NewGuid().ToString(),
        };
        if (role is not null)
        {
            claims[UniOverAuth.RoleClaim] = role;
        }

        foreach (var (name, value) in extraClaims ?? new Dictionary<string, object>())
        {
            claims[name] = value;
        }

        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            NotBefore = notBefore.UtcDateTime,
            Expires = expires.UtcDateTime,
            SigningCredentials = new SigningCredentials(key, algorithm),
            Claims = claims,
        };
        return new JsonWebTokenHandler().CreateToken(descriptor);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();

        // A fábrica derivada é descartada junto com a raiz.
        await _root.DisposeAsync();

        // Cada teste tem o seu banco e, portanto, os seus pools. Sem fechá-los, as conexões ociosas de dezenas de
        // testes esgotam o max_connections do contêiner compartilhado.
        NpgsqlConnection.ClearAllPools();
    }

    private static ParsedCookie Parse(string header)
    {
        var parts = header.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var first = parts[0].Split('=', 2);
        var attributes = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in parts.Skip(1))
        {
            var pair = part.Split('=', 2);
            attributes[pair[0].ToLowerInvariant()] = pair.Length > 1 ? pair[1] : null;
        }

        return new ParsedCookie(first[0], first.Length > 1 ? first[1] : string.Empty, attributes, header);
    }

    /// <summary>Rotas de teste no mesmo construtor de endpoints do Host, depois do pipeline montado.</summary>
    private sealed class TestRoutesFilter : IStartupFilter
    {
        private const string RouteBuilderKey = "__EndpointRouteBuilder";

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            next(app);

            var routes = (IEndpointRouteBuilder)app.Properties[RouteBuilderKey]!;
            routes.MapGet("/api/test/protected", () => Results.Ok("ok")).RequireAuthorization();

            // Sem nenhum metadado de autorização: só a política padrão pode barrar.
            routes.MapGet("/api/test/default", () => Results.Ok("ok"));

            routes.MapGet("/api/test/stream", () => Results.Ok("ok")).RequireAuthorization(UniOverAuth.StreamPolicy);
            routes.MapPost("/api/test/stream", () => Results.Ok("ok")).RequireAuthorization(UniOverAuth.StreamPolicy);
        };
    }
}

/// <summary>Guarda o texto de todo log escrito durante o teste, para provar que segredo nenhum aparece nele.</summary>
internal sealed class CapturingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _lines = new();

    public IReadOnlyList<string> Lines => [.. _lines];

    public ILogger CreateLogger(string categoryName) => new CapturingLogger(categoryName, _lines);

    public void Dispose()
    {
    }

    private sealed class CapturingLogger(string category, ConcurrentQueue<string> lines) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            lines.Enqueue($"{logLevel} {category}: {formatter(state, exception)} {exception}");
        }
    }
}
