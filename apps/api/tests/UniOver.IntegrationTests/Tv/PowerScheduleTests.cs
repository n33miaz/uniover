using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.PowerSchedule;
using Schedule = UniOver.Modules.Tv.Domain.PowerSchedule;

namespace UniOver.IntegrationTests.Tv;

[Collection(PostgresGroup.Name)]
public sealed class PowerScheduleTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<Guid> ConfigureAsync(TvApp app)
    {
        // A TV padrão já existe (a da instalação, ligada ao computador do teste): o agendamento é dela.
        await using var db = app.Db();
        return await db.Tvs.Where(t => t.IsDefault).Select(t => t.Id).SingleAsync(Ct);
    }

    private static async Task<long> ScheduleAsync(TvApp app, Guid tvId, DateTimeOffset due)
    {
        using var response = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = due, timeZone = "America/Sao_Paulo" });
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await TvApp.JsonAsync(response)).GetProperty("version").GetInt64();
    }

    [Fact]
    public async Task SaveChangeAndCancel_KeepOneActiveScheduleAndRejectOldVersion()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var due = app.Time.GetUtcNow().AddHours(1);
        var version = await ScheduleAsync(app, tvId, due);
        using (var read = await app.GetAsync($"/api/v1/tv/power/schedule?tvId={tvId}"))
        {
            var active = (await TvApp.JsonAsync(read)).GetProperty("active");
            active.GetProperty("timeZone").GetString().Should().Be("America/Sao_Paulo");
            active.GetProperty("dueAtUtc").GetDateTimeOffset().Should().Be(due);
        }

        using (var duplicate = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = due.AddMinutes(5), timeZone = "America/Sao_Paulo" }))
            duplicate.StatusCode.Should().Be(HttpStatusCode.Conflict);

        using (var invalidZone = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = due.AddMinutes(5), timeZone = "Pacific Standard Time", version }))
            invalidZone.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        using (var change = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = due.AddMinutes(5), timeZone = "America/Sao_Paulo", version }))
            change.StatusCode.Should().Be(HttpStatusCode.OK);

        using var stale = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/power/schedule?tvId={tvId}&version={version}");
        stale.StatusCode.Should().Be(HttpStatusCode.Conflict);
        using var cancel = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/power/schedule?tvId={tvId}&version={version + 1}");
        cancel.StatusCode.Should().Be(HttpStatusCode.NoContent);
        await using var db = app.Db();
        (await db.PowerSchedules.CountAsync(x => x.TvId == tvId && x.Status == Schedule.Pending, Ct)).Should().Be(0);
        (await db.CommandAudit.CountAsync(x => x.TvId == tvId && x.Command == TvCommandNames.PowerSchedule, Ct)).Should().Be(3);
    }

    [Fact]
    public async Task GuestWithoutPower_CannotReadOrCreateSchedule()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv", "tv:control"], 88);
        using var read = await app.GetAsync($"/api/v1/tv/power/schedule?tvId={tvId}", guest.Login.AccessToken);
        read.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        using var save = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = app.Time.GetUtcNow().AddHours(1), timeZone = "America/Sao_Paulo" }, guest.Login.AccessToken);
        save.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ConcurrentCreations_LeaveOnlyOneActiveSchedule()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var due = app.Time.GetUtcNow().AddHours(1);
        var url = $"/api/v1/tv/power/schedule?tvId={tvId}";
        var requests = await Task.WhenAll(
            app.SendAsync(HttpMethod.Put, url, new { dueAtUtc = due, timeZone = "UTC" }),
            app.SendAsync(HttpMethod.Put, url, new { dueAtUtc = due.AddMinutes(1), timeZone = "UTC" }));
        using var first = requests[0];
        using var second = requests[1];
        requests.Select(x => x.StatusCode).Should().BeEquivalentTo(new[] { HttpStatusCode.OK, HttpStatusCode.Conflict });
        await using var db = app.Db();
        (await db.PowerSchedules.CountAsync(x => x.Status == Schedule.Pending, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task GuestOfAnotherTv_CannotReadThisSchedule()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv", "tv:power"], 90);
        await using (var db = app.Db())
        {
            var other = ConfiguredTv.Create("Outra", "outro-agente", false, Guid.NewGuid(), app.Time.GetUtcNow());
            db.Tvs.Add(other);
            db.TvMembers.Add(TvMember.Create(other.Id, guest.UserId, app.Time.GetUtcNow()));
            await db.SaveChangesAsync(Ct);
        }
        using var read = await app.GetAsync($"/api/v1/tv/power/schedule?tvId={tvId}", guest.Login.AccessToken);
        read.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task DueWhileOffline_IsRetriedInsteadOfClosed_AndEndsAsMissedOncePastTheCeiling()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
            (await worker.RunOnceAsync(Ct)).Should().Be(1, "o pedido voltou à fila, e a rodada segue");
            (await worker.RunOnceAsync(Ct)).Should().Be(0, "em espera até a próxima tentativa");
        }
        await using (var db = app.Db())
        {
            (await db.PowerSchedules.SingleAsync(Ct)).Status.Should().Be(Schedule.Pending, "deploy no minuto combinado não perde o agendamento");
            (await db.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(0);
        }

        app.Time.Advance(ScheduledPowerOffDispatcher.NotReadyRetryAfter + TimeSpan.FromSeconds(1));
        await SetDueAgoAsync(app, ScheduledPowerOffDispatcher.MaxLateness + TimeSpan.FromMinutes(1));
        await using var nextRound = app.Services.CreateAsyncScope();
        await nextRound.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);

        await WaitForResultAsync(app, "missed");
        await using var check = app.Db();
        (await check.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task AgentThatDroppedForAMoment_IsRetriedAndThenReceivesTheSafePowerOff()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using (var first = await app.ConnectAndWaitAsync())
        {
            await first.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
            await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
                "capacidade de desligamento seguro");
        }
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Connected == false, "queda do agente");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        await worker.RunOnceAsync(Ct);
        await using (var db = app.Db())
        {
            (await db.PowerSchedules.SingleAsync(Ct)).Status.Should().Be(Schedule.Pending, "a queda curta não encerra o pedido");
        }

        await using var back = await app.ConnectAndWaitAsync();
        await back.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade depois da volta");
        app.Time.Advance(ScheduledPowerOffDispatcher.NotReadyRetryAfter + TimeSpan.FromSeconds(1));
        var run = worker.RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(back);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(back, command);
        await run;

        await WaitForResultAsync(app, "off");
    }

    [Fact]
    public async Task CancelledJustBeforeDue_IsNeverClaimed()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var version = await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        using (var cancel = await app.SendAsync(HttpMethod.Delete, $"/api/v1/tv/power/schedule?tvId={tvId}&version={version}"))
            cancel.StatusCode.Should().Be(HttpStatusCode.NoContent);
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct)).Should().Be(0);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task AlreadyOff_UsesOnlyTheSafeAgentOperation()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));

        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        var run = worker.RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agent, command, TvApp.Failed(TvAgentCodes.AlreadyOff));
        (await run).Should().Be(1);
        (await worker.RunOnceAsync(Ct)).Should().Be(0);
        await using var db = app.Db();
        (await db.PowerSchedules.SingleAsync(Ct)).Result.Should().Be("already_off");
    }

    [Fact]
    public async Task UncertainAgentReply_IsRecordedWithoutRetry()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        var run = worker.RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(agent);
        await TvApp.ReplyAsync(agent, command, TvApp.Failed(TvAgentCodes.Uncertain));
        (await run).Should().Be(1);
        (await worker.RunOnceAsync(Ct)).Should().Be(0);
        await using var db = app.Db();
        (await db.PowerSchedules.SingleAsync(Ct)).Result.Should().Be("uncertain");
    }

    [Fact]
    public async Task ReboundTv_CancelsInsteadOfFollowingTheNewAgent()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        await using (var db = app.Db())
        {
            var tv = await db.Tvs.SingleAsync(Ct);
            tv.Rebind("outro-agente", null, Guid.NewGuid(), app.Time.GetUtcNow());
            await db.SaveChangesAsync(Ct);
        }
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct)).Should().Be(1);
        await using var check = app.Db();
        var schedule = await check.PowerSchedules.SingleAsync(Ct);
        schedule.Status.Should().Be(Schedule.Cancelled);
        schedule.Reason.Should().Be("tv_changed");
    }

    [Fact]
    public async Task GuestRemovedFromTv_CancelsAtDispatch()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv", "tv:power"], 89);
        using (var save = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = app.Time.GetUtcNow().AddSeconds(1), timeZone = "America/Sao_Paulo" }, guest.Login.AccessToken))
            save.StatusCode.Should().Be(HttpStatusCode.OK);
        await using (var db = app.Db())
        {
            db.TvMemberOptOuts.Add(TvMemberOptOut.Create(guest.UserId, app.Time.GetUtcNow()));
            await db.SaveChangesAsync(Ct);
        }
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct)).Should().Be(1);
        await using var check = app.Db();
        (await check.PowerSchedules.SingleAsync(Ct)).Reason.Should().Be("permission_removed");
    }

    [Fact]
    public async Task RemovedPowerPermission_CancelsAtDispatch()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        var guest = await app.NewGuestAsync("Convidado", ["module:tv", "tv:power"], 91);
        using (var save = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/power/schedule?tvId={tvId}",
            new { dueAtUtc = app.Time.GetUtcNow().AddSeconds(1), timeZone = "America/Sao_Paulo" }, guest.Login.AccessToken))
            save.StatusCode.Should().Be(HttpStatusCode.OK);
        await using (var identity = app.Identity())
            await identity.UserGrants.Where(x => x.UserId == guest.UserId && x.Permission == "tv:power").ExecuteDeleteAsync(Ct);

        // A porta de permissões tem cache curto; o relógio avança além dele antes do disparo.
        app.Time.Advance(TimeSpan.FromSeconds(31));
        await TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.PowerSchedules.AnyAsync(x => x.Status == Schedule.Cancelled && x.Reason == "permission_removed", Ct);
        }, "agendamento cancelado após retirada da permissão");
    }

    [Fact]
    public async Task AgentWithoutSafeCapability_IsNotSentAnyPowerCommand()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.remote") == true,
            "capacidade do agente");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct)).Should().Be(1);
        await using var db = app.Db();
        (await db.PowerSchedules.SingleAsync(Ct)).Result.Should().Be("unsupported");
    }

    // Muda a hora combinada direto no banco: avançar o relógio em minutos faria o worker do próprio host agir no meio do caminho.
    private static Task SetDueAgoAsync(TvApp app, TimeSpan ago) =>
        app.ExecuteSqlAsync($"UPDATE tv.power_schedules SET due_at_utc = '{app.Time.GetUtcNow().Subtract(ago):O}'");

    private static Task WaitForResultAsync(TvApp app, string result) =>
        TvApp.WaitUntilAsync(async () =>
        {
            await using var db = app.Db();
            return await db.PowerSchedules.AnyAsync(x => x.Status == Schedule.Completed && x.Result == result, Ct);
        }, $"agendamento encerrado como {result}");

    [Fact]
    public async Task DueLongerAgoThanTheCeiling_FinishesAsMissedWithAudit_AndSendsNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddHours(1));
        await SetDueAgoAsync(app, ScheduledPowerOffDispatcher.MaxLateness + TimeSpan.FromMinutes(1));

        await using var scope = app.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);

        await WaitForResultAsync(app, "missed");
        await using var db = app.Db();
        var audit = await db.CommandAudit.SingleAsync(x => x.Command == TvCommandNames.PowerOff, Ct);
        audit.Ok.Should().BeFalse();
        audit.ErrorCode.Should().Be("missed");
        audit.Detail.Should().Be("scheduled");
        audit.LatencyMs.Should().BeNull("nada foi enviado ao agente");

        // O agente não recebeu nada: a primeira coisa que chega é a tecla de prova, não o desligar.
        var key = app.PostAsync("/api/v1/tv/keys", new { key = "MUTE" });
        var received = await TvApp.NextCommandAsync(agent);
        received.GetProperty("type").GetString().Should().Be("tv.key.v2");
        received.GetProperty("body").GetProperty("key").GetString().Should().Be("MUTE");
        await TvApp.ReplyAsync(agent, received);
        using var response = await key.WaitAsync(TimeSpan.FromSeconds(15), Ct);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task DueJustInsideTheCeiling_StillSendsTheSafePowerOff()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddHours(1));
        await SetDueAgoAsync(app, ScheduledPowerOffDispatcher.MaxLateness - TimeSpan.FromMinutes(1));

        await using var scope = app.Services.CreateAsyncScope();
        var run = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agent, command);
        await run;

        await WaitForResultAsync(app, "off");
    }

    [Fact]
    public async Task ConnectedAgentWithoutCapabilitiesYet_IsRetriedNextRound_InsteadOfClosedAsUnsupported()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        // Conectado, mas o hello ainda não chegou: é a presença logo depois de a API subir.
        await using var agent = await app.ConnectAndWaitAsync();
        app.Presence.Get(app.Agent.Slug)!.Capabilities.Should().BeEmpty();
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();

        (await worker.RunOnceAsync(Ct)).Should().Be(1, "o pedido foi devolvido à fila, e a rodada segue");

        await using (var db = app.Db())
        {
            var schedule = await db.PowerSchedules.SingleAsync(Ct);
            schedule.Status.Should().NotBe(Schedule.Completed);
            (await db.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(0);
        }

        // O hello chega: na rodada seguinte o desligamento seguro sai.
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        app.Time.Advance(ScheduledPowerOffDispatcher.NotReadyRetryAfter + TimeSpan.FromSeconds(1));
        var run = worker.RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agent, command);
        await run;

        await WaitForResultAsync(app, "off");
    }

    [Fact]
    public async Task AnAgentWithoutCapabilitiesYet_DoesNotHoldBackTheScheduleOfAnotherTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvA = await ConfigureAsync(app);
        await using var agentA = await app.ConnectAndWaitAsync(); // sem hello: capacidades ainda desconhecidas
        var pairedB = await app.PairAsync("PC da outra TV", keepTv: true);
        await using var agentB = await app.ConnectAsync(pairedB);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(pairedB.Slug)?.Connected == true, "segundo agente conectado");
        await agentB.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(pairedB.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade do segundo agente");
        Guid tvB, ownerId;
        await using (var identity = app.Identity())
            ownerId = await identity.Users.Where(u => u.Email == app.OwnerEmail).Select(u => u.Id).SingleAsync(Ct);
        var now = app.Time.GetUtcNow();
        await using (var db = app.Db())
        {
            tvB = await db.Tvs.Where(t => t.AgentSlug == pairedB.Slug).Select(t => t.Id).SingleAsync(Ct);
            // A da TV A é a mais antiga: sozinha na frente da fila, travaria a da TV B.
            db.PowerSchedules.Add(Schedule.Create(tvA, app.Agent.Slug, ownerId, true, now.AddSeconds(1), "UTC", now));
            db.PowerSchedules.Add(Schedule.Create(tvB, pairedB.Slug, ownerId, true, now.AddSeconds(2), "UTC", now));
            await db.SaveChangesAsync(Ct);
        }
        app.Time.Advance(TimeSpan.FromSeconds(3));

        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        var round = Task.Run(async () =>
        {
            while (await worker.RunOnceAsync(Ct) != 0)
            {
            }
        }, Ct);
        var command = await TvApp.NextCommandAsync(agentB);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agentB, command);
        await round;

        await TvApp.WaitUntilAsync(async () =>
        {
            await using var check = app.Db();
            return await check.PowerSchedules.AnyAsync(x => x.TvId == tvB && x.Status == Schedule.Completed && x.Result == "off", Ct);
        }, "agendamento da TV B encerrado");
        await using var final = app.Db();
        (await final.PowerSchedules.SingleAsync(x => x.TvId == tvA, Ct)).Status.Should().Be(Schedule.Pending, "a TV A segue esperando o hello");
    }

    [Fact]
    public async Task ConnectedAgentThatNeverDeclaresCapabilities_EndsAsMissedWhenTheCeilingPasses()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        (await worker.RunOnceAsync(Ct)).Should().Be(1);

        app.Time.Advance(ScheduledPowerOffDispatcher.NotReadyRetryAfter + TimeSpan.FromSeconds(1));
        await SetDueAgoAsync(app, ScheduledPowerOffDispatcher.MaxLateness + TimeSpan.FromMinutes(1));
        await using var nextRound = app.Services.CreateAsyncScope();
        await nextRound.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);

        await WaitForResultAsync(app, "missed");
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ConcurrentWorkers_ClaimOneScheduleOnly()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendHelloAsync("1.0.0", "tv.remote", "tv.power.off.v1");
        await TvApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.Capabilities.Contains("tv.power.off.v1") == true,
            "capacidade de desligamento seguro");
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var first = app.Services.CreateAsyncScope();
        await using var second = app.Services.CreateAsyncScope();
        var one = first.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);
        var two = second.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>().RunOnceAsync(Ct);
        var command = await TvApp.NextCommandAsync(agent);
        command.GetProperty("type").GetString().Should().Be("tv.power.off.v1");
        await TvApp.ReplyAsync(agent, command);
        var runs = await Task.WhenAll(one, two);
        runs.Sum().Should().Be(1);
        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task ExpiredDispatch_IsMarkedUncertainWithoutRetry()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var tvId = await ConfigureAsync(app);
        await ScheduleAsync(app, tvId, app.Time.GetUtcNow().AddSeconds(1));
        await using (var db = app.Db())
        {
            var schedule = await db.PowerSchedules.SingleAsync(Ct);
            schedule.BeginDispatch(app.Time.GetUtcNow(), TimeSpan.FromSeconds(1));
            await db.SaveChangesAsync(Ct);
        }
        app.Time.Advance(TimeSpan.FromSeconds(2));
        await using var scope = app.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ScheduledPowerOffDispatcher>();
        (await worker.RunOnceAsync(Ct)).Should().Be(1);
        (await worker.RunOnceAsync(Ct)).Should().Be(0);
        await using var check = app.Db();
        (await check.PowerSchedules.SingleAsync(Ct)).Result.Should().Be("uncertain");
        (await check.CommandAudit.CountAsync(x => x.Command == TvCommandNames.PowerOff, Ct)).Should().Be(1);
    }
}
