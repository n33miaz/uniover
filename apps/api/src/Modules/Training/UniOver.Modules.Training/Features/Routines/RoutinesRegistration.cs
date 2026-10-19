using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Training.Features.Routines.ListRoutineTemplates;
using UniOver.Modules.Training.Features.Routines.PullRoutines;
using UniOver.Modules.Training.Features.Routines.UpsertRoutine;

namespace UniOver.Modules.Training.Features.Routines;

/// <summary>Composição das rotinas dentro do módulo: o <c>TrainingModule</c> só chama estes dois métodos.</summary>
internal static class RoutinesRegistration
{
    public static IServiceCollection AddRoutines(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<RoutineTemplateSource>();
        services.AddScoped<PullRoutinesHandler>();
        services.AddScoped<UpsertRoutineHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapRoutines(this IEndpointRouteBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapPullRoutines();
        group.MapUpsertRoutine();
        group.MapListRoutineTemplates();
        return group;
    }
}
