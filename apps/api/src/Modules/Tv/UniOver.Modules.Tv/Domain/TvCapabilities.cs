namespace UniOver.Modules.Tv.Domain;

/// <summary>Capacidades que o agente declara no <c>agent.hello.v1</c> e que mudam o que a API lhe manda.</summary>
internal static class TvCapabilities
{
    /// <summary>O agente entende <c>tv.power.off.v1</c>: desliga só com a TV lida como ligada e nunca a liga.</summary>
    public const string PowerOffV1 = "tv.power.off.v1";

    /// <summary>O agente avisa a permissão da TV Samsung (<c>tv.permission.v1</c>) e a pede só quando mandado (<c>tv.permission.request.v1</c>).</summary>
    public const string PermissionV1 = "tv.permission.v1";

    /// <summary>O agente pareia a Android TV pelo app (<c>tv.pair.v1</c>), em dois passos e só quando o dono pede.</summary>
    public const string PairV1 = "tv.pair.v1";

    /// <summary>O agente entende <c>tv.presence.v1</c>: só com a tela da TV visível ele abre uma conexão ADB nova por conta própria.</summary>
    public const string PresenceV1 = "tv.presence.v1";

    /// <summary>O agente abre na TV a tela de rede ou as configurações (<c>tv.settings.open.v1</c>), só a pedido de um toque: é a Android TV pelo ADB.</summary>
    public const string SettingsOpenV1 = "tv.settings.open.v1";

    /// <summary>O agente refaz o registro da permissão do ADB para o aparelho de agora quando a pessoa confirma que é a mesma TV (<c>tv.adb.rebind.v1</c>).</summary>
    public const string AdbRebindV1 = "tv.adb.rebind.v1";

    /// <summary>O agente sabe procurar TVs compatíveis na rede local (<c>tv.discover.v1</c>).</summary>
    public const string DiscoveryV1 = "tv.discovery.v1";

    /// <summary>
    /// O agente entende os acréscimos do TV Livre: o tempo no pedido de dormir, os ícones Rede e Entradas e o nome na
    /// configuração, e o nível do launcher e o "apply adiado" no estado. Sem ela a API manda e lê só o que já existia.
    /// </summary>
    public const string LivreV2 = "tv.livre.v2";
    /// <summary>
    /// O agente entende <c>skipInstall</c> no dormir: confere o launcher na hora e recusa com <c>launcher_required</c> em
    /// vez de instalá-lo. Só com ela o dormir de um convidado vai com o campo.
    /// </summary>
    public const string LivreSleepNoInstall = "tv.livre.sleep-no-install.v1";

    /// <summary>
    /// O agente pode mandar um aviso ao dono (<c>notice</c>) no <c>command.result.v1</c> de um pedido do TV Livre que deu
    /// certo. Separada de <see cref="LivreV2"/>: a API que só conhece aquela tem o resultado fechado e recusaria o campo.
    /// Sem ela a API não repassa aviso nenhum.
    /// </summary>
    public const string LivreNotice = "tv.livre.notice.v1";
}

/// <summary>Códigos de erro estáveis que o agente devolve no <c>command.result.v1</c> do desligamento com leitura.</summary>
internal static class TvAgentCodes
{
    /// <summary>A TV já estava desligada: o agente não enviou tecla nenhuma.</summary>
    public const string AlreadyOff = "already_off";
    public const string Uncertain = "uncertain";
    public const string Offline = "offline";
}
