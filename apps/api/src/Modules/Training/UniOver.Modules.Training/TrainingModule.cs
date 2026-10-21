using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Adapters;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Features.Catalog.GetCatalogCredits;
using UniOver.Modules.Training.Features.Catalog.ImportWger;
using UniOver.Modules.Training.Features.Catalog.PullExercises;
using UniOver.Modules.Training.Features.Catalog.SetExerciseStep;
using UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;
using UniOver.Modules.Training.Features.Goals;
using UniOver.Modules.Training.Features.Routines;
using UniOver.Modules.Training.Features.Sessions;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training;

public static class TrainingModule
{
    public const string Name = "training";

    public static IServiceCollection AddTrainingModule(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<TrainingModuleOptions>()
            .Bind(configuration.GetSection(TrainingModuleOptions.SectionName))
            .Validate(TrainingModuleOptions.IsValid, "Modules:Training tem valor fora do permitido (importação do wger: endereço https, tempos e limites positivos).")
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddModuleDbContext<TrainingDbContext>(
            configuration, TrainingDbContext.SchemaName, typeof(TrainingDbContext).Assembly);

        // Chaves de idempotência das escritas do módulo (schema training). A ponte existe aqui porque o Web ainda não
        // referencia o Persistence; ela some quando a genérica passar a existir nos BuildingBlocks.
        services.AddIdempotencyStore<TrainingDbContext>();
        services.AddScoped<IIdempotencyGateway<TrainingDbContext>, TrainingIdempotencyGateway>();

        // Catálogo: a semente só é lida (do assembly) e gravada (no banco) na primeira requisição que precisar dela.
        services.AddSingleton<CatalogSeedSource>();
        services.AddScoped<CatalogSeeder>();
        services.AddScoped<PullExercisesHandler>();
        services.AddScoped<UpsertCustomExerciseHandler>();
        services.AddScoped<SetExerciseStepHandler>();
        services.AddScoped<GetCatalogCreditsHandler>();

        // Importação do wger: o ritmo (uma chamada por vez, com intervalo) é compartilhado por todas as instâncias do
        // cliente, e só há uma importação rodando por vez.
        services.AddSingleton<WgerThrottle>();
        services.AddSingleton<WgerImportGate>();
        services.AddHttpClient<IWgerClient, HttpWgerClient>((sp, client) =>
        {
            var wger = sp.GetRequiredService<IOptions<TrainingModuleOptions>>().Value.Import.Wger;
            client.BaseAddress = new Uri(wger.BaseUrl, UriKind.Absolute);
            client.Timeout = TimeSpan.FromSeconds(wger.TimeoutSeconds);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("UniOver-ExerciseImport/1.0 (app pessoal; importacao unica do catalogo)");
            client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        });
        services.AddScoped<ImportWgerHandler>();

        services.AddRoutines();
        services.AddSessions();
        services.AddGoals();

        // [composição: training] as próximas áreas do módulo (rotinas, sessões, medidas) acrescentam as suas linhas aqui.
        return services;
    }

    public static IEndpointRouteBuilder MapTrainingEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Sem AllowAnonymous nem política no grupo: cada rota declara a sua (TrainingAuth), então uma rota nova sem política
        // cai na padrão (só administrador) em vez de ficar aberta a quem tem o módulo.
        var group = endpoints.MapGroup($"/api/v1/{Name}");
        group.MapPullExercises();
        group.MapUpsertCustomExercise();
        group.MapSetExerciseStep();
        group.MapGetCatalogCredits();
        group.MapImportWger();

        group.MapRoutines();
        group.MapSessions();
        group.MapGoals();

        // [composição: training] as próximas áreas do módulo acrescentam as suas rotas aqui.
        return endpoints;
    }
}
