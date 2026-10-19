namespace UniOver.Modules.Training.Tests;

/// <summary>
/// Relógio falso: o tempo só anda quando o teste manda (<see cref="Advance"/>), e os temporizadores criados por
/// <c>CreateTimer</c> (inclusive o de <c>Task.Delay</c> com este provedor) disparam na hora certa. Assim retry e
/// varredura de reserva são provados sem esperas reais longas.
/// </summary>
internal sealed class FakeTimeProvider(DateTimeOffset start) : TimeProvider
{
    private readonly object _lock = new();
    private readonly List<FakeTimer> _timers = [];
    private readonly List<(TimeSpan Due, TimeSpan Period)> _created = [];
    private DateTimeOffset _now = start;

    /// <summary>Todos os temporizadores já criados (vencimento e período), para provar que só existe um relógio de reserva.</summary>
    public IReadOnlyList<(TimeSpan Due, TimeSpan Period)> CreatedTimers
    {
        get
        {
            lock (_lock)
            {
                return [.. _created];
            }
        }
    }

    public override DateTimeOffset GetUtcNow()
    {
        lock (_lock)
        {
            return _now;
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new FakeTimer(this, callback, state);
        lock (_lock)
        {
            _created.Add((dueTime, period));
            _timers.Add(timer);
            timer.Schedule(dueTime, period, _now);
        }

        return timer;
    }

    public void Advance(TimeSpan delta)
    {
        DateTimeOffset target;
        lock (_lock)
        {
            target = _now + delta;
        }

        while (true)
        {
            FakeTimer? next;
            lock (_lock)
            {
                next = _timers.Where(t => t.Due is not null && t.Due <= target).OrderBy(t => t.Due).FirstOrDefault();
                if (next is null)
                {
                    _now = target;
                    return;
                }

                _now = next.Due!.Value > _now ? next.Due.Value : _now;
                next.Fired(_now);
            }

            next.Invoke();
        }
    }

    private void Remove(FakeTimer timer)
    {
        lock (_lock)
        {
            _timers.Remove(timer);
        }
    }

    private sealed class FakeTimer(FakeTimeProvider owner, TimerCallback callback, object? state) : ITimer
    {
        private TimeSpan _period = Timeout.InfiniteTimeSpan;

        public DateTimeOffset? Due { get; private set; }

        public void Schedule(TimeSpan dueTime, TimeSpan period, DateTimeOffset now)
        {
            _period = period;
            Due = dueTime == Timeout.InfiniteTimeSpan ? null : now + dueTime;
        }

        public void Fired(DateTimeOffset now) =>
            Due = _period == Timeout.InfiniteTimeSpan || _period == TimeSpan.Zero ? null : now + _period;

        public void Invoke() => callback(state);

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (owner._lock)
            {
                Schedule(dueTime, period, owner._now);
            }

            return true;
        }

        public void Dispose() => owner.Remove(this);

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
