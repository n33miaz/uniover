namespace UniOver.Modules.Tv;

/// <summary>
/// Nomes das políticas de autorização do módulo. A TV é a única área aberta ao convidado: ele recebe um "controle
/// físico", então o que é da TV aceita dono e convidado, e todo o resto da API continua só do dono.
/// </summary>
public static class TvAuth
{
    /// <summary>
    /// Comandos, estado, atalhos (abrir e atualizar a lista) e histórico da TV: dono e convidado ativo. Renomear e
    /// ocultar atalhos é só do dono (política <c>Owner</c>).
    /// </summary>
    public const string ControlPolicy = "TvControl";

    /// <summary>Fluxo SSE da TV: só o cookie de bilhete, só GET, dono e convidado.</summary>
    public const string StreamPolicy = "TvStream";
}
