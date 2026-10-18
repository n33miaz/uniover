using Microsoft.Extensions.DependencyInjection;

namespace UniOver.BuildingBlocks.Web;

public static class WebServiceCollectionExtensions
{
    /// <summary>Erros da API saem como ProblemDetails (RFC 9457), nunca como texto solto.</summary>
    public static IServiceCollection AddUniOverProblemDetails(this IServiceCollection services)
    {
        services.AddProblemDetails();
        return services;
    }
}
