using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;

namespace UniOver.IntegrationTests.Idempotency;

[Collection(PostgresGroup.Name)]
public class IdempotencyTests(PostgresFixture postgres)
{
    private static readonly Guid UserA = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid UserB = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        HttpMethod method,
        string path,
        string? json = "{\"name\":\"a\"}",
        Guid? key = null,
        Guid? user = null,
        string? rawKey = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (json is not null)
        {
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        var keyValue = rawKey ?? key?.ToString();
        if (keyValue is not null)
        {
            request.Headers.Add("Idempotency-Key", keyValue);
        }

        request.Headers.Add(HeaderCurrentUser.Header, (user ?? UserA).ToString());
        return client.SendAsync(request, Ct);
    }

    private static Task<HttpResponseMessage> PostOrderAsync(
        HttpClient client, Guid key, string json = "{\"name\":\"a\"}", Guid? user = null) =>
        SendAsync(client, HttpMethod.Post, "/api/test/orders", json, key, user);

    private static bool Replayed(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Idempotent-Replayed", out var values) && values.Contains("true");

    private static async Task<string> ProblemTypeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
        return document.RootElement.GetProperty("type").GetString()!;
    }

    private async Task<IdempotencyHost> StartHostAsync(TimeProvider? time = null) =>
        await IdempotencyHost.StartAsync(await postgres.CreateDatabaseAsync(), time);

    [Fact]
    public async Task Resend_ReturnsTheStoredResponse_AndTheHandlerRunsOnce()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();

        var first = await PostOrderAsync(host.Client, key);
        var second = await PostOrderAsync(host.Client, key);

        first.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(first).Should().BeFalse();
        second.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(second).Should().BeTrue();
        second.Headers.Location.Should().Be(first.Headers.Location);
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        second.Content.Headers.ContentType!.MediaType.Should().Be("application/json");
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task BodyStillReachesTheEndpoint_AfterTheFilterHashedIt()
    {
        await using var host = await StartHostAsync();

        var response = await PostOrderAsync(host.Client, Guid.NewGuid(), "{\"name\":\"lido-no-endpoint\"}");

        var created = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        created.GetProperty("name").GetString().Should().Be("lido-no-endpoint");
    }

