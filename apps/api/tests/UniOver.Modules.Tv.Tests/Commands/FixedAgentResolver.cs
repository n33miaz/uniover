using System.Diagnostics.CodeAnalysis;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Tests.Commands;

/// <summary>Resolvedor de teste: sempre o mesmo agente (vazio = nenhum configurado), sem banco nem cache.</summary>
internal sealed class FixedAgentResolver(string? agentSlug) : ITvAgentResolver
{
    private readonly TvAgentBinding _binding = string.IsNullOrWhiteSpace(agentSlug)
        ? TvAgentBinding.NotConfigured
        : new TvAgentBinding(agentSlug, ConfiguredTv.DefaultName, TvAgentSource.Saved);

    public ValueTask<TvAgentBinding> ResolveAsync(CancellationToken cancellationToken) => ValueTask.FromResult(_binding);

    public bool TryGetLast([NotNullWhen(true)] out TvAgentBinding? binding)
    {
        binding = _binding;
        return true;
    }

    public void Set(TvAgentBinding binding)
    {
    }

    public void Invalidate()
    {
    }
}
