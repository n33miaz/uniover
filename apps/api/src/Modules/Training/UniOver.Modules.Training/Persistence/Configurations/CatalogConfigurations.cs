using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class ExerciseConfiguration : IEntityTypeConfiguration<Exercise>
{
    public void Configure(EntityTypeBuilder<Exercise> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("exercises", t =>
        {
            t.HasCheckConstraint("ck_exercises_source", "source IN ('free_exercise_db', 'uniover', 'wger', 'own')");
            t.HasCheckConstraint("ck_exercises_record_type", "record_type IN ('weight_reps', 'reps_only', 'time')");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        e.Property(x => x.Slug).HasMaxLength(100).IsRequired();
        e.Property(x => x.Source).HasMaxLength(20).IsRequired();
        e.Property(x => x.SourceRef).HasMaxLength(120);

        // O mesmo slug pode existir em fontes diferentes; dentro da fonte é único. Idem a referência de origem (vários nulos
        // são aceitos: o exercício próprio não tem origem).
        e.HasIndex(x => new { x.Source, x.Slug }).IsUnique();
        e.HasIndex(x => new { x.Source, x.SourceRef }).IsUnique();

        e.Property(x => x.Name).HasMaxLength(Exercise.NameMax).IsRequired();
        e.Property(x => x.Instructions).HasColumnType("text[]").IsRequired();
        e.Property(x => x.PrimaryMuscles).HasColumnType("text[]").IsRequired();
        e.Property(x => x.SecondaryMuscles).HasColumnType("text[]").IsRequired();
        e.Property(x => x.Equipment).HasMaxLength(20).IsRequired();
        e.Property(x => x.RecordType).HasMaxLength(20).IsRequired();
        e.Property(x => x.StepKg).HasPrecision(6, 2);

        e.Property(x => x.Level).HasMaxLength(40);
        e.Property(x => x.Category).HasMaxLength(40);
        e.Property(x => x.Mechanic).HasMaxLength(40);
        e.Property(x => x.License).HasMaxLength(60);
        e.Property(x => x.LicenseAuthor).HasMaxLength(200);
        e.Property(x => x.LicenseUrl).HasMaxLength(300);

        // A ordem do cursor da leitura incremental: sem este índice cada página varreria a tabela.
        e.HasIndex(x => new { x.UpdatedAt, x.Id });
        e.HasIndex(x => x.OwnerUserId);

        // Duas escritas ao mesmo tempo no mesmo registro: a que chega com o valor antigo é recusada e relê (regra do último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Ignore(x => x.IsDeleted);
        e.Ignore(x => x.IsCatalog);
    }
}

internal sealed class ExerciseOverrideConfiguration : IEntityTypeConfiguration<ExerciseOverride>
{
    public void Configure(EntityTypeBuilder<ExerciseOverride> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("exercise_overrides");
        e.HasKey(x => new { x.UserId, x.ExerciseId });
        e.Property(x => x.StepKg).HasPrecision(6, 2);

        // Mesmo schema, então a chave estrangeira é permitida; a linha do exercício nunca é apagada de verdade.
        e.HasOne<Exercise>().WithMany().HasForeignKey(x => x.ExerciseId).OnDelete(DeleteBehavior.Cascade);
        e.HasIndex(x => new { x.UpdatedAt, x.ExerciseId });
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
    }
}

internal sealed class CatalogMetaConfiguration : IEntityTypeConfiguration<CatalogMeta>
{
    public void Configure(EntityTypeBuilder<CatalogMeta> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("catalog_meta", t => t.HasCheckConstraint("ck_catalog_meta_single_row", "id = 1"));
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();
    }
}