    [Fact]
    public async Task ResendWhileTheFirstIsRunning_Gets409WithRetryAfter_ThenTheStoredResponse()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();
        host.Probe.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var first = PostOrderAsync(host.Client, key);
        await host.Probe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);
        var second = await PostOrderAsync(host.Client, key);

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        second.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromSeconds(2));
        (await ProblemTypeAsync(second)).Should().EndWith("/idempotency-in-progress");

        host.Probe.Hold.SetResult();
        (await first).StatusCode.Should().Be(HttpStatusCode.Created);
        var third = await PostOrderAsync(host.Client, key);
        third.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(third).Should().BeTrue();
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task TwoSimultaneousSends_RunTheHandlerOnce_FiftyTimes()
    {
        await using var host = await StartHostAsync();
        host.Probe.Delay = TimeSpan.FromMilliseconds(40);

        for (var round = 0; round < 50; round++)
        {
            var key = Guid.NewGuid();
            var pair = await Task.WhenAll(PostOrderAsync(host.Client, key), PostOrderAsync(host.Client, key));

            host.Probe.ExecutionsOf(key.ToString()).Should().Be(1, $"rodada {round}: o manipulador executa uma vez");
            pair.Count(r => r.StatusCode == HttpStatusCode.Created && !Replayed(r)).Should().Be(1, $"rodada {round}: um só original");
            var other = pair.Single(r => r.StatusCode != HttpStatusCode.Created || Replayed(r));
            if (other.StatusCode == HttpStatusCode.Conflict)
            {
                (await ProblemTypeAsync(other)).Should().EndWith("/idempotency-in-progress");
            }
            else
            {
                other.StatusCode.Should().Be(HttpStatusCode.Created);
                Replayed(other).Should().BeTrue();
            }
        }
    }

    [Fact]
    public async Task SameKeyWithAnotherBody_Gets422()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();
        await PostOrderAsync(host.Client, key, "{\"name\":\"um\"}");

        var other = await PostOrderAsync(host.Client, key, "{\"name\":\"dois\"}");

        other.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await ProblemTypeAsync(other)).Should().EndWith("/idempotency-key-reused");
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task SameKeyOnAnotherRoute_Gets422()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();
        await PostOrderAsync(host.Client, key);

        var other = await SendAsync(host.Client, HttpMethod.Post, "/api/test/rejects", "{\"name\":\"a\"}", key);

        other.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task ServerError_IsNotStored_AndTheKeyIsReleasedForTheResend()
    {
        await using var host = await StartHostAsync();
        host.Probe.FailNext(1);
        var key = Guid.NewGuid();

        var first = await SendAsync(host.Client, HttpMethod.Post, "/api/test/flaky", null, key);
        var second = await SendAsync(host.Client, HttpMethod.Post, "/api/test/flaky", null, key);

        first.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(second).Should().BeFalse("a 5xx não foi guardada: o reenvio executou de verdade");
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(2);
    }

    [Fact]
    public async Task ThrownException_ReleasesTheKeyToo()
    {
        await using var host = await StartHostAsync();
        host.Probe.FailNext(1);
        var key = Guid.NewGuid();

        var first = await SendAsync(host.Client, HttpMethod.Post, "/api/test/throws", null, key);
        var second = await SendAsync(host.Client, HttpMethod.Post, "/api/test/throws", null, key);

        first.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(2);
    }

    [Fact]
    public async Task StaleInProgress_CountsAsMissing_AndTheNextSendRuns()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        await using var host = await StartHostAsync(time);
        var key = Guid.NewGuid();

        // Um processo que caiu deixa a chave "em andamento" para sempre.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<IIdempotencyStore<IdempotencyTestDbContext>>();
            var begin = await store.TryBeginAsync(UserA, key, "POST", "/api/test/orders", System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("{\"name\":\"a\"}")), Ct);
            begin.Outcome.Should().Be(IdempotencyBeginOutcome.Started);
        }

        var tooSoon = await PostOrderAsync(host.Client, key);
        tooSoon.StatusCode.Should().Be(HttpStatusCode.Conflict);

        time.Advance(TimeSpan.FromSeconds(61));
        var later = await PostOrderAsync(host.Client, key);

        later.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(later).Should().BeFalse();
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task TwoSendsTakingOverTheSameStaleKey_OnlyOneWins()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        await using var host = await StartHostAsync(time);
        var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("{\"name\":\"a\"}"));

        for (var round = 0; round < 20; round++)
        {
            var key = Guid.NewGuid();
            await using var scope = host.Services.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<IIdempotencyStore<IdempotencyTestDbContext>>();
            await store.TryBeginAsync(UserA, key, "POST", "/api/test/orders", hash, Ct);
            time.Advance(TimeSpan.FromSeconds(61));

            var results = await Task.WhenAll(
                store.TryBeginAsync(UserA, key, "POST", "/api/test/orders", hash, Ct),
                store.TryBeginAsync(UserA, key, "POST", "/api/test/orders", hash, Ct));

            results.Count(r => r.Outcome == IdempotencyBeginOutcome.Started).Should().Be(1, $"rodada {round}");
            results.Count(r => r.Outcome == IdempotencyBeginOutcome.InProgress).Should().Be(1, $"rodada {round}");
        }
    }

    [Fact]
    public async Task MissingOrMalformedKey_Gets400_AndTheHandlerDoesNotRun()
    {
        await using var host = await StartHostAsync();

        var missing = await SendAsync(host.Client, HttpMethod.Post, "/api/test/orders");
        var malformed = await SendAsync(host.Client, HttpMethod.Post, "/api/test/orders", rawKey: "nao-e-uuid");

        foreach (var response in new[] { missing, malformed })
        {
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await ProblemTypeAsync(response)).Should().EndWith("/idempotency-key-required");
        }

        host.Probe.Total.Should().Be(0);
    }

    [Fact]
    public async Task AnotherUserWithTheSameKey_DoesNotCollide()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();

        var a = await PostOrderAsync(host.Client, key, user: UserA);
        var b = await PostOrderAsync(host.Client, key, user: UserB);

        a.StatusCode.Should().Be(HttpStatusCode.Created);
        b.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(b).Should().BeFalse();
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(2);
    }

    [Fact]
    public async Task BusinessError4xx_IsAlsoStored()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();

        var first = await SendAsync(host.Client, HttpMethod.Post, "/api/test/rejects", null, key);
        var second = await SendAsync(host.Client, HttpMethod.Post, "/api/test/rejects", null, key);

        first.StatusCode.Should().Be(HttpStatusCode.NotFound);
        second.StatusCode.Should().Be(HttpStatusCode.NotFound);
        Replayed(second).Should().BeTrue();
        (await second.Content.ReadAsStringAsync(Ct)).Should().Be(await first.Content.ReadAsStringAsync(Ct));
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task ResponseOverTheLimit_KeepsOnlyStatusAndLocation()
    {
        await using var host = await StartHostAsync();
        var key = Guid.NewGuid();

        var first = await SendAsync(host.Client, HttpMethod.Post, "/api/test/big", null, key);
        var second = await SendAsync(host.Client, HttpMethod.Post, "/api/test/big", null, key);

        (await first.Content.ReadAsStringAsync(Ct)).Length.Should().BeGreaterThan(IdempotencyLimits.MaxStoredBodyBytes);
        second.StatusCode.Should().Be(HttpStatusCode.Created);
        Replayed(second).Should().BeTrue();
        second.Headers.Location!.OriginalString.Should().Be("/api/test/big/1");
        (await second.Content.ReadAsStringAsync(Ct)).Should().BeEmpty();
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task PutAndDelete_AlsoRequireTheKey_ButGetPassesThrough()
    {
        await using var host = await StartHostAsync();
        var id = Guid.NewGuid();
        var key = Guid.NewGuid();

        var putWithoutKey = await SendAsync(host.Client, HttpMethod.Put, $"/api/test/orders/{id}");
        var put = await SendAsync(host.Client, HttpMethod.Put, $"/api/test/orders/{id}", key: key);
        var putAgain = await SendAsync(host.Client, HttpMethod.Put, $"/api/test/orders/{id}", key: key);
        var get = await SendAsync(host.Client, HttpMethod.Get, "/api/test/ping", null);

        putWithoutKey.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        Replayed(putAgain).Should().BeTrue();
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        host.Probe.ExecutionsOf(key.ToString()).Should().Be(1);
    }

    [Fact]
    public async Task ExpiredKeys_AreSweptWhenANewOneIsInserted()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        await using var host = await StartHostAsync(time);
        var old = Guid.NewGuid();
        await PostOrderAsync(host.Client, old);

        time.Advance(IdempotencyLimits.Retention + TimeSpan.FromMinutes(1));
        await PostOrderAsync(host.Client, Guid.NewGuid());

        await using var scope = host.Services.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<IdempotencyTestDbContext>();
        var keys = await context.Set<IdempotencyRecord>().Select(r => r.Key).ToListAsync(Ct);
        keys.Should().NotContain(old);
        keys.Should().HaveCount(1);
    }

    [Fact]
    public async Task Table_LivesInTheModuleSchema_WithCompositePrimaryKey()
    {
        var database = await postgres.CreateDatabaseAsync();
        await using var host = await IdempotencyHost.StartAsync(database);

        await using var connection = new Npgsql.NpgsqlConnection(database.OwnerConnection);
        await connection.OpenAsync(Ct);
        await using var command = new Npgsql.NpgsqlCommand(
            "SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_index i "
            + "JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
            + "JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true "
            + "JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum "
            + "WHERE i.indisprimary AND n.nspname = 'idem_test' AND c.relname = 'idempotency_keys'",
            connection);
        var columns = (string?)await command.ExecuteScalarAsync(Ct);

        columns.Should().Be("user_id,key");
    }
}
