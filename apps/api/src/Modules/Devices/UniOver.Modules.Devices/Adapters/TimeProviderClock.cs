using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Adapters;

/// <summary>Adapta o <see cref="TimeProvider"/> (que os testes trocam por um relógio falso) à porta <see cref="IClock"/> do protocolo.</summary>
internal sealed class TimeProviderClock(TimeProvider time) : IClock
{
    public DateTimeOffset UtcNow => time.GetUtcNow();
}
