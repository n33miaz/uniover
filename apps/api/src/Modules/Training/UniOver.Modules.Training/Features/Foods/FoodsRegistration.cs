using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Training.Features.Foods.ImportTaco;
using UniOver.Modules.Training.Features.Foods.LookupOffFood;
using UniOver.Modules.Training.Features.Foods.PullFoods;
using UniOver.Modules.Training.Features.Foods.SearchOffFoods;
using UniOver.Modules.Training.Features.Foods.UpsertFood;
using UniOver.Modules.Training.Features.Meals.PullMeals;
using UniOver.Modules.Training.Features.Meals.UpsertMeal;
using UniOver.Modules.Training.Adapters.Foods;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.Modules.Training.Features.Foods;

internal static class FoodsRegistration
{
    public static IServiceCollection AddFoods(this IServiceCollection services)
    {
        services.AddSingleton<OffRateLimiter>();
        services.AddHttpClient<IOffClient, HttpOffClient>(client => client.Timeout = TimeSpan.FromSeconds(8));
        services.AddScoped<UpsertFoodHandler>();
        services.AddScoped<PullFoodsHandler>();
        services.AddScoped<SearchOffFoodsHandler>();
        services.AddScoped<LookupOffFoodHandler>();
        services.AddScoped<ImportTacoHandler>();
        services.AddScoped<UpsertMealHandler>();
        services.AddScoped<PullMealsHandler>();
        return services;
    }

    public static IEndpointRouteBuilder MapFoods(this IEndpointRouteBuilder group)
    {
        group.MapUpsertFood();
        group.MapPullFoods();
        group.MapSearchOffFoods();
        group.MapLookupOffFood();
        group.MapImportTaco();
        group.MapUpsertMeal();
        group.MapPullMeals();
        return group;
    }
}
