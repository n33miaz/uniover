using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Persistence;

/// <summary>
/// Banco do módulo: schema <c>training</c>, nada em outro schema e nenhuma FK para fora dele (o usuário é outro módulo
/// e entra só como UUID). Cada tarefa do módulo acrescenta a sua classe de configuração de entidade, sem editar este
/// arquivo: o mapeamento é descoberto pelo assembly.
/// </summary>
public sealed class TrainingDbContext(DbContextOptions<TrainingDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "training";

    protected override string Schema => SchemaName;

    internal DbSet<Exercise> Exercises => Set<Exercise>();

    internal DbSet<Domain.ProgressPhoto> ProgressPhotos => Set<Domain.ProgressPhoto>();

    internal DbSet<ExerciseOverride> ExerciseOverrides => Set<ExerciseOverride>();

    internal DbSet<CatalogMeta> CatalogMeta => Set<CatalogMeta>();

    internal DbSet<Domain.Routines.TrainingProgram> Programs => Set<Domain.Routines.TrainingProgram>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        base.OnModelCreating(modelBuilder);

        modelBuilder.ApplyConfigurationsFromAssembly(typeof(TrainingDbContext).Assembly);

        // Chaves de idempotência das escritas do módulo: training.idempotency_keys.
        modelBuilder.AddIdempotency();
    }
}

/// <summary>Usada só pelo dotnet ef (migrations e bundle); lê <c>UNIOVER_MIGRATIONS_CONNECTION</c>.</summary>
public sealed class TrainingDesignTimeFactory : ModuleDesignTimeFactory<TrainingDbContext>
{
    protected override string Schema => TrainingDbContext.SchemaName;

    protected override TrainingDbContext Create(DbContextOptions<TrainingDbContext> options) => new(options);
}
