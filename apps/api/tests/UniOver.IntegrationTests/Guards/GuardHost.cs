using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Bootstrap;

namespace UniOver.IntegrationTests.Guards;

/// <summary>O Host real, como vai para o ar, para as varreduras de guarda (sem rotas nem serviços de teste).</summary>
internal static class GuardHost
{
    public static async Task<EdgeFactory> StartAsync(PostgresFixture postgres, string environment, string? deployedCommit = null)
    {
        ArgumentNullException.ThrowIfNull(postgres);

        var database = await postgres.CreateDatabaseAsync();
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = database.RuntimeConnection,
            ["Modules:Identity:Jwt:SigningKey"] = IdentityApp.NewKey(),

            // As rotas protegidas recebem dezenas de requisições do mesmo IP: o limite não pode mascarar o 401.
            ["RateLimiting:login:Permitted"] = "100000",
            ["RateLimiting:refresh:Permitted"] = "100000",
            ["RateLimiting:pairing:Permitted"] = "100000",
            ["RateLimiting:commands:Permitted"] = "100000",
            ["RENDER_GIT_COMMIT"] = deployedCommit,
        };

        var factory = new EdgeFactory(environment, settings);

        // O seed do dono roda em segundo plano logo após a partida. Esperar o fim dele antes de usar (e de
        // descartar) o host evita uma corrida entre o encerramento e o seed, como o IdentityApp já faz.
        await factory.Services.GetRequiredService<OwnerBootstrapService>().Completion;
        return factory;
    }
}
