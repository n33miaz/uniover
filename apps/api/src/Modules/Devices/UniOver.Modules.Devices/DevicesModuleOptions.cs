namespace UniOver.Modules.Devices;

/// <summary>Pareamento (<c>Modules:Devices:Pairing</c>): padrões aprovados pelo dono.</summary>
public sealed class PairingOptions
{
    /// <summary>Validade do código (10 min): tempo de abrir o app e digitar, curto para o código não ficar solto.</summary>
    public int ExpiresMinutes { get; set; } = 10;

    /// <summary>Intervalo mínimo entre consultas do agente; mais rápido que isso responde <c>slow_down</c>.</summary>
    public int MinPollIntervalSeconds { get; set; } = 5;

    /// <summary>Pareamentos abertos ao mesmo tempo (a rota é anônima: o teto impede encher a tabela).</summary>
    public int MaxActive { get; set; } = 5;

    /// <summary>
    /// Aprovar exige passkey. <c>false</c> só é respeitado em Development, para testar o fluxo por <c>curl</c>
    /// enquanto não existe a tela; em qualquer outro ambiente a exigência vale sempre.
    /// </summary>
    public bool RequireStepUp { get; set; } = true;

    /// <summary>
    /// Computadores ativos (não revogados) que uma conta de convidado pode ter pareados por conta própria. O dono não tem
    /// limite aqui; o convidado que chega ao teto precisa que o administrador revogue um para parear outro.
    /// </summary>
    public int MaxPerGuest { get; set; } = 2;

    public TimeSpan Validity => TimeSpan.FromMinutes(ExpiresMinutes);

    public TimeSpan MinPollInterval => TimeSpan.FromSeconds(MinPollIntervalSeconds);
}

/// <summary>Tudo que é ajustável do módulo, em <c>Modules:Devices</c>.</summary>
public sealed class DevicesModuleOptions
{
    public const string SectionName = "Modules:Devices";

    public PairingOptions Pairing { get; set; } = new();

    /// <summary>Quanto tempo uma validação de token fica em memória (a revogação a invalida antes).</summary>
    public int TokenCacheSeconds { get; set; } = 30;

    public TimeSpan TokenCacheLifetime => TimeSpan.FromSeconds(TokenCacheSeconds);

    /// <summary>
    /// Falhas de token (inexistente ou revogado) toleradas por IP na janela antes de a API parar de consultar o banco por
    /// aquela origem. Um agente com token certo e em cache não conta; um com token velho para de tentar sozinho.
    /// </summary>
    public int TokenFailureLimit { get; set; } = 10;

    public int TokenFailureWindowSeconds { get; set; } = 60;

    public TimeSpan TokenFailureWindow => TimeSpan.FromSeconds(TokenFailureWindowSeconds);

    /// <summary>
    /// Teto do sono do laço que vigia as quedas dos agentes. O laço decide em memória e só consulta o banco no instante em que uma
    /// queda vale, na partida, quando um agente volta ou é revogado; este tempo é a conciliação de reserva (cobre um limite
    /// alterado pelo dono e uma mudança que outra instância viu). Longo de propósito: cada consulta acorda o banco gratuito.
    /// </summary>
    public int OutageReserveMinutes { get; set; } = 360;

    public TimeSpan OutageReserve => TimeSpan.FromMinutes(OutageReserveMinutes);

    /// <summary>Valores que quebrariam a regra (zero ou negativo); o módulo prefere cair na partida a se comportar mal.</summary>
    internal static bool IsValid(DevicesModuleOptions o) =>
        o.Pairing.ExpiresMinutes is >= 1 and <= 60
        && o.Pairing.MinPollIntervalSeconds is >= 1 and <= 600
        && o.Pairing.MaxActive >= 1
        && o.Pairing.MaxPerGuest >= 1
        && o.TokenCacheSeconds >= 0
        && o.TokenFailureLimit >= 1
        && o.TokenFailureWindowSeconds is >= 1 and <= 3600
        && o.OutageReserveMinutes is >= 1 and <= 24 * 60;
}
