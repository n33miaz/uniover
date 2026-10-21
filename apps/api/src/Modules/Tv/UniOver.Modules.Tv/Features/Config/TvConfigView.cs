using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Config;

/// <summary>De onde vem o computador da TV, em texto estável que a tela reconhece.</summary>
internal static class TvConfigSource
{
    /// <summary>Salvo no app pelo administrador.</summary>
    public const string Saved = "saved";

    /// <summary>Só a variável de ambiente (valor de reserva).</summary>
    public const string Environment = "environment";

    /// <summary>Nada definido.</summary>
    public const string None = "none";

    public static string Of(TvAgentSource source) => source switch
    {
        TvAgentSource.Saved => Saved,
        TvAgentSource.Environment => Environment,
        _ => None,
    };
}

/// <summary>Como está o computador escolhido, em texto estável que a tela reconhece.</summary>
internal static class TvAgentStatus
{
    /// <summary>Pareado, não revogado e conectado agora.</summary>
    public const string Online = "online";

    /// <summary>Pareado e não revogado, mas sem conexão agora (desligado, sem rede ou a API acabou de subir).</summary>
    public const string Offline = "offline";

    /// <summary>Revogado: não recebe comando e não volta sem um novo pareamento.</summary>
    public const string Revoked = "revoked";

    /// <summary>Nenhum computador escolhido, ou um que nunca foi pareado.</summary>
    public const string Unknown = "unknown";
}

/// <summary>Um computador pareado que o administrador pode escolher para controlar a TV.</summary>
internal sealed record TvAgentChoice(string Slug, string Name, string Platform, bool Online);

/// <summary>
/// A configuração da TV padrão como o administrador a vê. <c>AgentSlug</c> e <c>AgentName</c> são nulos quando nada está
/// escolhido; <c>AgentName</c> também é nulo quando o computador escolhido nunca foi pareado. <c>Agents</c> traz só os
/// pareados e não revogados: é a lista de onde a escolha sai.
/// </summary>
internal sealed record TvConfigResponse(
    string Name,
    string? AgentSlug,
    string? AgentName,
    string Source,
    string AgentStatus,
    IReadOnlyList<TvAgentChoice> Agents);

/// <summary>Monta a <see cref="TvConfigResponse"/> a partir do valor resolvido, do diretório de agentes e da presença.</summary>
internal sealed class TvConfigView(IAgentDirectory directory, ITvAgentPresence presence)
{
    public async Task<TvConfigResponse> ReadAsync(TvAgentBinding binding, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(binding);

        var active = await directory.ListActiveAsync(cancellationToken);
        var choices = active.Select(a => new TvAgentChoice(a.Slug, a.Name, a.Platform, presence.IsOnline(a.Slug))).ToList();

        AgentListing? current = null;
        var status = TvAgentStatus.Unknown;
        if (binding.IsConfigured)
        {
            current = await directory.FindAsync(binding.AgentSlug!, cancellationToken);
            status = current switch
            {
                null => TvAgentStatus.Unknown,
                { Revoked: true } => TvAgentStatus.Revoked,
                _ => presence.IsOnline(current.Slug) ? TvAgentStatus.Online : TvAgentStatus.Offline,
            };
        }

        return new TvConfigResponse(
            binding.Name,
            binding.AgentSlug,
            current?.Name,
            TvConfigSource.Of(binding.Source),
            status,
            choices);
    }
}
