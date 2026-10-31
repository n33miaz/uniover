namespace UniOver.Modules.Tv.Domain;

/// <summary>Capacidades que o agente declara no <c>agent.hello.v1</c> e que mudam o que a API lhe manda.</summary>
internal static class TvCapabilities
{
    /// <summary>O agente entende <c>tv.power.off.v1</c>: desliga só com a TV lida como ligada e nunca a liga.</summary>
    public const string PowerOffV1 = "tv.power.off.v1";

    /// <summary>O agente avisa a permissão da TV Samsung (<c>tv.permission.v1</c>) e a pede só quando mandado (<c>tv.permission.request.v1</c>).</summary>
    public const string PermissionV1 = "tv.permission.v1";

    /// <summary>O agente sabe procurar TVs compatíveis na rede local (<c>tv.discover.v1</c>).</summary>
    public const string DiscoveryV1 = "tv.discovery.v1";
}

/// <summary>Códigos de erro estáveis que o agente devolve no <c>command.result.v1</c> do desligamento com leitura.</summary>
internal static class TvAgentCodes
{
    /// <summary>A TV já estava desligada: o agente não enviou tecla nenhuma.</summary>
    public const string AlreadyOff = "already_off";
    public const string Uncertain = "uncertain";
    public const string Offline = "offline";
}
