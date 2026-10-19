using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Tv;

/// <summary>Seção <c>Modules:Tv</c>. Só este módulo a lê.</summary>
public sealed class TvModuleOptions
{
    public const string SectionName = "Modules:Tv";

    public string Version { get; set; } = "0.0.0";

    /// <summary>
    /// Slug do agente que controla a TV. Uma TV tem um dono só: com dois PCs pareados, só este comanda e só as
    /// mensagens dele valem. Vazio = ninguém configurado (os comandos respondem 503 e a API sobe normalmente).
    /// </summary>
    public string AgentId { get; set; } = string.Empty;

    /// <summary>Tempo que a API espera o agente responder a um comando.</summary>
    public int CommandTimeoutSeconds { get; set; } = 8;

    /// <summary>Maior, para quando a sessão com a TV está dormindo: o agente reconecta (1, 2, 4 s) antes de responder.</summary>
    public int HibernatingTimeoutSeconds { get; set; } = 15;

    /// <summary>Espera antes de gravar uma mudança de estado, para juntar oscilações rápidas numa escrita só.</summary>
    public int StateDebounceSeconds { get; set; } = 2;

    public SseStreamOptions Sse { get; set; } = new();

    public TimeSpan CommandTimeout => TimeSpan.FromSeconds(CommandTimeoutSeconds);

    public TimeSpan HibernatingTimeout => TimeSpan.FromSeconds(HibernatingTimeoutSeconds);

    public TimeSpan StateDebounce => TimeSpan.FromSeconds(StateDebounceSeconds);

    /// <summary>Valores que quebrariam o módulo (tempos não positivos ou slug fora do padrão).</summary>
    public static bool IsValid(TvModuleOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.CommandTimeoutSeconds > 0
            && options.HibernatingTimeoutSeconds > 0
            && options.StateDebounceSeconds >= 0
            && options.Sse.IsValid()
            && options.AgentId.Length <= 40;
    }
}
