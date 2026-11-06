using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.Beacons;
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
    internal const string MalformedFailure = "malformed";
    internal const string ThrottledFailure = "throttled";
    internal const string UnknownFailure = "unknown";
    internal const string RetryAfterItem = "uniover.device.retry-after";
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

        // A origem entra para o limite de tokens inválidos: depois do teto, a consulta ao banco por token novo é cortada (429).
        var client = Context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var result = await validator.ValidateAsync(token, client, Context.RequestAborted);
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

            case TokenCheck.Throttled:
                Context.Items[DeviceAuth.FailureItem] = DeviceAuth.ThrottledFailure;
                Context.Items[DeviceAuth.RetryAfterItem] = result.RetryAfter;
                return AuthenticateResult.Fail("throttled");

            default:
                // Só vira "desconhecido" o token que tem a forma do nosso e foi procurado no banco (aí o teto de tokens inválidos já
                // o contou). Texto sem a forma certa nunca foi ao banco, não conta no teto e não pode custar uma consulta a mais.
                Context.Items[DeviceAuth.FailureItem] = DeviceSecrets.HashPresentedToken(token) is null
                    ? DeviceAuth.MalformedFailure
                    : DeviceAuth.UnknownFailure;
                return AuthenticateResult.Fail("unknown");
        }
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        // Revogado é 403 (o agente para de tentar); o resto (sem token, token que não existe) é 401. Origem que estourou o
        // teto de tokens inválidos recebe 429 com Retry-After: não é "o token morreu", então o agente tenta de novo depois.
        Context.Items.TryGetValue(DeviceAuth.FailureItem, out var failure);
        if (failure is DeviceAuth.ThrottledFailure)
        {
            var retry = Context.Items.TryGetValue(DeviceAuth.RetryAfterItem, out var value) && value is TimeSpan span ? span : TimeSpan.FromSeconds(60);
            Response.StatusCode = StatusCodes.Status429TooManyRequests;
            Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retry.TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return;
        }

        var revoked = failure is DeviceAuth.RevokedFailure;
        Response.StatusCode = revoked ? StatusCodes.Status403Forbidden : StatusCodes.Status401Unauthorized;

        // O dono precisa saber por que o PC não conecta: anota o motivo (um código fixo) no agente do caminho. O token nunca entra.
        // Só se anota o token que tem a forma do nosso e foi procurado no banco sem achar (o teto de tokens inválidos por origem já o
        // contou, e o 429 acima o corta). Sem cabeçalho ou com texto de forma errada nada é anotado, porque a autorização roda antes do
        // limitador de requisições e isso seria uma consulta ao banco por tentativa. Token revogado também não: o agente revogado some da
        // tela, e anotar pelo caminho marcaria o agente errado.
        if (failure is DeviceAuth.UnknownFailure)
        {
            await RecordRejectionAsync(BeaconRejection.InvalidToken);
        }
    }

    /// <summary>Token válido, mas de outro agente (o <c>agentId</c> do caminho não é o dele): 403, e o motivo fica anotado no agente do caminho.</summary>
    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status403Forbidden;
        await RecordRejectionAsync(BeaconRejection.WrongAgent);
    }

    private async Task RecordRejectionAsync(string reason)
    {
        try
        {
            var store = Context.RequestServices.GetRequiredService<AgentBeaconStore>();
            await store.TryRecordRejectionAsync(Context.GetRouteValue("agentId") as string, reason, Context.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            // O PC desistiu da abertura antes de a anotação terminar: não há resposta a proteger.
        }
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
