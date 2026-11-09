using AwesomeAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public sealed class UserAccessNotifierTests
{
    private static readonly UserAccessChange Change = new(Guid.NewGuid(), UserAccessChangeKind.SessionEnded, Guid.NewGuid());

    private sealed class Listener(Exception? failure = null) : IUserAccessListener
    {
        public int Calls { get; private set; }

        public CancellationToken Seen { get; private set; } = new(true);

        public Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default)
        {
            Calls++;
            Seen = cancellationToken;
            return failure is null ? Task.CompletedTask : Task.FromException(failure);
        }
    }

    [Fact]
    public async Task EveryListenerRuns_EvenAfterOneFails_AndNothingIsRethrown_NotEvenACancellation()
    {
        var failing = new Listener(new InvalidOperationException("falhou"));
        var cancelled = new Listener(new OperationCanceledException());
        var healthy = new Listener();
        var notifier = new UserAccessNotifier([failing, cancelled, healthy], NullLogger<UserAccessNotifier>.Instance);

        var act = () => notifier.NotifyAsync(Change);

        await act.Should().NotThrowAsync("a mudança de acesso já está gravada: o aviso nunca a desfaz");
        (failing.Calls, cancelled.Calls, healthy.Calls).Should().Be((1, 1, 1));
    }

    [Fact]
    public async Task TheListenersAreCalledWithoutTheRequestToken()
    {
        var listener = new Listener();
        var notifier = new UserAccessNotifier([listener], NullLogger<UserAccessNotifier>.Instance);

        await notifier.NotifyAsync(Change);

        listener.Seen.CanBeCanceled.Should().BeFalse("cancelar a requisição depois de gravar não pode deixar o canal aberto");
    }
}
