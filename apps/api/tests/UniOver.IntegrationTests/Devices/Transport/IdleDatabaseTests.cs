using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Identity.Guests;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Agents;
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

    private static OutboundMessage Key() =>
        new("tv.key.v1", JsonSerializer.SerializeToElement(TransportApp.TvKeyBody()));

    /// <summary>Um pedido que deve falhar na hora: sem andar o relógio falso, e em menos de um segundo de relógio real.</summary>
    private static async Task<TimeSpan> FailsAtOnceAsync(TransportApp app)
    {
        var clock = Stopwatch.StartNew();
        var result = await app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(8), Ct).WaitAsync(TimeSpan.FromSeconds(5), Ct);
        clock.Stop();
        result.IsFailure.Should().BeTrue();
        result.Error.Code.Should().Be(AgentErrors.StalledCode);
        clock.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(1));
        return clock.Elapsed;
    }

    /// <summary>O agente responde ao próximo comando que chegar: o pedido sai e volta com sucesso.</summary>
    private static async Task AnswersAsync(TransportApp app, FakeAgent agent)
    {
        var request = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(8), Ct);
        var command = (await agent.ReceiveAsync())!.Value;
        command.GetProperty("type").GetString().Should().Be("tv.key.v1");
        await agent.SendTextAsync(agent.Envelope("command.result.v1", new JsonObject { ["ok"] = true }, command.GetProperty("id").GetGuid()));
        (await request.WaitAsync(FakeAgent.Patience, Ct)).IsSuccess.Should().BeTrue();
    }

    [Fact]
    public async Task AMuteAgent_FailsCommandsAtOnce_AndRecovers_WithoutASingleQuery()
    {
        var counter = new CommandCounter();
        await using var app = await TransportApp.StartAsync(postgres, Options(counter));
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "1.2.3", "hello aceito");
        await RunAsync(app, agent, TimeSpan.FromMinutes(12), TimeSpan.FromSeconds(30));
        await Task.Delay(300, Ct);

        counter.Enabled = true;

        var health = app.App.Services.GetRequiredService<AgentHealth>();

        // Sem uso: o PC paginado fica mudo (socket aberto). Aos 34 s ainda é um batimento atrasado; aos 35 s, "sem resposta".
        app.App.Time.Advance(TimeSpan.FromSeconds(34));
        health.Of(app.Agent.Slug).Should().Be(AgentHealthState.Ready);
        app.App.Time.Advance(TimeSpan.FromSeconds(1));
        health.Of(app.Agent.Slug).Should().Be(AgentHealthState.Unresponsive);
        app.Presence.Get(app.Agent.Slug)!.Connected.Should().BeTrue("o socket segue aberto: a presença não muda");
        await FailsAtOnceAsync(app);
        await FailsAtOnceAsync(app);

        // Voltou a falar (o batimento depois da pausa): pronto de novo, e o comando sai e é respondido.
        await KeepAliveAsync(agent);
        await TransportApp.WaitUntilAsync(() => health.Of(app.Agent.Slug) == AgentHealthState.Ready, "pronto depois do batimento");
        await AnswersAsync(app, agent);

        // Com uso, a TV demorando: dois comandos estouram o prazo juntos com o batimento em dia. É só lento, e o seguinte sai.
        var slow = new[]
        {
            app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(8), Ct),
            app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(8), Ct),
        };
        (await agent.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("tv.key.v1");
        (await agent.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("tv.key.v1");
        app.App.Time.Advance(TimeSpan.FromSeconds(8));
        foreach (var missed in slow)
        {
            (await missed.WaitAsync(FakeAgent.Patience, Ct)).Error.Code.Should().Be(AgentErrors.TimeoutCode);
        }

        health.Of(app.Agent.Slug).Should().Be(AgentHealthState.Slow);
        await AnswersAsync(app, agent);
        health.Of(app.Agent.Slug).Should().Be(AgentHealthState.Ready);

        // O laço para no meio do uso: aos 35 s sem nada, "sem resposta", e o comando volta na hora.
        app.App.Time.Advance(TimeSpan.FromSeconds(35));
        health.Of(app.Agent.Slug).Should().Be(AgentHealthState.Unresponsive);
        var fast = await FailsAtOnceAsync(app);

        // Voltou: o batimento o tira do mudo e a resposta seguinte confirma.
        await KeepAliveAsync(agent);
        await TransportApp.WaitUntilAsync(() => health.Of(app.Agent.Slug) == AgentHealthState.Ready, "pronto depois do batimento");
        await AnswersAsync(app, agent);

        await Task.Delay(300, Ct);
        counter.Enabled = false;
        counter.Count.Should().Be(0, $"a saúde é só memória: medir, falhar na hora e voltar não consultam o banco ({counter.Summary}); falha rápida em {fast.TotalMilliseconds} ms");
    }

    private const string FakeSdp =
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\n";

    /// <summary>Abre um canal direto como o app (a oferta pela API) e o agente simulado (a resposta e o resultado).</summary>
    private static async Task<Guid> OpenDirectAsync(TransportApp app, FakeAgent agent, string bearer)
    {
        var posting = app.App.SendAsync(HttpMethod.Post, "/api/v1/pc/rtc/offer", new { sdp = FakeSdp }, bearer);
        var command = (await agent.ReceiveAsync())!.Value;
        command.GetProperty("type").GetString().Should().Be("pc.rtc.offer.v1");
        var id = command.GetProperty("id").GetGuid();
        var sessionId = command.GetProperty("body").GetProperty("sessionId").GetGuid();
        await agent.SendTextAsync(agent.Envelope("pc.rtc.answer.v1", new JsonObject { ["sessionId"] = sessionId, ["sdp"] = "ANSWER-SDP" }, id));
        await agent.SendTextAsync(agent.Envelope("command.result.v1", new JsonObject { ["ok"] = true }, id));
        using var response = await posting.WaitAsync(FakeAgent.Patience, Ct);
        response.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        return sessionId;
    }

    [Fact]
    public async Task TheParityNumbers_AreMeasuredAndRead_WithoutASingleQuery()
    {
        var counter = new CommandCounter();
        await using var app = await TransportApp.StartAsync(postgres, Options(counter));
        await using var agent = await app.ConnectAsync();
        await agent.SendHelloAsync("1.2.3", "tv.remote", "transport.keepalive.v1", "pc.control.v1", "pc.rtc.v1");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "1.2.3", "hello aceito");
        await RunAsync(app, agent, TimeSpan.FromMinutes(12), TimeSpan.FromSeconds(30));

        // Entrar e abrir o canal direto gravam (a sessão e a trilha): é antes de o contador ligar, como o uso de verdade.
        var owner = (await app.App.LoginAsync()).AccessToken;
        var sessionId = await OpenDirectAsync(app, agent, owner);
        // Um convidado com o controle do PC: conferir a permissão dele leria o banco (cache frio). A rota do uso não confere.
        var guest = await GuestSeed.CreateGuestAsync(
            app.App.Client, app.App.Database, app.App.Time.GetUtcNow(), "Raphael", ["module:pc"]);
        await Task.Delay(300, Ct);

        counter.Enabled = true;

        // A nuvem: cinco teclas respondidas, uma por segundo, e uma que fica sem resposta (o batimento em dia: só lenta).
        for (var i = 0; i < 5; i++)
        {
            app.App.Time.Advance(TimeSpan.FromSeconds(1));
            await AnswersAsync(app, agent);
        }

        app.App.Time.Advance(TimeSpan.FromSeconds(1));
        var missed = app.Gateway.RequestAsync(app.Agent.Slug, Key(), TimeSpan.FromSeconds(8), Ct);
        (await agent.ReceiveAsync())!.Value.GetProperty("type").GetString().Should().Be("tv.key.v1");
        await KeepAliveAsync(agent);
        app.App.Time.Advance(TimeSpan.FromSeconds(8));
        (await missed.WaitAsync(FakeAgent.Patience, Ct)).Error.Code.Should().Be(AgentErrors.TimeoutCode);

        // O canal direto, um minuto depois: o app manda o total de 54 s de uso (sem banco: a sessão do canal é da memória e é ela que
        // autoriza). O convidado, que não é dono da sessão, é recusado também sem banco.
        await KeepAliveAsync(agent);
        app.App.Time.Advance(TimeSpan.FromSeconds(50));
        await KeepAliveAsync(agent);
        using (var usage = await app.App.SendAsync(HttpMethod.Post, $"/api/v1/pc/rtc/{sessionId}/usage", new { totalSeconds = 54 }, owner))
        {
            usage.StatusCode.Should().Be(System.Net.HttpStatusCode.NoContent);
        }

        using (var guestUsage = await app.App.SendAsync(
            HttpMethod.Post, $"/api/v1/pc/rtc/{sessionId}/usage", new { totalSeconds = 54 }, guest.Login.AccessToken))
        {
            guestUsage.StatusCode.Should().Be(System.Net.HttpStatusCode.Forbidden);
        }

        // O batimento deste agente ainda não traz o atraso do laço (fase 2): a leitura fica vazia, sem erro.
        await KeepAliveAsync(agent);

        using var read = await app.App.SendAsync(HttpMethod.Get, "/api/v1/devices/agents/parity", bearer: owner);
        read.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var body = await DevicesApp.JsonAsync(read);

        await Task.Delay(300, Ct);
        counter.Enabled = false;
        counter.Count.Should().Be(0, $"os números da paridade são só memória: medir, mandar o uso e ler não consultam o banco ({counter.Summary})");

        body.GetProperty("windowMinutes").GetInt32().Should().Be(30);
        var pc = body.GetProperty("agents").EnumerateArray().Single(a => a.GetProperty("agentId").GetString() == app.Agent.Slug);
        pc.GetProperty("cloudSeconds").GetInt32().Should().Be(6, "seis segundos com tecla pela nuvem");
        pc.GetProperty("directSeconds").GetInt32().Should().Be(54);
        pc.GetProperty("directPercent").GetInt32().Should().Be(90);
        pc.GetProperty("replySamples").GetInt32().Should().Be(5);
        pc.GetProperty("replyP50Ms").ValueKind.Should().Be(JsonValueKind.Number);
        pc.GetProperty("replyP95Ms").ValueKind.Should().Be(JsonValueKind.Number);
        pc.GetProperty("loopLagSamples").GetInt32().Should().Be(0);
        (pc.TryGetProperty("loopLagP99Ms", out var lag) ? lag.ValueKind : JsonValueKind.Null).Should().Be(JsonValueKind.Null, "sem o atraso, a tela mostra \"—\"");
        pc.GetProperty("unanswered").GetInt32().Should().Be(1);
    }
}
