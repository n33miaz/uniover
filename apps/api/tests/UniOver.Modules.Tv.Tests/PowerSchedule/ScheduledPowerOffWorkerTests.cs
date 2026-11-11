using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Tv.Features.PowerSchedule;
using UniOver.Modules.Tv.Tests.Support;

namespace UniOver.Modules.Tv.Tests.PowerSchedule;

/// <summary>
/// O laço dos desligamentos agendados não tem tique: o prazo da próxima consulta fica em memória, o sono é em passos de no máximo
/// um minuto (reconferindo o relógio, sem consultar o banco) e só ao chegar a hora, ou ao receber o sinal, é que consulta. O
/// relógio é falso e cada espera cria exatamente um temporizador, então a prova é o prazo armado e a contagem de rodadas.
/// </summary>
public sealed class ScheduledPowerOffWorkerTests
{
    private static readonly DateTimeOffset Start = new(2026, 11, 11, 12, 0, 0, TimeSpan.Zero);

    private sealed class FakeQueue : IPowerOffQueue
    {
        private readonly List<DateTimeOffset> _sweeps = [];
        private int _runs;

        public int Runs => Volatile.Read(ref _runs);

        /// <summary>Quantas rodadas já perguntaram o próximo instante (uma por rodada).</summary>
        public int Wakes
        {
            get
            {
                lock (_sweeps)
                {
                    return _sweeps.Count;
                }
            }
        }

        /// <summary>O relógio no momento de cada rodada.</summary>
        public IReadOnlyList<DateTimeOffset> SweepTimes
        {
            get
            {
                lock (_sweeps)
                {
                    return [.. _sweeps];
                }
            }
        }

        public Func<DateTimeOffset> Clock { get; set; } = () => default;

        public Func<DateTimeOffset?> Next { get; set; } = () => null;

        public Func<bool> Fails { get; set; } = () => false;

        /// <summary>Quando definido, a pergunta do próximo instante espera por ele (simula uma rodada demorada).</summary>
        public TaskCompletionSource? Gate { get; set; }

        public Task<int> RunOnceAsync(CancellationToken ct)
        {
            Interlocked.Increment(ref _runs);
            return Task.FromResult(0);
        }

        public async Task<DateTimeOffset?> NextWakeAsync(CancellationToken ct)
        {
            lock (_sweeps)
            {
                _sweeps.Add(Clock());
            }

            if (Gate is { } gate)
            {
                await gate.Task.WaitAsync(ct);
            }

            return Fails() ? throw new InvalidOperationException("banco fora do ar") : Next();
        }
    }

    private sealed class Rig : IAsyncDisposable
    {
        private readonly ScheduledPowerOffWorker _worker;

        public Rig(Action<TvModuleOptions>? configure = null, bool startupWindow = false)
        {
            var settings = new TvModuleOptions { PowerOffStartupWindowMinutes = startupWindow ? 10 : 0 };
            configure?.Invoke(settings);
            Time = new FakeTimeProvider(Start);
            Queue = new FakeQueue { Clock = () => Time.GetUtcNow() };
            Signal = new PowerScheduleSignal();
            var scopes = new ServiceCollection().AddSingleton<IPowerOffQueue>(Queue).BuildServiceProvider()
                .GetRequiredService<IServiceScopeFactory>();
            _worker = new ScheduledPowerOffWorker(
                scopes, Time, Signal, Microsoft.Extensions.Options.Options.Create(settings), NullLogger<ScheduledPowerOffWorker>.Instance);
        }

        public FakeTimeProvider Time { get; }

        public FakeQueue Queue { get; }

        public PowerScheduleSignal Signal { get; }

        public Task StartAsync() => _worker.StartAsync(TestContext.Current.CancellationToken);

        /// <summary>O prazo que a espera de número <paramref name="wait"/> (1, 2, ...) armou.</summary>
        public TimeSpan ArmedDelay(int wait) => Time.CreatedTimers[wait - 1].Due;

        public TimeSpan LastArmedDelay => Time.CreatedTimers[^1].Due;

        /// <summary>Espera o laço ter feito <paramref name="sweeps"/> rodada(s) e estar dormindo na espera de número <paramref name="waits"/>.</summary>
        public async Task ParkedAsync(int sweeps, int waits)
        {
            for (var i = 0; i < 500; i++)
            {
                if (Queue.Wakes == sweeps && Time.CreatedTimers.Count == waits)
                {
                    return;
                }

                await Task.Delay(10, TestContext.Current.CancellationToken);
            }

            throw new TimeoutException(
                $"Esperava {sweeps} rodada(s) e {waits} espera(s); houve {Queue.Wakes} e {Time.CreatedTimers.Count}.");
        }

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

