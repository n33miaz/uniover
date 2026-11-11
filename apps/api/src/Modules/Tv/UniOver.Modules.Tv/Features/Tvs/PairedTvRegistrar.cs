using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Config;
using UniOver.Modules.Tv.Persistence;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// Materializa a TV no instante em que o computador é aprovado. Recebe a conexão e a transação do Devices porque a pessoa
/// não pode ficar com um computador pareado que ainda exige uma segunda configuração manual para virar TV. O contexto é
/// criado aqui, sobre a conexão recebida: o restante dos contextos continua com a conexão própria de sempre.
/// </summary>
internal sealed class PairedTvRegistrar(TimeProvider time, OutboxSignal signal, IAccountRoleDirectory? roles = null) : IPairedTvRegistrar
{
    public async Task<Action?> RegisterAsync(
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
        var published = false;
        if (hasDefault && !tv.IsDefault)
        {
            // Quem não tinha filiação enxergava a TV padrão e, ao entrar só nesta, deixa de enxergá-la: o canal direto dela, no
            // computador da padrão, é fechado pela outbox, na mesma transação do pareamento (este contexto não é o do escopo da API).
            var lostDefault = await TvMembershipLedger.FirstMembershipsAsync(db, tv.Id, members, roles, cancellationToken);
            var defaultSlug = lostDefault.Count == 0
                ? null
                : await db.Tvs.AsNoTracking().Where(t => t.IsDefault).Select(t => t.AgentSlug).FirstOrDefaultAsync(cancellationToken);
            if (defaultSlug is not null)
            {
                db.Set<OutboxMessage>().Add(OutboxMessages.Create(
                    new TvDirectAccessRemoved(IdGenerator.NewId(), now, defaultSlug, lostDefault), now));
                published = true;
            }
        }

        db.TvMembers.AddRange(members.Select(userId => TvMember.Create(tv.Id, userId, now)));
        await TvMembershipLedger.ReconcileAsync(db, tv.Id, [], members, now, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);

        // Este contexto é criado à mão, sem o interceptor que acorda o despachante no commit, e quem comita é o Devices: devolve o aviso
        // para ser dado DEPOIS do commit (antes, o despachante olharia uma linha ainda invisível e voltaria a dormir).
        return published ? () => signal.Notify(new ModuleKey(TvModule.Name)) : null;
    }
}
