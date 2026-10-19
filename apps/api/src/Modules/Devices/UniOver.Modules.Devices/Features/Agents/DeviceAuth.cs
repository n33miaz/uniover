using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Tokens;

namespace UniOver.Modules.Devices.Features.Agents;

/// <summary>Nomes da autenticação do agente (o esquema do token de dispositivo e a política da rota de conexão).</summary>
public static class DeviceAuth
{
    public const string Scheme = "UniOver.Device";

    /// <summary>Política da conexão do agente: só o token de dispositivo vale (um JWT de usuário nunca abre o canal) e o <c>agentId</c> da rota precisa ser o do token.</summary>
    public const string AgentPolicy = "devices:agent";

    /// <summary>Slug do agente (o <c>agentId</c> do envelope), vindo do token validado.</summary>
    public const string SlugClaim = "agent_slug";

    /// <summary>Chave (id no banco) do agente, vinda do token validado.</summary>
    public const string KeyClaim = "agent_key";

    internal const string FailureItem = "uniover.device.failure";
    internal const string RevokedFailure = "revoked";
}

/// <summary>
/// Esquema de autenticação do agente: <c>Authorization: Bearer uo_dev_...</c> no <b>cabeçalho</b> da abertura da
/// conexão (nunca na URL), validado pelo <see cref="IDeviceTokenValidator"/> (cache de 30 s, invalidado na
/// revogação). Sem cabeçalho ou sem o prefixo do nosso token nada é decidido aqui (outro esquema pode cuidar do
/// pedido); token inexistente dá 401 e revogado dá 403. O token nunca vai para log.
/// </summary>
internal sealed class DeviceTokenAuthentication(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory loggerFactory,
    UrlEncoder encoder,
    IDeviceTokenValidator validator) : AuthenticationHandler<AuthenticationSchemeOptions>(options, loggerFactory, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!AuthenticationHeaderValue.TryParse(Request.Headers.Authorization, out var header)
            || !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase)
            || header.Parameter is not { } token
            || !token.StartsWith(DeviceSecrets.TokenPrefix, StringComparison.Ordinal))
        {
            return AuthenticateResult.NoResult();
        }

        var result = await validator.ValidateAsync(token, Context.RequestAborted);
        switch (result.Check)
        {
            case TokenCheck.Valid:
                var identity = new ClaimsIdentity(
                    [
                        new Claim(DeviceAuth.SlugClaim, result.AgentId),
                        new Claim(DeviceAuth.KeyClaim, result.Id.ToString()),
                    ],
                    DeviceAuth.Scheme);
                return AuthenticateResult.Success(
                    new AuthenticationTicket(new ClaimsPrincipal(identity), DeviceAuth.Scheme));

            case TokenCheck.Revoked:
                Context.Items[DeviceAuth.FailureItem] = DeviceAuth.RevokedFailure;
                return AuthenticateResult.Fail("revoked");

            default:
                return AuthenticateResult.Fail("unknown");
        }
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        // Revogado é 403 (o agente para de tentar); o resto (sem token, token que não existe) é 401.
        Response.StatusCode = Context.Items.TryGetValue(DeviceAuth.FailureItem, out var failure)
            && failure is DeviceAuth.RevokedFailure
                ? StatusCodes.Status403Forbidden
                : StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    }
}

/// <summary>O <c>agentId</c> da rota precisa ser o slug do token: o agente só abre o próprio canal.</summary>
internal sealed class AgentRouteRequirement : IAuthorizationRequirement;

internal sealed class AgentRouteAuthorizer(IHttpContextAccessor accessor) : AuthorizationHandler<AgentRouteRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, AgentRouteRequirement requirement)
    {
        var slug = context.User.FindFirstValue(DeviceAuth.SlugClaim);
        var route = accessor.HttpContext?.GetRouteValue("agentId") as string;
        if (slug is not null && string.Equals(slug, route, StringComparison.Ordinal))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
