using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace UniOver.Modules.Training.Features.CalendarEntries;

internal static class CalendarEntriesRegistration
{
    public static IServiceCollection AddCalendarEntries(this IServiceCollection services)
    {
        services.AddScoped<CalendarEntriesHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapCalendarEntries(this IEndpointRouteBuilder group)
    {
        group.MapCalendarEntriesEndpoints();
        return group;
    }
}
