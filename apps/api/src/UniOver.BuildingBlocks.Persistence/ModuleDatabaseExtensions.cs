using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Persistence;

public static class ModuleDatabaseExtensions
{
    /// <summary>
    /// Registra o DbContext de um módulo com schema e tabela de histórico próprios, e as opções de banco
    /// (validadas no start). Pode ser chamado uma vez por módulo.
    /// </summary>
    public static IServiceCollection AddModuleDbContext<TContext>(
        this IServiceCollection services,
        IConfiguration configuration,
        string schema,
        Assembly migrationsAssembly)
        where TContext : ModuleDbContext
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(migrationsAssembly);
        SchemaName.EnsureValid(schema);

        // Opções lidas da configuração viva (não de uma cópia): assim valem também para overrides de teste.
        services.AddOptions<DatabaseOptions>()
            .Bind(configuration.GetSection(DatabaseOptions.SectionName))
            .Configure(o => o.ConnectionString = configuration.GetConnectionString("Default"))
            .ValidateOnStart();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IValidateOptions<DatabaseOptions>, DatabaseOptionsValidator>());

        services.AddDbContext<TContext>((sp, builder) =>
        {
            var options = sp.GetRequiredService<IOptions<DatabaseOptions>>().Value;
            ModuleDatabase.Configure(builder, ModuleDatabase.BuildRuntimeConnectionString(options), schema, migrationsAssembly);
        });

        services.AddSingleton(new ModuleDbContextRegistration(schema, typeof(TContext)));
        services.TryAddSingleton<ModuleDbContextRegistry>();
        return services;
    }
}
