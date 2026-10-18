using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Os dois cookies da autenticação. O <c>Path</c> é o que impede o uso cruzado: o de refresh só viaja para as
/// rotas de auth e o de stream só para <c>/api/v1/</c>; a política dos endpoints SSE só aceita o segundo.
/// </summary>
internal sealed class AuthCookieWriter(IOptions<IdentityModuleOptions> options, IHostEnvironment environment)
{
    public const string RefreshCookieName = "uo_rt";
    public const string RefreshCookiePath = "/api/v1/identity/auth";

    // Sem HTTPS local o dono pode desligar o Secure, mas só em Development e Testing.
    private bool Secure =>
        !(options.Value.Cookies.SecureOverride is false
            && (environment.IsDevelopment() || environment.IsEnvironment("Testing")));

    public void AppendRefresh(HttpResponse response, string secret, TimeSpan maxAge)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Cookies.Append(RefreshCookieName, secret, Build(RefreshCookiePath, maxAge));
    }

    public void DeleteRefresh(HttpResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Cookies.Delete(RefreshCookieName, Build(RefreshCookiePath, null));
    }

    public void AppendStream(HttpResponse response, string ticket, TimeSpan maxAge)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Cookies.Append(UniOverAuth.StreamCookieName, ticket, Build(UniOverAuth.StreamCookiePath, maxAge));
    }

    public void DeleteStream(HttpResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Cookies.Delete(UniOverAuth.StreamCookieName, Build(UniOverAuth.StreamCookiePath, null));
    }

    private CookieOptions Build(string path, TimeSpan? maxAge) => new()
    {
        HttpOnly = true,
        Secure = Secure,
        SameSite = SameSiteMode.Strict,
        Path = path,
        MaxAge = maxAge,
        IsEssential = true,
    };
}
