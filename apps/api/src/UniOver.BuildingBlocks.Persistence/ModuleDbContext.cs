using Microsoft.EntityFrameworkCore;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Base do DbContext de cada módulo: um schema próprio, nada em <c>public</c>.
/// Não existe <c>SET search_path</c> de propósito: o pooler do Neon (modo transação) não preserva estado de
/// sessão, então todo objeto é qualificado pelo schema.
/// </summary>
public abstract class ModuleDbContext(DbContextOptions options) : DbContext(options)
{
    /// <summary>Nome do schema do módulo, em snake_case (ex.: <c>identity</c>).</summary>
    protected abstract string Schema { get; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.HasDefaultSchema(Schema);
        base.OnModelCreating(modelBuilder);
    }
}
