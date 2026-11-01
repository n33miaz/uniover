using System.Diagnostics.CodeAnalysis;
using UniOver.Modules.Tv.Domain;

namespace UniOver.Modules.Tv.Ports;

/// <summary>De onde veio o computador que controla a TV (a tela mostra isto para o administrador saber o que vale).</summary>
internal enum TvAgentSource
{
    /// <summary>Nada configurado: os comandos respondem 503 e a API sobe normalmente.</summary>
    None,

    /// <summary>Salvo no app pelo administrador (o banco). É o que vale quando existe.</summary>
    Saved,
}

/// <summary>O computador (agente) que controla a TV padrão, como o resolvedor o entregou.</summary>
/// <param name="AgentSlug">O <c>agentId</c>; nulo quando <paramref name="Source"/> é <see cref="TvAgentSource.None"/>.</param>
/// <param name="Name">O nome da TV salvo no app (o padrão quando nada foi salvo).</param>
internal sealed record TvAgentBinding(string? AgentSlug, string Name, TvAgentSource Source)
{
    public static TvAgentBinding NotConfigured { get; } = new(null, ConfiguredTv.DefaultName, TvAgentSource.None);

    public bool IsConfigured => !string.IsNullOrWhiteSpace(AgentSlug);
}

/// <summary>
/// Quem diz qual agente controla a TV: a linha salva no app, ou "nada". Todo ponto do módulo pergunta aqui. O valor fica
/// num cache curto, que quem salva troca na hora.
/// </summary>
internal interface ITvAgentResolver
{
    /// <summary>
    /// O valor atual. Com o cache válido volta já, sem ir ao banco; senão lê a linha da TV padrão. Se o banco não
    /// responder, segue com o último valor conhecido (a TV não pode parar por isso); sem nenhum valor conhecido devolve
    /// "não configurado".
    /// </summary>
    ValueTask<TvAgentBinding> ResolveAsync(CancellationToken cancellationToken);

    /// <summary>
    /// O último valor conhecido, sem tocar no banco e sem esperar (mesmo vencido). Para quem roda dentro da conexão do
    /// agente e só pode enfileirar. Falso antes da primeira leitura bem-sucedida.
    /// </summary>
    bool TryGetLast([NotNullWhen(true)] out TvAgentBinding? binding);

    /// <summary>Quem acabou de salvar entrega o valor novo: vale já, sem esperar o cache vencer.</summary>
    void Set(TvAgentBinding binding);

    /// <summary>Esquece o valor (a próxima pergunta lê o banco). Para quando não se sabe se o salvamento valeu.</summary>
    void Invalidate();
}

/// <summary>A TV padrão como está salva no banco.</summary>
internal sealed record SavedTv(string AgentSlug, string Name);

/// <summary>Lê a TV padrão salva no app. Atrás de porta para o resolvedor ser testado sem banco.</summary>
internal interface ISavedTvReader
{
    /// <summary>A linha da TV padrão, ou nulo quando nada foi salvo.</summary>
    Task<SavedTv?> ReadDefaultAsync(CancellationToken cancellationToken);
}
