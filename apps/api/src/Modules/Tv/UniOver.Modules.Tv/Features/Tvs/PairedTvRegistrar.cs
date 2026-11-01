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

        // Entrar numa TV apaga a marca de "retirada" da conta; o bloqueio é o mesmo de quem remove filiações e vale até o
        // commit da transação do Devices.
        await TvMembershipLedger.LockAsync(db, cancellationToken);

        var now = time.GetUtcNow();
        var hasDefault = await db.Tvs.AnyAsync(tv => tv.IsDefault, cancellationToken);
        // O apelido que a pessoa deu. Sem apelido (ou recusado pelas regras da TV: invisíveis, longo demais) a TV se chama "TV":
        // o nome do computador é técnico e só o administrador o vê, em Dispositivos; nunca vira o nome que os outros leem.
        var name = registration.Name is not null && BindAgentValidator.ValidateName(registration.Name).Count == 0
            ? registration.Name
            : null;
        var tv = ConfiguredTv.Create(name, registration.AgentSlug, registration.CanBeDefault && !hasDefault, registration.OwnerId, now);
        db.Tvs.Add(tv);
        var members = registration.MemberIds.Distinct().ToList();
        db.TvMembers.AddRange(members.Select(userId => TvMember.Create(tv.Id, userId, now)));
        await TvMembershipLedger.ReconcileAsync(db, tv.Id, [], members, now, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }
}
