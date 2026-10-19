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

    /// <summary>Valores que quebrariam a regra (zero ou negativo); o módulo prefere cair na partida a se comportar mal.</summary>
    internal static bool IsValid(DevicesModuleOptions o) =>
        o.Pairing.ExpiresMinutes is >= 1 and <= 60
        && o.Pairing.MinPollIntervalSeconds is >= 1 and <= 600
        && o.Pairing.MaxActive >= 1
        && o.TokenCacheSeconds >= 0;
}
