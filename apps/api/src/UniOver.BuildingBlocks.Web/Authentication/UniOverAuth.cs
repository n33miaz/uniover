namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Nomes e valores fixos da autenticação, num lugar só: o módulo que emite os tokens e quem os valida (o Host
/// e, no futuro, qualquer módulo extraído) precisam concordar nestes valores.
/// </summary>
public static class UniOverAuth
{
    public const string Issuer = "uniover";

    /// <summary>Público do JWT de acesso (cabeçalho <c>Authorization</c>).</summary>
    public const string ApiAudience = "uniover-api";

    /// <summary>Público do bilhete de stream (cookie); nunca vale como JWT de acesso e vice-versa.</summary>
    public const string StreamAudience = "uniover-stream";

    public const string StreamScheme = "UniOver.Stream";

    /// <summary>Política dos endpoints SSE: só o cookie de bilhete, só em GET.</summary>
    public const string StreamPolicy = "StreamAccess";

    public const string StreamCookieName = "uo_st";

    /// <summary>Largo o bastante para os endpoints SSE de Devices e Tv; o refresh tem o próprio caminho, mais estreito.</summary>
    public const string StreamCookiePath = "/api/v1/";

    public const string SubjectClaim = "sub";

    /// <summary>Id da família do refresh (a sessão do usuário).</summary>
    public const string SessionClaim = "sid";

    public const string JwtConfigurationSection = "Modules:Identity:Jwt";
}
