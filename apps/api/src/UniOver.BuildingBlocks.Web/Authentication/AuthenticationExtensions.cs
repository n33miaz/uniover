using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Só aceita GET: o bilhete de stream abre conexões SSE e não serve para escrever nada.</summary>
internal sealed class GetOnlyRequirement : IAuthorizationRequirement;

internal sealed class GetOnlyHandler(IHttpContextAccessor accessor) : AuthorizationHandler<GetOnlyRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, GetOnlyRequirement requirement)
    {
        if (accessor.HttpContext is { } http && HttpMethods.IsGet(http.Request.Method))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

/// <summary>
/// Política de reserva (fallback): usuário autenticado <b>e dono</b>. Quem esquece de declarar política cai aqui e o
/// convidado nunca alcança a rota. Fica de fora só o que o roteador resolve sozinho (rota inexistente e
/// método não permitido): ali não há endpoint de negócio a proteger, e exigir login mascararia o 404 e o 405
/// legítimos com um 401. Todo endpoint real, sem exceção, continua exigindo autenticação.
/// </summary>
internal sealed class AuthenticatedByDefaultRequirement : IAuthorizationRequirement;

internal sealed class AuthenticatedByDefaultHandler(IHttpContextAccessor accessor)
    : AuthorizationHandler<AuthenticatedByDefaultRequirement>
{
    // Nome do endpoint sintético que o roteador usa para responder 405.
    private const string MethodNotAllowedDisplayName = "405 HTTP Method Not Supported";

    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, AuthenticatedByDefaultRequirement requirement)
    {
        var owner = context.User.Identity?.IsAuthenticated == true
            && string.Equals(AccountRoles.Of(context.User), AccountRoles.Owner, StringComparison.Ordinal);
        if (owner || IsRouterGenerated(accessor.HttpContext?.GetEndpoint()))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }

    private static bool IsRouterGenerated(Endpoint? endpoint) =>
        endpoint is null
        || (endpoint.Metadata.Count == 0
            && string.Equals(endpoint.DisplayName, MethodNotAllowedDisplayName, StringComparison.Ordinal));
}

/// <summary>
/// Configura os dois esquemas JWT com as mesmas chaves: <c>Bearer</c> (cabeçalho, público da API) e
/// <c>UniOver.Stream</c> (cookie, público do stream). Usa o <see cref="TimeProvider"/> para a validade, assim os
/// testes controlam o relógio.
/// </summary>
internal sealed class JwtBearerSetup(JwtKeySet keys, TimeProvider time) : IConfigureNamedOptions<JwtBearerOptions>
{
    public void Configure(string? name, JwtBearerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (name is not (JwtBearerDefaults.AuthenticationScheme or UniOverAuth.StreamScheme))
        {
            return;
        }

        var stream = name == UniOverAuth.StreamScheme;

        // Sem remapear: o token traz "sub" e "sid" e é assim que o resto do sistema lê (limite por usuário inclusive).
        options.MapInboundClaims = false;
        options.SaveToken = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = UniOverAuth.Issuer,
            ValidateAudience = true,
            ValidAudience = stream ? UniOverAuth.StreamAudience : UniOverAuth.ApiAudience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKeys = keys.ValidationKeys,
            // Só HS256: fecha a porta para "alg": "none" e para troca de algoritmo.
            ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30),
            LifetimeValidator = ValidateLifetime,
            NameClaimType = UniOverAuth.SubjectClaim,
        };

        if (stream)
        {
            // O bilhete só vale vindo do cookie. Sem cookie, NoResult impede o esquema de cair no cabeçalho
            // Authorization (o JWT de acesso não pode autenticar o stream).
            options.Events = new JwtBearerEvents
            {
                OnMessageReceived = context =>
                {
                    if (context.Request.Cookies.TryGetValue(UniOverAuth.StreamCookieName, out var ticket)
                        && !string.IsNullOrWhiteSpace(ticket))
                    {
                        context.Token = ticket;
                    }
                    else
                    {
                        context.NoResult();
                    }

                    return Task.CompletedTask;
                },
            };
        }
    }

    public void Configure(JwtBearerOptions options) => Configure(Options.DefaultName, options);

    private bool ValidateLifetime(DateTime? notBefore, DateTime? expires, SecurityToken token, TokenValidationParameters parameters)
    {
        if (expires is null)
        {
            return false;
        }

        var now = time.GetUtcNow().UtcDateTime;
        var skew = parameters.ClockSkew;
        return expires.Value + skew > now && (notBefore is null || notBefore.Value - skew <= now);
    }
}

