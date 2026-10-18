using System.Diagnostics;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Messaging;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Messaging;

[Collection(PostgresGroup.Name)]
public class OutboxTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(TestDatabase Database, MessagingHarness Harness)> NewHarnessAsync(HarnessSettings? settings = null)
    {
        var database = await postgres.CreateDatabaseAsync();
        var harness = MessagingHarness.Create(database, settings);
        await harness.CreateSchemasAsync(database);
        return (database, harness);
    }

    private static async Task<int> CountAsync<TContext, TEntity>(MessagingHarness harness)
        where TContext : DbContext
        where TEntity : class
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<TContext>().Set<TEntity>().CountAsync(Ct);
    }

    [Fact]
    public async Task Publish_WithSaveChanges_StoresDataAndOutboxMessageTogether()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;

        var published = await harness.PublishAsync(1);

        (await CountAsync<OrdersDbContext, OrderRow>(harness)).Should().Be(1);
        var outbox = await harness.OutboxAsync();
        outbox.Should().ContainSingle();
        outbox[0].Id.Should().Be(published[0].Id);
        outbox[0].Type.Should().Be(OrderCreated.TypeName);
        outbox[0].ProcessedAt.Should().BeNull();
        outbox[0].Payload.Should().Contain("N-0");
    }

    [Fact]
    public async Task Publish_WhenTransactionRollsBack_LeavesNoOutboxMessageAndNoData()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;

        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
            var bus = scope.ServiceProvider.GetRequiredService<IEventBus>();
            await using var transaction = await db.Database.BeginTransactionAsync(Ct);

            var evt = OrderCreated.New();
            db.Set<OrderRow>().Add(new OrderRow { Id = evt.Id, Number = evt.Number });
            await bus.PublishAsync(evt, Ct);
            await db.SaveChangesAsync(Ct);
            await transaction.RollbackAsync(Ct);
        }

        (await harness.OutboxAsync()).Should().BeEmpty("rollback leva dado e evento juntos");
        (await CountAsync<OrdersDbContext, OrderRow>(harness)).Should().Be(0);
    }

    [Fact]
    public async Task Publish_WhenSaveChangesFails_LeavesNoOutboxMessage()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;

        // Uma linha já existe com este id; a segunda gravação viola a chave primária no banco.
        var existingId = Guid.NewGuid();
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
            db.Set<OrderRow>().Add(new OrderRow { Id = existingId, Number = "A" });
            await db.SaveChangesAsync(Ct);
        }

        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
            var bus = scope.ServiceProvider.GetRequiredService<IEventBus>();
            db.Set<OrderRow>().Add(new OrderRow { Id = existingId, Number = "B" });
            await bus.PublishAsync(OrderCreated.New(), Ct);

            var save = async () => await db.SaveChangesAsync(Ct);
            await save.Should().ThrowAsync<DbUpdateException>();
        }

        (await harness.OutboxAsync()).Should().BeEmpty();
    }

    [Fact]
    public async Task Publish_ForModuleWithoutOutbox_ThrowsCompositionError()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;

        await using var scope = harness.Services.CreateAsyncScope();
        var bus = scope.ServiceProvider.GetRequiredService<IEventBus>();

        var publish = async () => await bus.PublishAsync(new UnroutedEvent(Guid.NewGuid(), DateTimeOffset.UtcNow), Ct);

        (await publish.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*ghost*");
    }

    [Fact]
    public async Task Dispatcher_DeliversEventOnceAndMarksItProcessed()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;
        await harness.StartAsync();

        var published = await harness.PublishAsync(1);

        await MessagingHarness.EventuallyAsync(
            async () => (await harness.OutboxAsync()).All(m => m.ProcessedAt is not null), "mensagem processada");
        harness.Probe.Delivered[published[0].Id].Should().Be(1);
        var outbox = await harness.OutboxAsync();
        outbox[0].Attempts.Should().Be(0);
        outbox[0].LastError.Should().BeNull();
    }

    [Fact]
    public async Task Dispatcher_RetriesWithGrowingBackoff_UsingTheFakeClock()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { Time = clock });
        await using var _h = harness;
        harness.Probe.FailuresBeforeSuccess = 2;
        await harness.StartAsync();

        var published = await harness.PublishAsync(1);
        var id = published[0].Id;

        // 1ª falha: próxima tentativa em 5 s + até 20% de jitter.
        await MessagingHarness.EventuallyAsync(async () => (await harness.OutboxAsync())[0].Attempts == 1, "primeira falha");
        var afterFirst = (await harness.OutboxAsync())[0];
        var firstGap = afterFirst.NextAttemptAt - clock.GetUtcNow();
        firstGap.Should().BeGreaterThanOrEqualTo(TimeSpan.FromSeconds(5)).And.BeLessThanOrEqualTo(TimeSpan.FromSeconds(6));
        afterFirst.LastError.Should().Be(nameof(InvalidOperationException));

        // O relógio só anda quando o teste manda: nenhuma espera real de segundos.
        await MessagingHarness.EventuallyAsync(async () =>
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            return (await harness.OutboxAsync())[0].Attempts == 2;
        }, "segunda falha");
        var afterSecond = (await harness.OutboxAsync())[0];
        var secondGap = afterSecond.NextAttemptAt - clock.GetUtcNow();
        secondGap.Should().BeGreaterThanOrEqualTo(TimeSpan.FromSeconds(8), "o espaço dobra (10 s base, menos o tempo já corrido)").And.BeLessThanOrEqualTo(TimeSpan.FromSeconds(12));
        afterSecond.NextAttemptAt.Should().BeAfter(afterFirst.NextAttemptAt);

        await MessagingHarness.EventuallyAsync(async () =>
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            return (await harness.OutboxAsync())[0].ProcessedAt is not null;
        }, "terceira tentativa com sucesso");
        harness.Probe.Delivered[id].Should().Be(1);
        harness.Probe.Attempts[id].Should().Be(3);
        (await harness.OutboxAsync())[0].Attempts.Should().Be(2);
    }

    [Fact]
    public async Task Dispatcher_MovesMessageToDeadLettersAfterMaxAttempts()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { Time = clock, MaxAttempts = 3 });
        await using var _h = harness;
        harness.Probe.AlwaysFail = true;
        await harness.StartAsync();

        var published = await harness.PublishAsync(1);
        var id = published[0].Id;

        await MessagingHarness.EventuallyAsync(async () =>
        {
            clock.Advance(TimeSpan.FromSeconds(2));
            return (await harness.DeadLettersAsync()).Count == 1;
        }, "dead letter");

        var dead = (await harness.DeadLettersAsync()).Single();
        dead.Id.Should().Be(id);
        dead.Attempts.Should().Be(3);
        dead.Type.Should().Be(OrderCreated.TypeName);
        dead.LastError.Should().Be(nameof(InvalidOperationException));
        (await harness.OutboxAsync())[0].ProcessedAt.Should().NotBeNull("sai da fila");

        // Depois de morta, não volta a ser entregue.
        clock.Advance(TimeSpan.FromHours(1));
        await Task.Delay(300, Ct);
        harness.Probe.Attempts[id].Should().Be(3);
    }

    [Fact]
    public async Task Dispatcher_TreatsUnregisteredEventTypeAsFailure_NeverDropsSilently()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { Time = clock, MaxAttempts = 2, WithProbe = false });
        await using var _h = harness;
        await harness.StartAsync();

        await harness.PublishAsync(1);

        await MessagingHarness.EventuallyAsync(async () =>
        {
            clock.Advance(TimeSpan.FromSeconds(2));
            return (await harness.DeadLettersAsync()).Count == 1;
        }, "dead letter de tipo desconhecido");
    }

    [Fact]
    public async Task TwoDispatchers_NeverDeliverTheSameEventTwice_AndDeliverAll()
    {
        const int total = 200;
        var database = await postgres.CreateDatabaseAsync();
        await using var first = MessagingHarness.Create(database);
        await using var second = MessagingHarness.Create(database);
        await first.CreateSchemasAsync(database);

        // Demora curta no assinante para as duas instâncias disputarem lotes de verdade.
        first.Probe.Delay = TimeSpan.FromMilliseconds(5);
        second.Probe.Delay = TimeSpan.FromMilliseconds(5);

        var published = await first.PublishAsync(total);
        await Task.WhenAll(first.StartAsync(), second.StartAsync());

        await MessagingHarness.EventuallyAsync(
            async () => (await first.OutboxAsync()).All(m => m.ProcessedAt is not null),
            "todas as mensagens processadas",
            timeoutSeconds: 60);

        var byFirst = first.Probe.Delivered;
        var bySecond = second.Probe.Delivered;
        byFirst.Keys.Intersect(bySecond.Keys).Should().BeEmpty("nenhum id pode ser entregue por duas instâncias");
        byFirst.Values.Concat(bySecond.Values).Should().OnlyContain(n => n == 1, "nenhum id é entregue duas vezes");
        byFirst.Keys.Concat(bySecond.Keys).Should().BeEquivalentTo(published.Select(p => p.Id), "todos os ids são entregues");
        byFirst.Should().NotBeEmpty("as duas instâncias precisam ter disputado a fila");
        bySecond.Should().NotBeEmpty("as duas instâncias precisam ter disputado a fila");
    }

    [Fact]
    public async Task IdempotentHandler_WhenRedelivered_DoesNotRepeatTheEffect()
    {
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { WithProbe = false, WithProjection = true });
        await using var _h = harness;
        var evt = OrderCreated.New("N-9");

        for (var i = 0; i < 3; i++)
        {
            await using var scope = harness.Services.CreateAsyncScope();
            var handler = scope.ServiceProvider.GetRequiredService<OrderProjection>();
            await handler.HandleAsync(evt, Ct);
        }

        (await CountAsync<BillingDbContext, EffectRow>(harness)).Should().Be(1);
        (await CountAsync<BillingDbContext, InboxMessage>(harness)).Should().Be(1);
    }

    [Fact]
    public async Task IdempotentHandler_WhenEffectFails_LeavesNoInboxRecordSoItCanBeRetried()
    {
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { WithProbe = false, WithProjection = true });
        await using var _h = harness;
        var evt = OrderCreated.New();

        harness.Projection.FailAfterEffect = true;
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var failing = async () => await scope.ServiceProvider.GetRequiredService<OrderProjection>().HandleAsync(evt, Ct);
            await failing.Should().ThrowAsync<InvalidOperationException>();
        }

        (await CountAsync<BillingDbContext, EffectRow>(harness)).Should().Be(0);
        (await CountAsync<BillingDbContext, InboxMessage>(harness)).Should().Be(0);

        harness.Projection.FailAfterEffect = false;
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<OrderProjection>().HandleAsync(evt, Ct);
        }

        (await CountAsync<BillingDbContext, EffectRow>(harness)).Should().Be(1);
    }

    [Fact]
    public async Task IdempotentHandler_WhenTwoDeliveriesRace_AppliesTheEffectOnce()
    {
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { WithProbe = false, WithProjection = true });
        await using var _h = harness;
        var evt = OrderCreated.New();

        await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            await using var scope = harness.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<OrderProjection>().HandleAsync(evt, Ct);
        }));

        (await CountAsync<BillingDbContext, EffectRow>(harness)).Should().Be(1);
    }

    [Fact]
    public async Task EmptyQueue_DoesNotQueryTheDatabase_AndDeliveryAfterSaveIsPromptBySignal()
    {
        var (_, harness) = await NewHarnessAsync();
        await using var _h = harness;
        await harness.StartAsync();

        // Deixa a varredura de partida terminar e então a fila vazia precisa ficar em silêncio.
        await MessagingHarness.EventuallyAsync(
            () => Task.FromResult(harness.Commands.For<OrdersDbContext>() > 0 && harness.Commands.For<BillingDbContext>() > 0),
            "varredura de partida de cada módulo");
        await Task.Delay(500, Ct);
        var before = harness.Commands.Total;

        await Task.Delay(TimeSpan.FromSeconds(3), Ct);
        harness.Commands.Total.Should().Be(before, "sem sinal e sem retry, nada consulta o banco (o Neon dorme)");

        var clock = Stopwatch.StartNew();
        var published = await harness.PublishAsync(1);
        await MessagingHarness.EventuallyAsync(
            () => Task.FromResult(harness.Probe.Delivered.ContainsKey(published[0].Id)), "entrega por sinal", timeoutSeconds: 2);
        clock.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ReserveSweep_IsOneSharedClock_ThatWakesAllModulesAtTheSameTick()
    {
        const int idle = 3600;
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var (_, harness) = await NewHarnessAsync(new HarnessSettings { Time = clock, IdlePollSeconds = idle });
        await using var _h = harness;
        await harness.StartAsync();

        await MessagingHarness.EventuallyAsync(
            () => Task.FromResult(harness.Commands.For<OrdersDbContext>() > 0 && harness.Commands.For<BillingDbContext>() > 0),
            "varredura de partida de cada módulo");
        await Task.Delay(300, Ct);

        clock.CreatedTimers.Count(t => t.Period == TimeSpan.FromSeconds(idle))
            .Should().Be(1, "um único relógio de reserva para todos os módulos");

        var ordersBefore = harness.Commands.For<OrdersDbContext>();
        var billingBefore = harness.Commands.For<BillingDbContext>();

        clock.Advance(TimeSpan.FromSeconds(idle - 60));
        await Task.Delay(300, Ct);
        harness.Commands.For<OrdersDbContext>().Should().Be(ordersBefore, "antes do tique ninguém varre");
        harness.Commands.For<BillingDbContext>().Should().Be(billingBefore);

        clock.Advance(TimeSpan.FromSeconds(60));
        await MessagingHarness.EventuallyAsync(
            () => Task.FromResult(
                harness.Commands.For<OrdersDbContext>() > ordersBefore && harness.Commands.For<BillingDbContext>() > billingBefore),
            "as duas varreduras no mesmo tique");
    }

    [Fact]
    public void AddModuleOutbox_WithInvalidSchemaOrModuleKey_IsRejectedAtRegistration()
    {
        var services = new ServiceCollection();

        var badSchema = () => services.AddModuleOutbox<OrdersDbContext>("orders", "x; drop schema public");
        var badKey = () => services.AddModuleOutbox<OrdersDbContext>("Orders Module");

        badSchema.Should().Throw<ArgumentException>();
        badKey.Should().Throw<ArgumentException>();
    }

    [Fact]
    public async Task Tables_LiveOnlyInTheModuleSchemas_WithNoForeignKeys()
    {
        var (database, harness) = await NewHarnessAsync();
        await using var _h = harness;

        await using var connection = new Npgsql.NpgsqlConnection(database.OwnerConnection);
        await connection.OpenAsync(Ct);

        async Task<List<string>> Query(string sql)
        {
            await using var command = new Npgsql.NpgsqlCommand(sql, connection);
            await using var reader = await command.ExecuteReaderAsync(Ct);
            var rows = new List<string>();
            while (await reader.ReadAsync(Ct))
            {
                rows.Add(reader.GetString(0));
            }

            return rows;
        }

        var tables = await Query(
            "SELECT table_schema || '.' || table_name FROM information_schema.tables "
            + "WHERE table_name IN ('outbox_messages','dead_letters','inbox_messages') ORDER BY 1");
        var foreignKeys = await Query("SELECT conname FROM pg_constraint WHERE contype = 'f'");
        var partialIndex = await Query(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_outbox_messages_pending' AND schemaname = 'msg_orders'");

        tables.Should().Equal(
            "msg_billing.dead_letters", "msg_billing.inbox_messages", "msg_billing.outbox_messages",
            "msg_orders.dead_letters", "msg_orders.inbox_messages", "msg_orders.outbox_messages");
        foreignKeys.Should().BeEmpty();
        partialIndex.Should().ContainSingle().Which.Should().Contain("WHERE (processed_at IS NULL)");
    }
}