        public async ValueTask DisposeAsync()
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await _worker.StopAsync(cancel.Token);
            _worker.Dispose();
        }
    }

    [Fact]
    public async Task SweepsAtOnceOnStartup_SoARequestLeftPendingByAnInstanceThatStoppedIsFound()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddMinutes(30);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        rig.Queue.Runs.Should().Be(1, "a rodada da partida processa o que já estava devido");
        rig.Time.GetUtcNow().Should().Be(Start, "sem esperar tempo nenhum");
    }

    [Fact]
    public async Task SleepsInShortSteps_AndDoesNotTouchTheDatabaseUntilTheInstant()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddMinutes(10);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);
        rig.ArmedDelay(1).Should().Be(ScheduledPowerOffWorker.MaxSleep, "o sono seguido nunca passa de um minuto");

        for (var minute = 1; minute < 10; minute++)
        {
            await rig.NextWakeUpAsync();
            rig.Queue.Wakes.Should().Be(1, $"aos {minute} min o prazo (em memória) ainda não chegou: nenhuma consulta");
        }

        await rig.NextWakeUpAsync(); // 10 min: a hora combinada
        rig.Queue.Wakes.Should().Be(2);
        rig.Queue.Runs.Should().Be(2);
    }

    [Fact]
    public async Task AWallClockJumpForward_IsNoticedWithinAMinute_WithoutWaitingTheOriginalSleep()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddHours(2);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        rig.Time.Jump(TimeSpan.FromHours(2)); // o relógio de parede salta; os temporizadores só contam o minuto
        rig.Queue.Next = () => null;
        await rig.NextWakeUpAsync();

        rig.Queue.Wakes.Should().Be(2, "no primeiro passo o prazo (agora vencido pelo relógio) leva à consulta");
        rig.Queue.SweepTimes[1].Should().Be(Start.AddHours(2) + TimeSpan.FromMinutes(1));
    }

    [Fact]
    public async Task AWallClockJumpBack_MovesTheDeadlineWithTheWallClock_NotBeforeIt()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddMinutes(5);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        rig.Time.Jump(TimeSpan.FromHours(-1)); // o relógio recua: 12:05 só chega daqui a uma hora e 5 min de relógio de parede
        for (var i = 0; i < 6; i++)
        {
            await rig.NextWakeUpAsync();
        }

        rig.Queue.Wakes.Should().Be(1, "a hora combinada é do relógio de parede: não adianta só porque o tempo decorrido passou");
    }

    [Fact]
    public async Task WithNoOpenRequest_SleepsTheReserve_InShortSteps()
    {
        await using var rig = new Rig(o => o.PowerOffReserveMinutes = 5);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        for (var minute = 1; minute < 5; minute++)
        {
            await rig.NextWakeUpAsync();
            rig.Queue.Wakes.Should().Be(1);
        }

        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(2, "a reserva de 5 min confere o banco");
    }

    [Fact]
    public async Task TheDefaultReserveIsSixHours()
    {
        new TvModuleOptions().PowerOffReserve.Should().Be(TimeSpan.FromHours(6));

        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);
        rig.Time.Jump(TimeSpan.FromHours(6) - TimeSpan.FromMinutes(2));
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(1, "faltando 1 min para as 6 h: ainda não");
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(2, "na reserva de 6 h");
    }

    [Fact]
    public async Task ANextInstantBeyondTheReserve_IsCappedByIt()
    {
        await using var rig = new Rig(o => o.PowerOffReserveMinutes = 3);
        rig.Queue.Next = () => Start.AddDays(3);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        await rig.NextWakeUpAsync();
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(1);
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(2, "outra instância pode ter criado um pedido: a reserva confere");
    }

    [Fact]
    public async Task ASignal_WakesTheLoopAtOnce_AndTheNewInstantReplacesTheOldSleep()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        // Alguém agenda um desligamento para daqui a 3 min: o sinal acorda o laço, que passa a mirar essa hora.
        rig.Queue.Next = () => rig.Time.GetUtcNow().AddMinutes(3);
        rig.Signal.Notify();
        await rig.ParkedAsync(sweeps: 2, waits: 2);
        rig.Time.GetUtcNow().Should().Be(Start, "o relógio não andou: quem acordou o laço foi o sinal");

        await rig.NextWakeUpAsync();
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(2);
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(3, "na hora combinada");
    }

    [Fact]
    public async Task ASignalThatArrivesDuringASweep_IsNotLost()
    {
        await using var rig = new Rig();
        rig.Queue.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await rig.StartAsync();
        for (var i = 0; i < 200 && rig.Queue.Wakes == 0; i++)
        {
            await Task.Delay(10, TestContext.Current.CancellationToken);
        }

        rig.Signal.Notify(); // chega com a rodada em curso (ela ainda espera o banco)
        rig.Queue.Gate.SetResult();

        for (var i = 0; i < 500 && rig.Queue.Wakes < 2; i++)
        {
            await Task.Delay(10, TestContext.Current.CancellationToken);
        }

        rig.Queue.Wakes.Should().Be(2, "o aviso feito no meio da rodada vira outra rodada, sem esperar o tempo");
        rig.Time.GetUtcNow().Should().Be(Start);
    }

    [Fact]
    public async Task ARetryAfterTheAgentWasNotReady_WakesAtTheEndOfItsWait()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddSeconds(15);
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        rig.ArmedDelay(1).Should().Be(TimeSpan.FromSeconds(15));
        rig.Queue.Next = () => null;
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(2);
    }

    [Fact]
    public async Task AnInstantAlreadyPastThatNobodyTook_WaitsTheMinimumInsteadOfSpinning()
    {
        await using var rig = new Rig();
        rig.Queue.Next = () => Start.AddMinutes(-1); // por exemplo, outra instância segura a linha
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        rig.ArmedDelay(1).Should().Be(ScheduledPowerOffWorker.MinimumWait);
    }

    [Fact]
    public async Task InTheFirstMinutesAfterStart_TheDeadlineIsShort_ThenItGoesToTheReserve()
    {
        await using var rig = new Rig(o =>
        {
            o.PowerOffStartupWindowMinutes = 3;
            o.PowerOffStartupPollSeconds = 60;
            o.PowerOffReserveMinutes = 30;
        });
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        for (var minute = 1; minute <= 3; minute++)
        {
            await rig.NextWakeUpAsync();
            rig.Queue.Wakes.Should().Be(minute + 1, "numa troca de instância a antiga ainda pode receber um pedido que esta não viu");
        }

        for (var minute = 4; minute <= 12; minute++)
        {
            await rig.NextWakeUpAsync();
        }

        rig.Queue.Wakes.Should().Be(4, "passada a janela da partida, só a reserva");
    }

    [Fact]
    public async Task FailuresBackOffUpToTheCap_AndASuccessResets()
    {
        await using var rig = new Rig();
        var failing = true;
        rig.Queue.Fails = () => failing;
        await rig.StartAsync();
        await rig.ParkedAsync(sweeps: 1, waits: 1);

        // 15 s, 30 s, 60 s e depois o teto de 2 min (em dois passos de 1 min).
        for (var i = 0; i < 6; i++)
        {
            await rig.NextWakeUpAsync();
        }

        var offsets = rig.Queue.SweepTimes.Select(t => (int)(t - Start).TotalSeconds).ToList();
        offsets.Should().Equal(0, 15, 45, 105, 225);

        failing = false;
        await rig.NextWakeUpAsync();
        await rig.NextWakeUpAsync();
        var afterSuccess = rig.Queue.SweepTimes[^1];
        (afterSuccess - Start).Should().Be(TimeSpan.FromSeconds(225 + 120), "o teto de falhas é bem menor que o atraso máximo");
        rig.Queue.Wakes.Should().Be(6);
        // Com sucesso a espera volta à reserva (6 h): em passos curtos, sem novas rodadas.
        await rig.NextWakeUpAsync();
        rig.Queue.Wakes.Should().Be(6);
    }

    [Fact]
    public void TheOptionsRejectNonsense()
    {
        TvModuleOptions.IsValid(new TvModuleOptions()).Should().BeTrue();
        TvModuleOptions.IsValid(new TvModuleOptions { PowerOffReserveMinutes = 0 }).Should().BeFalse();
        TvModuleOptions.IsValid(new TvModuleOptions { PowerOffStartupPollSeconds = 0 }).Should().BeFalse();
        TvModuleOptions.IsValid(new TvModuleOptions { PowerOffStartupWindowMinutes = -1 }).Should().BeFalse();
    }
}
