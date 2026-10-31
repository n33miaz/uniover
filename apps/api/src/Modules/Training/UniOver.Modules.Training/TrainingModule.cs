using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Amazon.Runtime;
using Amazon.S3;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Adapters;
using UniOver.Modules.Training.Catalog;
using UniOver.Modules.Training.Features.Body;
using UniOver.Modules.Training.Features.CalendarEntries;
using UniOver.Modules.Training.Features.Catalog.GetCatalogCredits;
using UniOver.Modules.Training.Features.Catalog.ImportWger;
using UniOver.Modules.Training.Features.Catalog.PullExercises;
using UniOver.Modules.Training.Features.Catalog.SetExerciseStep;
using UniOver.Modules.Training.Features.Catalog.UpsertCustomExercise;
using UniOver.Modules.Training.Features.Goals;
using UniOver.Modules.Training.Features.Foods;
using UniOver.Modules.Training.Features.Routines;
using UniOver.Modules.Training.Features.ProgressPhotos;
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
            .Configure(options => options.Foods.OffContact = configuration["TRAINING_OFF_CONTACT"] ?? options.Foods.OffContact)
            .Validate(TrainingModuleOptions.IsValid, "Modules:Training tem valor fora do permitido (importação do wger: endereço https, tempos e limites positivos).")
            .ValidateOnStart();

        var photoOptions = configuration.GetSection("Modules:Training:Photos").Get<ProgressPhotoOptions>() ?? new();
        if (!photoOptions.IsValid()) throw new InvalidOperationException("Configuração de armazenamento privado de fotos inválida.");
        services.AddSingleton(photoOptions);
        services.AddSingleton(photoOptions.Storage);
        var photoStorage = photoOptions.Storage;
        if (photoStorage.IsConfigured())
        {
            services.AddSingleton<IAmazonS3>(_ => new AmazonS3Client(
                new BasicAWSCredentials(photoStorage.AccessKey, photoStorage.SecretKey),
                new AmazonS3Config { ServiceURL = photoStorage.ServiceUrl, AuthenticationRegion = photoStorage.Region, ForcePathStyle = true }));
            services.AddSingleton<Ports.IProgressPhotoObjectStore, Adapters.S3ProgressPhotoObjectStore>();
        }
        else
        {
            services.AddSingleton<Ports.IProgressPhotoObjectStore, Adapters.DisabledProgressPhotoObjectStore>();
        }

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
        services.AddCalendarEntries();
        services.AddBody();
        services.AddFoods();
        services.AddScoped<ProgressPhotoHandler>();

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
        group.MapCalendarEntries();
        group.MapBody();
        group.MapFoods();
        // A nuvem de fotos de progresso foi aposentada: as rotas só existem quando a configuração a liga de propósito
        // (Modules:Training:Photos:Storage:Enabled, que exige o bucket completo). Sem isso a API nem as publica (404), e o
        // contrato HTTP não as lista. Nenhum dado é apagado: a tabela e a camada de armazenamento ficam como estão.
        if (endpoints.ServiceProvider.GetRequiredService<ProgressPhotoStorageOptions>().Enabled)
            group.MapProgressPhotos();

        // [composição: training] as próximas áreas do módulo acrescentam as suas rotas aqui.
        return endpoints;
    }
}
