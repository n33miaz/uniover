using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>O que um canal direto pode levar: o PC (ponteiro, teclado, mídia) e/ou as teclas e o texto da TV do agente.</summary>
[Flags]
internal enum PcRtcScopes
{
    None = 0,
    Pc = 1,
    Tv = 2,
    Screen = 8,
}

internal static class PcRtcScopeNames
{
    public const string Pc = "pc";
    public const string Tv = "tv";
    public const string Screen = "screen";

    /// <summary>Os nomes do contrato, na ordem fixa (<c>pc</c> antes de <c>tv</c>).</summary>
    public static string[] ToWire(PcRtcScopes scopes) =>
    [
        .. scopes.HasFlag(PcRtcScopes.Pc) ? [Pc] : Array.Empty<string>(),
        .. scopes.HasFlag(PcRtcScopes.Tv) ? [Tv] : Array.Empty<string>(),
        .. scopes.HasFlag(PcRtcScopes.Screen) ? [Screen] : Array.Empty<string>(),
    ];

    /// <summary>Sem a lista, o pedido é só do PC (o app anterior ao escopo); nome desconhecido vira <see cref="PcRtcScopes.None"/>.</summary>
    public static PcRtcScopes Parse(IEnumerable<string>? names)
    {
        if (names is null)
        {
            return PcRtcScopes.Pc;
        }

        var scopes = PcRtcScopes.None;
        foreach (var name in names)
        {
            scopes |= name switch
            {
                Pc => PcRtcScopes.Pc,
                Tv => PcRtcScopes.Tv,
                Screen => PcRtcScopes.Screen,
                _ => PcRtcScopes.None,
            };
        }

        return scopes;
    }
}

/// <summary>
/// A regra única de "a pessoa ainda pode levar isto pelo canal deste PC": a oferta a usa depois de o agente aceitar, e o reconcile a usa
/// para cada sessão que o agente diz ter aberto. Escopo a escopo: o PC é o módulo <c>module:pc</c> E o computador da própria pessoa; a TV
/// é a que o módulo TV diz que ela pode controlar agora, e que é controlada por este mesmo agente.
/// </summary>
internal static class PcRtcRights
{
    /// <summary>O subconjunto de <paramref name="scopes"/> que ainda vale para <paramref name="userId"/> neste agente.</summary>
    public static async Task<PcRtcScopes> StillValidAsync(
        PcAgentResolver resolver,
        IAccessGrants grants,
        ITvDirectChannels? tv,
        Guid userId,
        bool isOwner,
        PcRtcScopes scopes,
        Guid? tvId,
        string agentSlug,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        ArgumentNullException.ThrowIfNull(grants);

        var valid = PcRtcScopes.None;
        if ((scopes.HasFlag(PcRtcScopes.Pc) || scopes == PcRtcScopes.Screen && isOwner)
            && await grants.HasAsync(userId, AccessPermissions.PcModule, cancellationToken)
            && (scopes != PcRtcScopes.Screen || await grants.HasAsync(userId, AccessPermissions.PcScreen, cancellationToken))
            && await resolver.ResolveAsync(userId, cancellationToken) is { } pc
            && string.Equals(pc.Slug, agentSlug, StringComparison.Ordinal))
        {
            valid |= scopes & (PcRtcScopes.Pc | PcRtcScopes.Screen);
        }

        if (scopes.HasFlag(PcRtcScopes.Tv)
            && tv is not null
            && tvId is not null
            && await tv.ResolveAsync(userId, isOwner, tvId, cancellationToken) is { } target
            && target.TvId == tvId
            && string.Equals(target.AgentSlug, agentSlug, StringComparison.Ordinal))
        {
            valid |= PcRtcScopes.Tv;
        }

        return valid;
    }
}
