using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Idempotency;

/// <summary>Contexto de um módulo de mentira que só tem as chaves de idempotência (schema próprio, sem tocar o módulo de teste).</summary>
public sealed class IdempotencyTestDbContext(DbContextOptions<IdempotencyTestDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "idem_test";

    protected override string Schema => SchemaName;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.AddIdempotency();
    }
}

/// <summary>
/// Ponte entre a porta EF-free do filtro HTTP (BuildingBlocks.Web) e a loja em Postgres (BuildingBlocks.Persistence):
/// os dois projetos ainda não se referenciam. Some quando o Web passar a referenciar o Persistence.
/// </summary>
public sealed class IdempotencyGatewayBridge<TContext>(IIdempotencyStore<TContext> store) : IIdempotencyGateway<TContext>
    where TContext : ModuleDbContext
{
    public async Task<IdempotencyGatewayResult> TryBeginAsync(
        Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken)
    {
        var result = await store.TryBeginAsync(userId, key, method, route, requestHash, cancellationToken);
        var outcome = result.Outcome switch
        {
            IdempotencyBeginOutcome.Started => IdempotencyGatewayOutcome.Started,
            IdempotencyBeginOutcome.Completed => IdempotencyGatewayOutcome.Completed,
            _ => IdempotencyGatewayOutcome.InProgress,
        };
        var existing = result.Existing is { } r
            ? new IdempotencyGatewayEntry(r.Method, r.Route, r.RequestHash, r.StatusCode, r.ResponseBody, r.ContentType, r.Location)
            : null;
        return new IdempotencyGatewayResult(outcome, existing);
    }

    public Task CompleteAsync(
        Guid userId, Guid key, int statusCode, string? responseBody, string? contentType, string? location, CancellationToken cancellationToken) =>
        store.CompleteAsync(userId, key, statusCode, responseBody, contentType, location, cancellationToken);

    public Task ReleaseAsync(Guid userId, Guid key, CancellationToken cancellationToken) =>
        store.ReleaseAsync(userId, key, cancellationToken);
}

/// <summary>Usuário de teste: o id vem do cabeçalho <c>X-Test-User</c>.</summary>
internal sealed class HeaderCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public const string Header = "X-Test-User";

    public bool IsAuthenticated => UserId is not null;

    public Guid? UserId =>
        Guid.TryParse(accessor.HttpContext?.Request.Headers[Header].ToString(), out var id) ? id : null;

    public Guid? SessionId => null;
}

public sealed record OrderBody(string Name);

/// <summary>O que os handlers de teste observam: quantas vezes cada chave executou, e os "botões" que o teste aciona.</summary>
public sealed class HandlerProbe
{
    private readonly ConcurrentDictionary<string, int> _executions = new(StringComparer.Ordinal);
    private int _failuresLeft;

    public int ExecutionsOf(string key) => _executions.GetValueOrDefault(key);

    public int Total => _executions.Values.Sum();

    public void Count(string key) => _executions.AddOrUpdate(key, 1, (_, n) => n + 1);

    /// <summary>Quando definido, o handler de pedidos espera por ele (mantém a chave "em andamento").</summary>
    public TaskCompletionSource? Hold { get; set; }

    /// <summary>Resolvida quando um handler de pedidos entrou (a chave já está registrada como em andamento).</summary>
    public TaskCompletionSource Entered { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Atraso fixo do handler de pedidos, para sobrepor envios simultâneos.</summary>
    public TimeSpan Delay { get; set; }

    public void FailNext(int times) => Interlocked.Exchange(ref _failuresLeft, times);

    public bool ShouldFail() => Interlocked.Decrement(ref _failuresLeft) >= 0;
}

/// <summary>Uma "instância da API" mínima (servidor de teste em memória) contra o banco do teste.</summary>
public sealed class IdempotencyHost : IAsyncDisposable
{
    private readonly WebApplication _app;

    private IdempotencyHost(WebApplication app, HandlerProbe probe)
    {
        _app = app;
        Probe = probe;
        Client = app.GetTestClient();
    }

