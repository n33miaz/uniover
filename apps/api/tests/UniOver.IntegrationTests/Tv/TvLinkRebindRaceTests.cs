using System.Collections.Concurrent;
using System.Data.Common;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class TvLinkRebindRaceTests(PostgresFixture postgres)
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Rebind_RecoversOnNextPass_WhenThePostCommitReadFails(bool usePatch)
    {
        var failure = new BindingReadFailure();
        var cleanup = new CleanupProbe();
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services =>
            {
                services.ConfigureDbContext<TvDbContext>(builder => builder.AddInterceptors(failure));
                services.AddSingleton<ITvCleanupSettingsPublisher>(cleanup);
            },
        });
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, TvAuth.BindAgentAction);
        var previous = await app.PairAsync("Computador anterior");
        var next = await app.PairAsync("Computador novo");
        var ct = TestContext.Current.CancellationToken;
        await using var db = app.Db();
        var tvId = await db.Tvs.Where(tv => tv.IsDefault).Select(tv => tv.Id).SingleAsync(ct);
        var watcher = app.Services.GetRequiredService<TvLinkWatcher>();
        await watcher.StopAsync(ct);

        Task<HttpResponseMessage> RebindAsync(string slug) => usePatch
            ? app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { agentSlug = slug })
            : app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = slug });

        using var first = await RebindAsync(previous.Slug);
        first.EnsureSuccessStatusCode();
        var resolver = app.Services.GetRequiredService<ITvAgentResolver>();
        (await resolver.ResolveAsync(ct)).AgentSlug.Should().Be(previous.Slug);
        cleanup.Calls.Clear();
        failure.Arm();
        using var second = await RebindAsync(next.Slug);
        failure.Failed.Should().BeTrue();
        (await db.Tvs.Where(tv => tv.Id == tvId).Select(tv => tv.AgentSlug).SingleAsync(ct)).Should().Be(next.Slug);
        second.EnsureSuccessStatusCode();
        cleanup.Calls.Should().Equal((previous.Slug, true), (next.Slug, false));
        (await resolver.ResolveAsync(ct)).AgentSlug.Should().Be(next.Slug);

        var stream = app.Services.GetRequiredService<TvStreamPublisher>();
        using var subscription = stream.Subscribe(tvId, "dono", () => []);
        var outdated = TvState.From(null, true);
        watcher.Publish(tvId, previous.Slug, outdated);
        subscription.Reader.TryRead(out _).Should().BeFalse();

        await watcher.RunPassAsync(ct);
        subscription.Reader.TryRead(out _).Should().BeTrue("a vigia anuncia o vínculo recuperado");
        var current = TvState.From(null, false);
        watcher.Publish(tvId, previous.Slug, outdated);
        watcher.Publish(tvId, next.Slug, current);
        subscription.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Should().BeSameAs(current);
        subscription.Reader.TryRead(out _).Should().BeFalse();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Rebind_KeepsTheNewerAgent_WhenAnOlderPostCommitReadFailsAfterIt(bool olderUsesPatch)
    {
        var failure = new BindingReadFailure();
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services => services.ConfigureDbContext<TvDbContext>(builder => builder.AddInterceptors(failure)),
        });
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, TvAuth.BindAgentAction);
        var olderAgent = await app.PairAsync("Computador da troca anterior");
        var newerAgent = await app.PairAsync("Computador da troca nova");
        var ct = TestContext.Current.CancellationToken;
        await using var db = app.Db();
        var tvId = await db.Tvs.Where(tv => tv.IsDefault).Select(tv => tv.Id).SingleAsync(ct);
        var watcher = app.Services.GetRequiredService<TvLinkWatcher>();
        await watcher.StopAsync(ct);
        var resolver = app.Services.GetRequiredService<ITvAgentResolver>();
        // Deixa um valor anterior às duas trocas guardado no resolvedor.
        await resolver.ResolveAsync(ct);

        Task<HttpResponseMessage> RebindAsync(bool patch, string slug) => patch
            ? app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { agentSlug = slug })
            : app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = slug });

        failure.Arm(hold: true);
        var older = RebindAsync(olderUsesPatch, olderAgent.Slug);
        try
        {
            await failure.Reached.Task.WaitAsync(FakeAgent.Patience, ct);
            using var newer = await RebindAsync(!olderUsesPatch, newerAgent.Slug).WaitAsync(FakeAgent.Patience, ct);
            newer.EnsureSuccessStatusCode();
        }
        finally
        {
            failure.Resume.TrySetResult();
            using var response = await older.WaitAsync(FakeAgent.Patience, ct);
            response.EnsureSuccessStatusCode();
        }

        failure.Failed.Should().BeTrue();
        (await resolver.ResolveAsync(ct)).AgentSlug.Should().Be(newerAgent.Slug);
        var stream = app.Services.GetRequiredService<TvStreamPublisher>();
        using var subscription = stream.Subscribe(tvId, "dono", () => []);
        var outdated = TvState.From(null, true);
        var current = TvState.From(null, false);

        // Sem passada nenhuma: a falha atrasada não pode descartar o vínculo mais novo já aplicado.
        watcher.Publish(tvId, olderAgent.Slug, outdated);
        watcher.Publish(tvId, newerAgent.Slug, current);

        subscription.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Should().BeSameAs(current);
        subscription.Reader.TryRead(out _).Should().BeFalse();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Rebind_RegistersTheLastCommittedAgent_WhenTheFirstRequestResumesLast(bool firstUsesPatch)
    {
        var barrier = new CommitBarrier();
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services => services.ConfigureDbContext<TvDbContext>(builder => builder.AddInterceptors(barrier)),
        });
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, TvAuth.BindAgentAction);
        var firstAgent = await app.PairAsync("Primeiro computador");
        var lastAgent = await app.PairAsync("Último computador");
        var ct = TestContext.Current.CancellationToken;
        await using var db = app.Db();
        var tvId = await db.Tvs.Where(tv => tv.IsDefault).Select(tv => tv.Id).SingleAsync(ct);

        Task<HttpResponseMessage> RebindAsync(bool patch, string slug) => patch
            ? app.SendAsync(HttpMethod.Patch, $"/api/v1/tv/tvs/{tvId}", new { agentSlug = slug })
            : app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = slug });

        barrier.AgentSlug = firstAgent.Slug;
        var first = RebindAsync(firstUsesPatch, firstAgent.Slug);
        try
        {
            await barrier.Committed.Task.WaitAsync(FakeAgent.Patience, ct);
            using var last = await RebindAsync(!firstUsesPatch, lastAgent.Slug).WaitAsync(FakeAgent.Patience, ct);
            last.EnsureSuccessStatusCode();
        }
        finally
        {
            barrier.Resume.TrySetResult();
            using var response = await first.WaitAsync(FakeAgent.Patience, ct);
            response.EnsureSuccessStatusCode();
        }

        (await db.Tvs.Where(tv => tv.Id == tvId).Select(tv => tv.AgentSlug).SingleAsync(ct)).Should().Be(lastAgent.Slug);
        var watcher = app.Services.GetRequiredService<TvLinkWatcher>();
        var stream = app.Services.GetRequiredService<TvStreamPublisher>();
        using var subscription = stream.Subscribe(tvId, "dono", () => []);
        var outdated = TvState.From(null, true);
        var current = TvState.From(null, false);

        watcher.Publish(tvId, firstAgent.Slug, outdated);
        watcher.Publish(tvId, lastAgent.Slug, current);

        subscription.Reader.TryRead(out var message).Should().BeTrue();
        message!.Data.Should().BeSameAs(current, "a vigia só deve aceitar o último computador gravado");
        subscription.Reader.TryRead(out _).Should().BeFalse();
    }

    private sealed class CommitBarrier : DbTransactionInterceptor
    {
        public string? AgentSlug { get; set; }
        public TaskCompletionSource Committed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async Task TransactionCommittedAsync(
            DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (AgentSlug is { } slug && eventData.Context!.ChangeTracker.Entries<ConfiguredTv>().Any(entry => entry.Entity.AgentSlug == slug)
                && Committed.TrySetResult())
            {
                // O banco já confirmou a primeira troca, mas o handler ainda não voltou da gravação.
                await Resume.Task.WaitAsync(cancellationToken);
            }
        }
    }

    private sealed class BindingReadFailure : DbCommandInterceptor
    {
        private int _armed;
        public bool Failed { get; private set; }
        public TaskCompletionSource Reached { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        /// <param name="hold">Segura a releitura antes de falhar, até o teste completar <see cref="Resume"/>.</param>
        public void Arm(bool hold = false)
        {
            if (!hold)
            {
                Resume.TrySetResult();
            }

            Interlocked.Exchange(ref _armed, 1);
        }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("""SELECT * FROM "tv"."tvs" WHERE id =""", StringComparison.Ordinal)
                && command.CommandText.Contains("FOR UPDATE", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _armed, 0) == 1)
            {
                Reached.TrySetResult();
                await Resume.Task.WaitAsync(cancellationToken);
                Failed = true;
                throw new InvalidOperationException("Falha simulada na releitura do vínculo.");
            }

            return result;
        }
    }

    private sealed class CleanupProbe : ITvCleanupSettingsPublisher
    {
        public ConcurrentQueue<(string? AgentSlug, bool Unbound)> Calls { get; } = new();

        public Task PublishAsync(string? agentSlug = null, CancellationToken cancellationToken = default)
        {
            Calls.Enqueue((agentSlug, false));
            return Task.CompletedTask;
        }

        public Task PublishUnboundAsync(string agentSlug, CancellationToken cancellationToken = default)
        {
            Calls.Enqueue((agentSlug, true));
            return Task.CompletedTask;
        }
    }
}