public static class AuthenticationExtensions
{
    /// <summary>
    /// Validação do JWT de acesso e do bilhete de stream, política padrão "autenticado" (rota pública é exceção
    /// explícita com <c>AllowAnonymous</c>), a política padrão "dono" e a política <see cref="UniOverAuth.StreamPolicy"/> (só dono). Mora aqui, e não
    /// no Identity, para que um módulo extraído valide o mesmo JWT sem referenciar o Identity.
    /// </summary>
    public static IServiceCollection AddUniOverAuthentication(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpContextAccessor();
        services.TryAddScoped<ICurrentUser, HttpContextCurrentUser>();

        services.AddOptions<JwtKeyOptions>().Bind(configuration.GetSection(UniOverAuth.JwtConfigurationSection));
        services.TryAddSingleton(sp => JwtKeySet.Create(
            sp.GetRequiredService<IOptions<JwtKeyOptions>>().Value,
            sp.GetRequiredService<ILoggerFactory>().CreateLogger("UniOver.Authentication")));
        services.AddSingleton<IConfigureOptions<JwtBearerOptions>, JwtBearerSetup>();

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(JwtBearerDefaults.AuthenticationScheme, _ => { })
            .AddJwtBearer(UniOverAuth.StreamScheme, _ => { });

        services.AddSingleton<IAuthorizationHandler, GetOnlyHandler>();
        services.AddSingleton<IAuthorizationHandler, AuthenticatedByDefaultHandler>();
        services.AddSingleton<IAuthorizationHandler, AccountRoleHandler>();
        services.AddSingleton<IAuthorizationHandler, ActiveAccountHandler>();
        services.AddSingleton<IAuthorizationHandler, PermissionHandler>();
        var authorization = services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().AddRequirements(new AuthenticatedByDefaultRequirement()).Build())

            // Quem escreve só `.RequireAuthorization()` chega aqui: a política padrão é "dono". O convidado entra apenas
            // onde o módulo declara uma política própria, então um módulo novo nasce fechado para ele.
            .SetDefaultPolicy(new AuthorizationPolicyBuilder().RequireAccountRole(AccountRoles.Owner).Build())
            .AddPolicy(UniOverAuth.OwnerPolicy, policy => policy.RequireAccountRole(AccountRoles.Owner))
            .AddPolicy(UniOverAuth.StreamPolicy, policy => policy
                .AddAuthenticationSchemes(UniOverAuth.StreamScheme)
                .RequireAccountRole(AccountRoles.Owner)
                .RequireGetOnly());

        // Uma política nomeada por permissão do catálogo (`AccessPermissions.Policy(...)`): o catálogo é fechado, então
        // o conjunto é fixo e não precisa de um provedor de políticas próprio (que substituiria o da confirmação).
        foreach (var permission in AccessPermissions.All)
        {
            var captured = permission;
            authorization.AddPolicy(AccessPermissions.Policy(captured), policy => policy.RequirePermission(captured));
        }

        return services;
    }

    /// <summary>Autenticação e autorização, nesta ordem, depois do limite de requisições.</summary>
    public static IApplicationBuilder UseUniOverAuthentication(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.UseAuthentication();
        app.UseAuthorization();
        return app;
    }
}
