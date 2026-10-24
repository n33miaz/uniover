using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// Materializa a TV no instante em que o computador é aprovado. Recebe a conexão e a transação do Devices porque a pessoa
/// não pode ficar com um computador pareado que ainda exige uma segunda configuração manual para virar TV. O contexto é
/// criado aqui, sobre a conexão recebida: o restante dos contextos continua com a conexão própria de sempre.
/// </summary>
internal sealed class PairedTvRegistrar(TimeProvider time) : IPairedTvRegistrar
{
    public async Task RegisterAsync(
        PairedTvRegistration registration,
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);

        var builder = new DbContextOptionsBuilder<TvDbContext>();
        ModuleDatabase.Configure(builder, connection, TvDbContext.SchemaName, typeof(TvDbContext).Assembly);
        await using var db = new TvDbContext(builder.Options);
        await db.Database.UseTransactionAsync(transaction, cancellationToken);

        var now = time.GetUtcNow();
        var hasDefault = await db.Tvs.AnyAsync(tv => tv.IsDefault, cancellationToken);
        // Nome recusado pelas regras da TV (invisíveis, longo demais) não derruba a aprovação: cai no nome do computador.
        var name = registration.Name is not null && BindAgentValidator.ValidateName(registration.Name).Count == 0
            ? registration.Name
            : registration.AgentName;
        var tv = ConfiguredTv.Create(name, registration.AgentSlug, !hasDefault, registration.OwnerId, now);
        db.Tvs.Add(tv);
        db.TvMembers.AddRange(registration.MemberIds.Distinct().Select(userId => TvMember.Create(tv.Id, userId, now)));
        await db.SaveChangesAsync(cancellationToken);
    }
}
