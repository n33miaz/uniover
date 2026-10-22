using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Features.Body.PullBodyProfile;
using UniOver.Modules.Training.Features.Body.UpsertBodyEntry;
using UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

namespace UniOver.Modules.Training.Features.Body;

/// <summary>Composição do corpo dentro do módulo: o <c>TrainingModule</c> só chama estes dois métodos.</summary>
internal static class BodyRegistration
{
    public static IServiceCollection AddBody(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddScoped<UpsertBodyEntryHandler>();
        services.AddScoped<PullBodyEntriesHandler>();
        services.AddScoped<UpsertBodyProfileHandler>();
        services.AddScoped<PullBodyProfileHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapBody(this IEndpointRouteBuilder group)
    {
        ArgumentNullException.ThrowIfNull(group);

        group.MapUpsertBodyEntry();
        group.MapPullBodyEntries();
        group.MapUpsertBodyProfile();
        group.MapPullBodyProfile();
        return group;
    }
}
