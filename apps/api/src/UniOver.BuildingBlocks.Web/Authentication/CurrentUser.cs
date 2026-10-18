using System.Security.Claims;
using Microsoft.AspNetCore.Http;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Quem está autenticado na requisição. Os handlers dos módulos usam isto e nunca o <c>HttpContext</c>,
/// para continuarem testáveis sem HTTP.
/// </summary>
public interface ICurrentUser
{
    bool IsAuthenticated { get; }

    /// <summary>Claim <c>sub</c>; nulo se anônimo ou se a claim não for um UUID.</summary>
    Guid? UserId { get; }

    /// <summary>Claim <c>sid</c>: a família do refresh (a sessão); nulo se anônimo.</summary>
    Guid? SessionId { get; }
}

internal sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    private ClaimsPrincipal? Principal => accessor.HttpContext?.User;

    public bool IsAuthenticated => Principal?.Identity?.IsAuthenticated == true;

    public Guid? UserId => ReadGuid(UniOverAuth.SubjectClaim);

    public Guid? SessionId => ReadGuid(UniOverAuth.SessionClaim);

    private Guid? ReadGuid(string claim) =>
        Guid.TryParse(Principal?.FindFirst(claim)?.Value, out var value) ? value : null;
}
