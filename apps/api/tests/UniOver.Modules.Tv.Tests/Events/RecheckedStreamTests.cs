using AwesomeAssertions;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Features.Events;

namespace UniOver.Modules.Tv.Tests.Events;

/// <summary>
/// O vigia que fecha o fluxo ao vivo de quem perdeu o acesso. Relógio real com intervalo curto: o que se prova é a regra
/// (pergunta de novo a cada intervalo, fecha ao primeiro "não", nega se não consegue perguntar, para quando o fluxo acaba),
/// não o prazo de 15 s, que o teste de integração prova com o relógio falso.
/// </summary>
public class RecheckedStreamTests
{
    private static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(20);

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>O fluxo "de verdade" da rota: fica aberto até a fila fechar ou a requisição cair.</summary>
    private sealed class OpenUntilClosed(SseSubscription<object> subscription) : IResult
    {
        public async Task ExecuteAsync(HttpContext httpContext)
        {
            try
            {
                await subscription.Reader.Completion.WaitAsync(httpContext.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                // A requisição caiu: fim normal.
            }
        }
    }

    private static SseSubscription<object> Subscribe() => new SseBroadcaster<object>(new SseStreamOptions()).Subscribe("usuario");

    private static DefaultHttpContext Context(CancellationToken aborted) => new() { RequestAborted = aborted };

    [Fact]
    public async Task ClosesTheSubscription_AtTheFirstNo_AndStopsAsking()
    {
        var subscription = Subscribe();
        var calls = 0;
        var stream = new RecheckedStream<object>(
            new OpenUntilClosed(subscription),
            subscription,
            _ => Task.FromResult(Interlocked.Increment(ref calls) <= 2),
            Tick,
            TimeProvider.System);

        await stream.ExecuteAsync(Context(Ct)).WaitAsync(Patience, Ct);

        subscription.Reader.Completion.IsCompleted.Should().BeTrue("o fluxo foi fechado");
        calls.Should().Be(3, "duas respostas positivas e a primeira negativa fecham, sem perguntar de novo");
    }

    [Fact]
    public async Task KeepsTheSubscriptionOpen_WhileTheAnswerIsYes_AndLeavesQuietlyWhenTheRequestDrops()
    {
        var subscription = Subscribe();
        var calls = 0;
        using var aborted = new CancellationTokenSource();
        var stream = new RecheckedStream<object>(
            new OpenUntilClosed(subscription),
            subscription,
            _ =>
            {
                Interlocked.Increment(ref calls);
                return Task.FromResult(true);
            },
            Tick,
            TimeProvider.System);

        var run = stream.ExecuteAsync(Context(aborted.Token));
        await WaitUntilAsync(() => Volatile.Read(ref calls) >= 5);

        subscription.Reader.Completion.IsCompleted.Should().BeFalse("enquanto a resposta é sim o fluxo segue aberto");
        await aborted.CancelAsync();
        await run.WaitAsync(Patience, Ct);
    }

    [Fact]
    public async Task FailsClosed_WhenTheCheckCannotBeDone()
    {
        var subscription = Subscribe();
        var stream = new RecheckedStream<object>(
            new OpenUntilClosed(subscription),
            subscription,
            _ => throw new InvalidOperationException("banco fora do ar"),
            Tick,
            TimeProvider.System);

        await stream.ExecuteAsync(Context(Ct)).WaitAsync(Patience, Ct);

        subscription.Reader.Completion.IsCompleted.Should().BeTrue("sem conseguir conferir, o fluxo fecha (falha fechada), e o erro não vaza");
    }

    [Fact]
    public async Task FailsClosed_WhenTheCheckIsCancelledByAnythingButTheStreamItself()
    {
        var subscription = Subscribe();
        var stream = new RecheckedStream<object>(
            new OpenUntilClosed(subscription),
            subscription,
            _ => throw new OperationCanceledException("tempo esgotado do banco"),
            Tick,
            TimeProvider.System);

        await stream.ExecuteAsync(Context(Ct)).WaitAsync(Patience, Ct);

        subscription.Reader.Completion.IsCompleted.Should().BeTrue("um cancelamento que não veio do fluxo não pode deixar o acesso sem conferência");
    }

    [Fact]
    public async Task StopsAskingOnceTheStreamHasEnded()
    {
        var subscription = Subscribe();
        var calls = 0;
        var stream = new RecheckedStream<object>(
            new EndsAtOnce(),
            subscription,
            _ =>
            {
                Interlocked.Increment(ref calls);
                return Task.FromResult(true);
            },
            Tick,
            TimeProvider.System);

        await stream.ExecuteAsync(Context(Ct)).WaitAsync(Patience, Ct);
        var atTheEnd = Volatile.Read(ref calls);
        await Task.Delay(TimeSpan.FromMilliseconds(120), Ct);

        Volatile.Read(ref calls).Should().Be(atTheEnd, "depois que o fluxo terminou ninguém pergunta mais nada");
    }

    private sealed class EndsAtOnce : IResult
    {
        public Task ExecuteAsync(HttpContext httpContext) => Task.CompletedTask;
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        timeout.CancelAfter(Patience);
        while (!condition())
        {
            await Task.Delay(10, timeout.Token);
        }
    }
}
