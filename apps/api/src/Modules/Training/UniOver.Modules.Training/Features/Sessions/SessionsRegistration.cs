using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Training.Features.Sessions.PullSessions;
using UniOver.Modules.Training.Features.Sessions.PullSets;
using UniOver.Modules.Training.Features.Sessions.UpsertSession;
using UniOver.Modules.Training.Features.Sessions.UpsertSet;
using UniOver.SharedKernel.Usage;

namespace UniOver.Modules.Training.Features.Sessions;

/// <summary>Composição das sessões dentro do módulo: o <c>TrainingModule</c> só chama estes dois métodos.</summary>
internal static class SessionsRegistration
{
    public static IServiceCollection AddSessions(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddScoped<UpsertSessionHandler>();
        services.AddScoped<UpsertSetHandler>();
        services.AddScoped<PullSessionsHandler>();
        services.AddScoped<PullSetsHandler>();

        // Uso por pessoa: o administrador lê só contagens, pela porta do SharedKernel.
        services.AddScoped<IPersonUsageSource, TrainingUsageSource>();
        return services;
    }

    public static IEndpointRouteBuilder MapSessions(this IEndpointRouteBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapUpsertSession();
        group.MapUpsertSet();
        group.MapPullSessions();
        group.MapPullSets();
        return group;
    }
}
