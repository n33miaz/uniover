using System.Data.Common;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class TvLinkRebindRaceTests(PostgresFixture postgres)
{
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
}
