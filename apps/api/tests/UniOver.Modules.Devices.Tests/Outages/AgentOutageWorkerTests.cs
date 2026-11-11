using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Features.Outages;
using UniOver.Modules.Devices.Features.RemoteCare;

namespace UniOver.Modules.Devices.Tests.Outages;

/// <summary>
/// O laço das quedas decide em memória: o prazo em que a próxima queda vale (último sinal mais o limite) fica guardado, o sono é
/// em passos de no máximo um minuto (reconferindo o relógio de parede sem consultar o banco), e o laço é acordado pela presença
/// (caiu, voltou, foi revogado). Só consulta o banco (a conciliação) ao chegar a hora, nesses eventos, na partida e na reserva.
/// O relógio é falso e cada espera cria exatamente um temporizador, então a prova é o passo do tempo e a contagem de conciliações.
/// </summary>
public sealed class AgentOutageWorkerTests
{
    private static readonly DateTimeOffset Start = new(2026, 11, 11, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Limit = TimeSpan.FromMinutes(10);

    private sealed class FakeCheck : IOutageCheck
    {
        private int _checks;

        public int Checks => Volatile.Read(ref _checks);

        public Func<DateTimeOffset?> NextDue { get; set; } = () => null;

        public Func<bool> Fails { get; set; } = () => false;

        public TaskCompletionSource? Gate { get; set; }

        public async Task<OutageCheck> CheckAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _checks);
            if (Gate is { } gate)
            {
                await gate.Task.WaitAsync(cancellationToken);
            }

            return Fails() ? throw new InvalidOperationException("banco fora do ar") : new OutageCheck(NextDue(), Limit);
        }
    }

    private sealed class Rig : IAsyncDisposable
    {
        private readonly AgentOutageWorker _worker;

        public Rig(DateTimeOffset? startedAt = null, Action<DevicesModuleOptions>? configure = null)
        {
            var settings = new DevicesModuleOptions();
            configure?.Invoke(settings);
            Time = new FakeTimeProvider(Start);
            Check = new FakeCheck();
            Wake = new AgentOutageWake();
            var scopes = new ServiceCollection().AddSingleton<IOutageCheck>(Check).BuildServiceProvider()
                .GetRequiredService<IServiceScopeFactory>();
            _worker = new AgentOutageWorker(
                scopes, Time, Wake, new PublishedBuild(null, startedAt ?? Start),
                Microsoft.Extensions.Options.Options.Create(settings), NullLogger<AgentOutageWorker>.Instance);
        }

        public FakeTimeProvider Time { get; }

        public FakeCheck Check { get; }

        public AgentOutageWake Wake { get; }

        public Task StartAsync() => _worker.StartAsync(TestContext.Current.CancellationToken);

        /// <summary>O prazo que a espera de número <paramref name="wait"/> (1, 2, ...) armou.</summary>
        public TimeSpan ArmedDelay(int wait) => Time.CreatedTimers[wait - 1].Due;

        /// <summary>Espera o laço ter feito <paramref name="checks"/> conciliação(ões) e estar dormindo na espera de número <paramref name="waits"/>.</summary>
        public async Task ParkedAsync(int checks, int waits)
        {
            for (var i = 0; i < 500; i++)
            {
                if (Check.Checks == checks && Time.CreatedTimers.Count == waits)
                {
                    return;
                }

                await Task.Delay(10, TestContext.Current.CancellationToken);
            }

            throw new TimeoutException(
                $"Esperava {checks} conciliação(ões) e {waits} espera(s); houve {Check.Checks} e {Time.CreatedTimers.Count}.");
        }

        public TimeSpan LastArmedDelay => Time.CreatedTimers[^1].Due;

        /// <summary>Anda o relógio exatamente o último prazo armado (o temporizador dispara) e espera o laço dormir de novo.</summary>
        public async Task NextWakeUpAsync()
        {
            var waits = Time.CreatedTimers.Count;
            Time.Advance(LastArmedDelay);
            for (var i = 0; i < 500; i++)
            {
                if (Time.CreatedTimers.Count == waits + 1)
                {
                    return;
                }

                await Task.Delay(10, TestContext.Current.CancellationToken);
            }

            throw new TimeoutException("O laço não voltou a dormir depois do passo.");
        }

        public async Task NextWakeUpsAsync(int steps)
        {
            for (var i = 0; i < steps; i++)
            {
                await NextWakeUpAsync();
            }
        }

        public async ValueTask DisposeAsync()
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await _worker.StopAsync(cancel.Token);
            _worker.Dispose();
        }
    }

    private static AgentPresenceInfo Dropped(DateTimeOffset at) =>
        new("pc-sala", false, null, "1.0.0", [], at, at);

    private static AgentPresenceInfo Connected() =>
        new("pc-sala", true, Start, "1.0.0", [], Start);

    [Fact]
    public async Task OnStartup_ReconstructsFromTheDatabaseAndDoesNotTouchItBeforeTheEarliestDeadline()
    {
        await using var rig = new Rig();
        rig.Check.NextDue = () => Start.AddMinutes(7).AddSeconds(1);
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);
        rig.ArmedDelay(1).Should().Be(AgentOutageWorker.MaxSleep, "o sono seguido nunca passa de um minuto");

        await rig.NextWakeUpsAsync(7); // 7 min: o agente sem sinal só vale 1 s depois
        rig.Check.Checks.Should().Be(1, "nada antes do prazo: nenhuma consulta ao banco");

        rig.Check.NextDue = () => null;
        await rig.NextWakeUpAsync(); // o último passo é de 1 s (o que falta)
        rig.Check.Checks.Should().Be(2);
    }

    [Fact]
    public async Task ADropSchedulesTheCheckForTheLastSignalPlusTheLimit_AndTheDatabaseIsNotTouchedBefore()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);
        await rig.NextWakeUpsAsync(2); // t = 2 min

        // O agente caiu há 1 min (a graça já passou): a queda vale 10 min depois do último sinal (11 min e 1 s).
        rig.Wake.OnPresenceChanged(Dropped(Start.AddMinutes(1)));
        await rig.ParkedAsync(checks: 1, waits: 4);

        await rig.NextWakeUpsAsync(9); // t = 11 min
        rig.Check.Checks.Should().Be(1, "ainda dentro do limite: nenhuma consulta ao banco");
        await rig.NextWakeUpAsync(); // faltava 1 s
        rig.Check.Checks.Should().Be(2);
    }

    [Fact]
    public async Task ADropBeforeThisProcessStarted_CountsFromTheStartOfTheProcess()
    {
        // Depois de um deploy o último sinal é de antes da partida: o computador precisa de tempo para reconectar. Nenhuma instância
        // abre queda de agente que ainda não teve tempo de ver.
        await using var rig = new Rig(startedAt: Start.AddMinutes(-1));
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        rig.Wake.OnPresenceChanged(Dropped(Start.AddHours(-5)));
        await rig.ParkedAsync(checks: 1, waits: 2);

        await rig.NextWakeUpsAsync(9); // a partida foi há 1 min: faltam 9 min e a folga
        rig.Check.Checks.Should().Be(1);
        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(2);
    }

    [Fact]
    public async Task AnAgentThatComesBack_TriggersTheReconciliationAtOnce_SoTheOpenOutageCloses()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        rig.Wake.OnPresenceChanged(Connected());
        await rig.ParkedAsync(checks: 2, waits: 2);

        rig.Time.GetUtcNow().Should().Be(Start, "quem acordou o laço foi a presença, não o relógio");
    }

    [Fact]
    public async Task ARevocation_TriggersTheReconciliationAtOnce()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        await new AgentOutageRevokedHandler(rig.Wake).HandleAsync(
            new UniOver.Modules.Devices.Contracts.Pairing.AgentRevoked(Guid.NewGuid(), Start, Guid.NewGuid(), "pc-sala"),
            TestContext.Current.CancellationToken);
        await rig.ParkedAsync(checks: 2, waits: 2);
    }

    [Fact]
    public async Task TheReserveReconcilesEvenWithNothingHappening_InShortSteps()
    {
        await using var rig = new Rig(configure: o => o.OutageReserveMinutes = 3);
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        await rig.NextWakeUpsAsync(2);
        rig.Check.Checks.Should().Be(1);
        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(2, "a reserva de 3 min confere o banco");
    }

    [Fact]
    public async Task TheDefaultReserveIsSixHours()
    {
        new DevicesModuleOptions().OutageReserve.Should().Be(TimeSpan.FromHours(6));
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        rig.Time.Jump(TimeSpan.FromHours(6) - TimeSpan.FromMinutes(2));
        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(1, "faltando 1 min para as 6 h: ainda não");
        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(2);
    }

    [Fact]
    public async Task AWallClockJumpForward_IsNoticedWithinAMinute_WithoutWaitingTheOriginalSleep()
    {
        await using var rig = new Rig();
        rig.Check.NextDue = () => Start.AddHours(2);
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);

        rig.Time.Jump(TimeSpan.FromHours(2)); // o relógio de parede salta; os temporizadores só contam o minuto
        rig.Check.NextDue = () => null;
        await rig.NextWakeUpAsync();

        rig.Check.Checks.Should().Be(2, "o prazo, em memória, venceu pelo relógio: a consulta é feita no primeiro passo");
    }

    [Fact]
    public async Task ADropThatHappensDuringAReconciliation_IsNotLost()
    {
        await using var rig = new Rig();
        rig.Check.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await rig.StartAsync();
        for (var i = 0; i < 200 && rig.Check.Checks == 0; i++)
        {
            await Task.Delay(10, TestContext.Current.CancellationToken);
        }

        rig.Wake.OnPresenceChanged(Dropped(Start.AddSeconds(30))); // chega com a conciliação da partida ainda em curso
        rig.Check.Gate.SetResult();

        // A fila é lida antes de dormir: o prazo já nasce com a queda (10 min + 30 s + folga), não com a reserva.
        // (A primeira espera volta na hora porque o aviso da queda ainda estava pendente.)
        await rig.ParkedAsync(checks: 1, waits: 2);
        await rig.NextWakeUpsAsync(10); // t = 10 min
        rig.Check.Checks.Should().Be(1);
        await rig.NextWakeUpAsync(); // faltavam 31 s
        rig.Check.Checks.Should().Be(2);
    }

    [Fact]
    public async Task AFailedReconciliationBacksOff_AndRetriesTheWholeThing()
    {
        await using var rig = new Rig();
        var failing = true;
        rig.Check.Fails = () => failing;
        await rig.StartAsync();
        await rig.ParkedAsync(checks: 1, waits: 1);
        rig.ArmedDelay(1).Should().Be(TimeSpan.FromSeconds(30));

        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(2);
        rig.LastArmedDelay.Should().Be(TimeSpan.FromMinutes(1), "o recuo (60 s) cabe num passo");

        failing = false;
        await rig.NextWakeUpAsync();
        rig.Check.Checks.Should().Be(3);
    }

    [Fact]
    public void TheDeadlineIsTheLastSignalPlusTheLimit_NeverBeforeTheStartOfTheProcess()
    {
        var started = Start;
        AgentOutageMonitor.DueAt(Start.AddMinutes(5), started, Limit).Should().Be(Start.AddMinutes(15) + AgentOutageMonitor.DueSlack);
        AgentOutageMonitor.DueAt(Start.AddDays(-1), started, Limit).Should().Be(Start.AddMinutes(10) + AgentOutageMonitor.DueSlack);
    }

    [Fact]
    public void TheOptionsRejectAReserveOutsideOneMinuteAndOneDay()
    {
        DevicesModuleOptions.IsValid(new DevicesModuleOptions()).Should().BeTrue();
        DevicesModuleOptions.IsValid(new DevicesModuleOptions { OutageReserveMinutes = 0 }).Should().BeFalse();
        DevicesModuleOptions.IsValid(new DevicesModuleOptions { OutageReserveMinutes = 24 * 60 + 1 }).Should().BeFalse();
    }
}
