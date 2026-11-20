using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Contracts;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// A conta de convidado ganhou o módulo da TV (aceite do convite de conta, ou o administrador o acrescentou): ela passa a
/// seguir a TV padrão (<see cref="TvDefaultFollower"/>), como a conta antiga sempre seguiu. A seleção já consulta a concessão
/// vigente no Identity quando a marca falta; a marca materializa o vínculo no schema da TV e poupa essa leitura.
/// <para>
/// Só grava a marca. Filiação e retirada continuam valendo antes dela na seleção, então não há bloqueio a tomar, e a
/// reentrega do mesmo evento é inofensiva: a marca repetida é ignorada, e quem foi retirado da TV continua sem TV.
/// </para>
/// </summary>
internal sealed class DefaultTvFollowerGrant(TvDbContext db, TimeProvider time) : IIntegrationEventHandler<GuestModulesGranted>
{
    public async Task HandleAsync(GuestModulesGranted integrationEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(integrationEvent);

        if (!integrationEvent.Modules.Contains(AccessPermissions.TvModule, StringComparer.Ordinal))
        {
            return;
        }

        var userId = integrationEvent.UserId;
        if (await db.TvDefaultFollowers.AnyAsync(f => f.UserId == userId, cancellationToken))
        {
            return;
        }

        db.TvDefaultFollowers.Add(TvDefaultFollower.Create(userId, time.GetUtcNow()));
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Duas entregas do mesmo aviso ao mesmo tempo: a outra gravou a mesma marca.
            db.ChangeTracker.Clear();
        }
    }
}
