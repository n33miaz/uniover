using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Training.Features.Goals.PullGoals;
using UniOver.Modules.Training.Features.Goals.UpsertGoal;

namespace UniOver.Modules.Training.Features.Goals;

/// <summary>Composição das metas dentro do módulo: o <c>TrainingModule</c> só chama estes dois métodos.</summary>
internal static class GoalsRegistration
{
    public static IServiceCollection AddGoals(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddScoped<UpsertGoalHandler>();
        services.AddScoped<PullGoalsHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapGoals(this IEndpointRouteBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapUpsertGoal();
        group.MapPullGoals();
        return group;
    }
}
