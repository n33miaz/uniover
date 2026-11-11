using System.Collections.Concurrent;
using System.Data.Common;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>
/// O banco de produção é um Neon gratuito: dorme depois de 5 min sem consulta e o plano tem um teto mensal de horas acordado.
/// Estes testes provam, com o host inteiro (todos os módulos e seus serviços em segundo plano), Postgres real e relógio falso,
/// que a API parada não faz consulta nenhuma, mesmo com o computador do dono conectado mandando batimento, e que as quedas
/// continuam saindo no instante certo sem nenhum tique.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class IdleDatabaseTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Conta todo comando que chega ao banco, de qualquer módulo, enquanto estiver ligado, guardando o início do texto.</summary>
    private sealed class CommandCounter : DbCommandInterceptor
    {
        private readonly ConcurrentQueue<string> _seen = new();
        private volatile bool _enabled;

        public bool Enabled
        {
            get => _enabled;
            set => _enabled = value;
        }

        public int Count => _seen.Count;

        public string Summary => string.Join(" | ", _seen.Take(8).Select(Shorten));

        private static string Shorten(string text)
        {
            var line = text.ReplaceLineEndings(" ");
            return line.Length <= 90 ? line : line[..90];
        }

        public override ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return base.ReaderExecutedAsync(command, eventData, result, cancellationToken);
        }

        public override ValueTask<int> NonQueryExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return base.NonQueryExecutedAsync(command, eventData, result, cancellationToken);
        }

        public override ValueTask<object?> ScalarExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, object? result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return base.ScalarExecutedAsync(command, eventData, result, cancellationToken);
        }

        private void Observe(DbCommand command)
        {
            if (_enabled)
            {
                _seen.Enqueue(command.CommandText);
            }
        }
    }

    private static DevicesAppOptions Options(CommandCounter counter) => new()
    {
        // A graça de produção: é ela que liga o resumo de presença que a partida lê a cada 10 s nos primeiros minutos.
        PresenceGraceSeconds = 150,
        ConfigureServices = services =>
        {
            services.ConfigureDbContext<DevicesDbContext>(builder => builder.AddInterceptors(counter));
            services.ConfigureDbContext<TvDbContext>(builder => builder.AddInterceptors(counter));
            services.ConfigureDbContext<IdentityDbContext>(builder => builder.AddInterceptors(counter));
            services.ConfigureDbContext<TrainingDbContext>(builder => builder.AddInterceptors(counter));
        },
    };

    private static Task KeepAliveAsync(FakeAgent agent) =>
        agent.SendTextAsync(agent.Envelope("agent.keepalive.v1", new JsonObject()));

    /// <summary>Anda o relógio falso em passos e dá tempo real para os laços de fundo reagirem; o agente manda batimento a cada passo.</summary>
    private static async Task RunAsync(TransportApp app, FakeAgent? agent, TimeSpan total, TimeSpan step, Func<TimeSpan, Task>? each = null)
    {
        for (var elapsed = TimeSpan.Zero; elapsed < total; elapsed += step)
        {
            app.App.Time.Advance(step);
            if (agent is not null)
            {
                await KeepAliveAsync(agent);
            }

            if (each is not null)
            {
                await each(elapsed + step);
            }

            await Task.Delay(30, Ct);
        }
    }

    [Fact]
    public async Task AConnectedAgentOnAnIdleApi_NeverTouchesTheDatabase_ForTenMinutes()
    {
        var counter = new CommandCounter();
        await using var app = await TransportApp.StartAsync(postgres, Options(counter));
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "1.2.3", "hello aceito");

        // Os primeiros minutos da vida do processo não são ociosos de propósito (a leitura do resumo da presença a cada 10 s, a
        // espera curta do desligamento agendado, a primeira limpeza diária aos 10 min). Passada essa janela, a API parada dorme.
        await RunAsync(app, agent, TimeSpan.FromMinutes(12), TimeSpan.FromSeconds(30));
        await Task.Delay(300, Ct);

        counter.Enabled = true;
        await RunAsync(app, agent, TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1), async elapsed =>
        {
            if (elapsed == TimeSpan.FromMinutes(5))
            {
                // O agente repete o mesmo hello a cada 5 min: sem novidade, não é escrita.
                await agent.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1");
            }
        });
        await Task.Delay(300, Ct);
        counter.Enabled = false;

        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue("o agente seguiu conectado a janela inteira");
        counter.Count.Should().Be(0, $"dez minutos de API ociosa com um agente conectado mandando batimento: nenhuma consulta ({counter.Summary})");

        // O contador enxerga o banco de fato: um hello com versão nova (novidade de verdade) é gravado.
        counter.Enabled = true;
        await agent.SendHelloAsync("1.2.4", "tv.remote", "transport.keepalive.v1");
        await TransportApp.WaitUntilAsync(() => counter.Count > 0, "gravação do hello novo");
        counter.Enabled = false;
    }

    [Fact]
    public async Task ADroppedAgent_OpensTheOutageAtTheLimit_AndComingBackClosesIt_WithNoTick()
    {
        var counter = new CommandCounter();
        await using var app = await TransportApp.StartAsync(postgres, Options(counter));
        await using (var agent = await app.ConnectAsync())
        {
            await agent.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1");
            await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "1.2.3", "hello aceito");
            await RunAsync(app, agent, TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(30));
        }

        var droppedAt = app.App.Time.GetUtcNow();
        // A graça de presença (150 s) corre no relógio falso: só depois dela a queda vale.
        await TransportApp.WaitUntilAsync(() =>
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(10));
            return Task.FromResult(app.Presence.Get(app.Agent.Slug)?.Connected == false);
        }, "agente desconectado depois da graça");

        // O limite padrão é de 10 min: a queda é agendada para o último sinal + 10 min e nada acontece antes.
        var untilLimit = droppedAt.AddMinutes(10) - app.App.Time.GetUtcNow() - TimeSpan.FromSeconds(30);
        await RunAsync(app, null, untilLimit, TimeSpan.FromSeconds(10));
        await using (var early = app.App.Db())
        {
            (await early.AgentOutages.CountAsync(Ct)).Should().Be(0, "ainda dentro do limite");
        }

        await TransportApp.WaitUntilAsync(async () =>
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(5));
            await using var db = app.App.Db();
            return await db.AgentOutages.AnyAsync(o => o.RecoveredAt == null, Ct);
        }, "queda aberta no instante do limite");
        await using (var db = app.App.Db())
        {
            var outage = await db.AgentOutages.SingleAsync(Ct);
            outage.DetectedAt.Should().BeAfter(droppedAt.AddMinutes(10).AddSeconds(-1));
            (await db.PairingAudit.CountAsync(a => a.Event == "agent_offline", Ct)).Should().Be(1);
        }

        // A volta fecha a queda aberta sem ninguém olhar a tela.
        await using var back = await app.ConnectAsync();
        await back.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1");
        await TransportApp.WaitUntilAsync(async () =>
        {
            await using var db = app.App.Db();
            return await db.AgentOutages.AnyAsync(o => o.RecoveredAt != null, Ct);
        }, "queda encerrada na volta");
        await using var check = app.App.Db();
        (await check.PairingAudit.CountAsync(a => a.Event == "agent_online", Ct)).Should().Be(1);
    }
}
