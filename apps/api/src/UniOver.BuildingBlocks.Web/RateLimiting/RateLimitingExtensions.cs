using System.Globalization;
using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Nomes das políticas; os módulos aplicam com <c>.RequireRateLimiting(RateLimitPolicies.Login)</c>.</summary>
public static class RateLimitPolicies
{
    public const string Login = "login";
    public const string Refresh = "refresh";
    public const string Pairing = "pairing";
    public const string Commands = "commands";

    /// <summary>Aceite de convite de convidado: balde próprio, para não dividir o do login (5 por minuto).</summary>
    public const string GuestInvite = "guest-invite";

    /// <summary>Mudanças do próprio perfil (o nome): por conta, para não dividir o balde do login nem o dos comandos.</summary>
    public const string Profile = "profile";

    /// <summary>Abrir um pedido de entrada pelo QR (anônimo, grava no banco): poucos por minuto e por IP.</summary>
    public const string QrStart = "qr-start";

    /// <summary>A consulta do computador ao pedido (anônima, a cada poucos segundos durante 2 min): balde próprio e mais largo.</summary>
    public const string QrPoll = "qr-poll";

    /// <summary>O que o celular faz com o pedido (ver, confirmar, recusar): por conta, e a senha de reconfirmação conta no bloqueio.</summary>
    public const string QrDecide = "qr-decide";

    /// <summary>Manutenção remota de um agente (ver o registro, atualizar, reiniciar): por conta, baixa, pois cada pedido vai ao PC de alguém.</summary>
    public const string Maintenance = "maintenance";

    /// <summary>Prontidão pública (<c>/health/ready</c>): anônima e a única rota pública que pode acordar o banco, então por IP e baixa.</summary>
    public const string HealthReady = "health-ready";

    internal static readonly string[] All = [Login, Refresh, Pairing, Commands, GuestInvite, Profile, QrStart, QrPoll, QrDecide, Maintenance, HealthReady];
}

/// <summary>Uma política configurável em <c>RateLimiting:&lt;política&gt;</c>.</summary>
public sealed class RateLimitPolicyOptions
{
    public int Permitted { get; set; }

    public int WindowSeconds { get; set; } = 60;

    /// <summary><c>ip</c> ou <c>user</c> (claim <c>sub</c>, com o IP como reserva).</summary>
    public string Partition { get; set; } = "ip";
}

public static class RateLimitingExtensions
{
    // Padrões ajustáveis por configuração. Comandos é alto de propósito: segurar "volume +" no PWA repete
    // a tecla umas 4 vezes por segundo.
    private static readonly Dictionary<string, RateLimitPolicyOptions> Defaults = new(StringComparer.Ordinal)
    {
        [RateLimitPolicies.Login] = new() { Permitted = 5, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.Refresh] = new() { Permitted = 20, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.Pairing] = new() { Permitted = 10, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.Commands] = new() { Permitted = 300, WindowSeconds = 60, Partition = "user" },
        [RateLimitPolicies.GuestInvite] = new() { Permitted = 10, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.Profile] = new() { Permitted = 10, WindowSeconds = 60, Partition = "user" },
        [RateLimitPolicies.QrStart] = new() { Permitted = 10, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.QrPoll] = new() { Permitted = 90, WindowSeconds = 60, Partition = "ip" },
        [RateLimitPolicies.QrDecide] = new() { Permitted = 20, WindowSeconds = 60, Partition = "user" },
        [RateLimitPolicies.Maintenance] = new() { Permitted = 12, WindowSeconds = 60, Partition = "user" },
        [RateLimitPolicies.HealthReady] = new() { Permitted = 12, WindowSeconds = 60, Partition = "ip" },
    };

    /// <summary>
    /// Limites nativos por política. Os contadores vivem no processo e zeram quando o serviço dorme ou é
    /// reimplantado; por isso o bloqueio progressivo de login é persistido em banco, não aqui.
    /// </summary>
    public static IServiceCollection AddUniOverRateLimiting(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        // Uma seção por política, lida depois da montagem do host para valer também para overrides de teste.
        foreach (var name in RateLimitPolicies.All)
        {
            services.AddOptions<RateLimitPolicyOptions>(name)
                .Configure(o =>
                {
                    var d = Defaults[name];
                    o.Permitted = d.Permitted;
                    o.WindowSeconds = d.WindowSeconds;
                    o.Partition = d.Partition;
                })
                .Bind(configuration.GetSection($"RateLimiting:{name}"));
        }

        services.AddRateLimiter();
        services.AddOptions<RateLimiterOptions>().Configure<IOptionsMonitor<RateLimitPolicyOptions>>((limiter, monitor) =>
        {
            limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            foreach (var name in RateLimitPolicies.All)
            {
                var policy = monitor.Get(name);
                var byUser = string.Equals(policy.Partition, "user", StringComparison.OrdinalIgnoreCase);
                limiter.AddPolicy(name, context => RateLimitPartition.GetFixedWindowLimiter(
                    PartitionKey(context, byUser),
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = policy.Permitted,
                        Window = TimeSpan.FromSeconds(policy.WindowSeconds),
                        QueueLimit = 0,
                        AutoReplenishment = true,
                    }));
            }

            limiter.OnRejected = WriteRejectedAsync;
        });
        return services;
    }

    public static IApplicationBuilder UseUniOverRateLimiting(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseRateLimiter();
    }

    private static string PartitionKey(HttpContext context, bool byUser)
    {
        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (byUser && context.User.FindFirstValue("sub") is { Length: > 0 } sub)
        {
            return "user:" + sub;
        }

        return "ip:" + ip;
    }

    private static async ValueTask WriteRejectedAsync(OnRejectedContext context, CancellationToken cancellationToken)
    {
        var http = context.HttpContext;
        http.Response.StatusCode = StatusCodes.Status429TooManyRequests;

        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            http.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
                .ToString(CultureInfo.InvariantCulture);
        }
        else
        {
            http.Response.Headers.RetryAfter = "60";
        }

        var problems = http.RequestServices.GetRequiredService<IProblemDetailsService>();
        await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = http,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status429TooManyRequests,
                Title = "Muitas requisições. Tente de novo em instantes.",
                Type = ProblemDetailsExtensions.TypeBase + ProblemDetailsExtensions.RateLimited,
            },
        });
    }
}
