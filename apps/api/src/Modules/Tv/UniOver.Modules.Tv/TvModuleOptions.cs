using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Tv;

/// <summary>Seção <c>Modules:Tv</c>. Só este módulo a lê.</summary>
public sealed class TvModuleOptions
{
    public const string SectionName = "Modules:Tv";

    public string Version { get; set; } = "0.0.0";

    /// <summary>Tempo que a API espera o agente responder a um comando.</summary>
    public int CommandTimeoutSeconds { get; set; } = 8;

    /// <summary>Maior, para quando a sessão com a TV está dormindo: o agente reconecta (1, 2, 4 s) antes de responder.</summary>
    public int HibernatingTimeoutSeconds { get; set; } = 15;

    /// <summary>
    /// Tempo que a API espera a limpeza da TV. É maior que o dos outros comandos: o agente fecha apps e mede a memória
    /// uma vez antes e outra depois, e se dá cerca de 25 s para isso.
    /// </summary>
    public int CleanupTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Tempo que a API espera o desligamento com leitura. É o maior dos comandos de uma tecla: o agente pode abrir a sessão
    /// (1, 2 e 4 s de espera), ler a energia, apertar <c>POWER</c> uma vez e esperar a confirmação, e sem confirmação ele não
    /// repete a tecla. Responder a tempo importa: um 504 depois de a tecla ter saído levaria a pessoa a repetir o pedido.
    /// </summary>
    public int PowerOffTimeoutSeconds { get; set; } = 25;

    /// <summary>Espera antes de gravar uma mudança de estado, para juntar oscilações rápidas numa escrita só.</summary>
    public int StateDebounceSeconds { get; set; } = 2;

    public SseStreamOptions Sse { get; set; } = new();

    public TimeSpan CommandTimeout => TimeSpan.FromSeconds(CommandTimeoutSeconds);

    public TimeSpan PowerOffTimeout => TimeSpan.FromSeconds(PowerOffTimeoutSeconds);

    public TimeSpan CleanupTimeout => TimeSpan.FromSeconds(CleanupTimeoutSeconds);

    public TimeSpan HibernatingTimeout => TimeSpan.FromSeconds(HibernatingTimeoutSeconds);

    public TimeSpan StateDebounce => TimeSpan.FromSeconds(StateDebounceSeconds);

    /// <summary>Valores que quebrariam o módulo (tempos não positivos).</summary>
    public static bool IsValid(TvModuleOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.CommandTimeoutSeconds > 0
            && options.HibernatingTimeoutSeconds > 0
            && options.CleanupTimeoutSeconds > 0
            && options.PowerOffTimeoutSeconds > 0
            && options.StateDebounceSeconds >= 0
            && options.Sse.IsValid();
    }
}
