using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Tv;

/// <summary>Seção <c>Modules:Tv</c>. Só este módulo a lê.</summary>
public sealed class TvModuleOptions
{
    public const string SectionName = "Modules:Tv";

    public string Version { get; set; } = "0.0.0";

    /// <summary>Tempo que a API espera o agente responder a um comando com a sessão com a TV aberta.</summary>
    public int CommandTimeoutSeconds { get; set; } = 8;

    /// <summary>
    /// Maior, para quando a sessão com a TV não está aberta (dormindo, caída ou ligando): o agente reabre antes de responder
    /// (1, 2 e 4 s de espera entre as tentativas, e no máximo 20 s no total: <c>tv_session_warm_timeout_seconds</c> do agente).
    /// Tem de passar desse máximo com folga, senão a API desiste de um comando que o agente ainda está executando de
    /// forma legítima e a pessoa vê um erro com a TV a segundos de responder.
    /// </summary>
    public int HibernatingTimeoutSeconds { get; set; } = 25;

    /// <summary>
    /// Tempo que a API espera a limpeza da TV. É maior que o dos outros comandos: o agente fecha apps e mede a memória
    /// uma vez antes e outra depois, e se dá cerca de 25 s para isso.
    /// </summary>
    public int CleanupTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Tempo que a API espera o desligamento com leitura. É o maior dos comandos de uma tecla: o agente pode abrir a sessão
    /// (até 20 s), ler a energia (2 s), apertar <c>POWER</c> uma vez e esperar a confirmação (5 s), e sem confirmação ele não
    /// repete a tecla. Responder a tempo importa: um 504 depois de a tecla ter saído levaria a pessoa a repetir o pedido.
    /// Por isso passa do tempo de abertura (<see cref="HibernatingTimeoutSeconds"/>) pela leitura e pela confirmação.
    /// </summary>
    public int PowerOffTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Tempo que a API espera um passo do TV Livre. Instalar, definir como padrão e voltar ao original levam dezenas de
    /// segundos (baixar e conferir o APK, instalar, verificar a home nova, reativar apps); aplicar e mudar a visibilidade de
    /// apps também gravam no aparelho pelo ADB. Maior que o da limpeza: o agente roda esses passos fora do laço de
    /// mensagens e responde só no fim.
    /// </summary>
    public int LivreTimeoutSeconds { get; set; } = 90;

    /// <summary>Espera antes de gravar uma mudança de estado, para juntar oscilações rápidas numa escrita só.</summary>
    public int StateDebounceSeconds { get; set; } = 2;

    /// <summary>
    /// Teto do sono do laço dos desligamentos agendados quando não há pedido em aberto (ou o próximo é mais distante). O laço
    /// dorme até o próximo instante útil e é acordado por sinal ao criar, mudar ou cancelar; este tempo só cobre um pedido
    /// criado por outra instância. Longo de propósito: cada despertar acorda o banco gratuito, que dorme sem consulta.
    /// </summary>
    public int PowerOffReserveMinutes { get; set; } = 360;

    /// <summary>
    /// Janela, a partir da partida do processo, em que o laço dorme só <see cref="PowerOffStartupPollSeconds"/>: numa troca de
    /// instância a antiga ainda recebe pedidos que esta não viu por sinal, e o banco está acordado de qualquer forma.
    /// </summary>
    public int PowerOffStartupWindowMinutes { get; set; } = 10;

    public int PowerOffStartupPollSeconds { get; set; } = 60;

    public SseStreamOptions Sse { get; set; } = new();

    public TimeSpan PowerOffReserve => TimeSpan.FromMinutes(PowerOffReserveMinutes);

    public TimeSpan PowerOffStartupWindow => TimeSpan.FromMinutes(PowerOffStartupWindowMinutes);

    public TimeSpan PowerOffStartupPoll => TimeSpan.FromSeconds(PowerOffStartupPollSeconds);

    public TimeSpan CommandTimeout => TimeSpan.FromSeconds(CommandTimeoutSeconds);

    public TimeSpan PowerOffTimeout => TimeSpan.FromSeconds(PowerOffTimeoutSeconds);

    public TimeSpan CleanupTimeout => TimeSpan.FromSeconds(CleanupTimeoutSeconds);

    public TimeSpan LivreTimeout => TimeSpan.FromSeconds(LivreTimeoutSeconds);

    public TimeSpan HibernatingTimeout => TimeSpan.FromSeconds(HibernatingTimeoutSeconds);

    public TimeSpan StateDebounce => TimeSpan.FromSeconds(StateDebounceSeconds);

    /// <summary>Valores que quebrariam o módulo (tempos não positivos).</summary>
    public static bool IsValid(TvModuleOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.CommandTimeoutSeconds > 0
            && options.HibernatingTimeoutSeconds >= options.CommandTimeoutSeconds
            && options.CleanupTimeoutSeconds > 0
            && options.PowerOffTimeoutSeconds >= options.HibernatingTimeoutSeconds
            && options.LivreTimeoutSeconds > 0
            && options.StateDebounceSeconds >= 0
            && options.PowerOffReserveMinutes is >= 1 and <= 24 * 60
            && options.PowerOffStartupWindowMinutes is >= 0 and <= 60
            && options.PowerOffStartupPollSeconds is >= 1 and <= 600
            && options.Sse.IsValid();
    }
}