    public HandlerProbe Probe { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _app.Services;

    public static async Task<IdempotencyHost> StartAsync(TestDatabase database, TimeProvider? time = null, bool createSchema = true)
    {
        ArgumentNullException.ThrowIfNull(database);

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Development });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.OwnerConnection,
        });

        var probe = new HandlerProbe();
        builder.Services.AddSingleton(probe);
        builder.Services.AddSingleton(time ?? TimeProvider.System);
        builder.Services.AddHttpContextAccessor();
        builder.Services.AddScoped<ICurrentUser, HeaderCurrentUser>();
        builder.Services.AddUniOverProblemDetails();
        builder.Services.AddModuleDbContext<IdempotencyTestDbContext>(
            builder.Configuration, IdempotencyTestDbContext.SchemaName, typeof(IdempotencyTestDbContext).Assembly);
        builder.Services.AddIdempotencyStore<IdempotencyTestDbContext>();
        builder.Services.AddScoped<IIdempotencyGateway<IdempotencyTestDbContext>, IdempotencyGatewayBridge<IdempotencyTestDbContext>>();

        var app = builder.Build();
        app.UseUniOverProblemDetails();
        MapEndpoints(app);

        if (createSchema)
        {
            await using var scope = app.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IdempotencyTestDbContext>().Database.EnsureCreatedAsync();
        }

        await app.StartAsync();
        return new IdempotencyHost(app, probe);
    }

    private static void MapEndpoints(WebApplication app)
    {
        // Cria um pedido: devolve 201 com Location e um id novo a cada execução (a repetição denuncia a duplicata).
        app.MapPost("/api/test/orders", async (OrderBody body, HttpContext http, HandlerProbe probe) =>
        {
            var key = http.Request.Headers["Idempotency-Key"].ToString();
            probe.Count(key);
            probe.Entered.TrySetResult();
            if (probe.Hold is { } hold)
            {
                await hold.Task;
            }

            if (probe.Delay > TimeSpan.Zero)
            {
                await Task.Delay(probe.Delay);
            }

            var id = Guid.NewGuid();
            return Results.Created($"/api/test/orders/{id}", new { id, name = body.Name });
        }).RequireIdempotency<IdempotencyTestDbContext>();

        app.MapPut("/api/test/orders/{id:guid}", (Guid id, OrderBody body, HttpContext http, HandlerProbe probe) =>
        {
            probe.Count(http.Request.Headers["Idempotency-Key"].ToString());
            return Results.Ok(new { id, name = body.Name });
        }).RequireIdempotency<IdempotencyTestDbContext>();

        // Falha (500) as vezes que o teste mandar; depois responde 200.
        app.MapPost("/api/test/flaky", (HttpContext http, HandlerProbe probe) =>
        {
            probe.Count(http.Request.Headers["Idempotency-Key"].ToString());
            return probe.ShouldFail()
                ? Results.Problem(statusCode: StatusCodes.Status500InternalServerError, title: "Falhou.")
                : Results.Ok(new { done = true });
        }).RequireIdempotency<IdempotencyTestDbContext>();

        app.MapPost("/api/test/throws", (HttpContext http, HandlerProbe probe) =>
        {
            probe.Count(http.Request.Headers["Idempotency-Key"].ToString());
            return probe.ShouldFail()
                ? throw new InvalidOperationException("detalhe-interno")
                : Results.Ok(new { done = true });
        }).RequireIdempotency<IdempotencyTestDbContext>();

        // Erro de negócio determinístico (4xx).
        app.MapPost("/api/test/rejects", (HttpContext http, HandlerProbe probe) =>
        {
            probe.Count(http.Request.Headers["Idempotency-Key"].ToString());
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Pedido não existe.");
        }).RequireIdempotency<IdempotencyTestDbContext>();

        // Resposta maior que o limite guardado.
        app.MapPost("/api/test/big", (HttpContext http, HandlerProbe probe) =>
        {
            probe.Count(http.Request.Headers["Idempotency-Key"].ToString());
            http.Response.Headers.Location = "/api/test/big/1";
            return Results.Json(new { text = new string('x', 40 * 1024) }, statusCode: StatusCodes.Status201Created);
        }).RequireIdempotency<IdempotencyTestDbContext>();

        app.MapGet("/api/test/ping", () => Results.Ok(new { pong = true })).RequireIdempotency<IdempotencyTestDbContext>();
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _app.DisposeAsync();
    }
}
