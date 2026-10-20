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

    /// <summary>Só o dono. É a política padrão: <c>.RequireAuthorization()</c> sem nome é equivalente, e os endpoints novos a citam pelo nome.</summary>
    public const string OwnerPolicy = "Owner";

    /// <summary>Política dos endpoints SSE: só o cookie de bilhete, só em GET e só do dono (o convidado usa a do módulo da TV).</summary>
    public const string StreamPolicy = "StreamAccess";

    public const string StreamCookieName = "uo_st";

    /// <summary>Largo o bastante para os endpoints SSE de Devices e Tv; o refresh tem o próprio caminho, mais estreito.</summary>
    public const string StreamCookiePath = "/api/v1/";

    public const string SubjectClaim = "sub";

    /// <summary>Id da família do refresh (a sessão do usuário).</summary>
    public const string SessionClaim = "sid";

    /// <summary>Papel da conta (<see cref="AccountRoles"/>); decide, em cada módulo, o que o usuário alcança.</summary>
    public const string RoleClaim = "role";

    public const string JwtConfigurationSection = "Modules:Identity:Jwt";
}
