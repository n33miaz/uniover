using Microsoft.EntityFrameworkCore;
using Npgsql;
using UniOver.BuildingBlocks.Messaging;
using UniOver.Modules.Devices.Contracts.Pairing;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;
using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Features.ApprovePairing;

/// <param name="UserCode">Já normalizado (<see cref="Domain.UserCode.Normalize"/>).</param>
/// <param name="Name">Nome final escolhido pelo dono; nulo mantém o nome que o agente pediu.</param>
internal sealed record ApprovePairingCommand(Guid UserId, string UserCode, string? Name, ClientInfo Client);

internal sealed record ApprovedAgent(Guid Id, string Slug, string Name, string Platform);

internal sealed class ApprovePairingHandler(
    DevicesDbContext db,
    IEventBus events,
    PairingAuditWriter audit,
    TimeProvider time)
{
    private const string UniqueViolation = "23505";
    private const int SlugAttempts = 5;

    /// <summary>Agente criado; nulo quando o código não existe, venceu ou já foi decidido (a borda responde 404 genérico).</summary>
    public async Task<ApprovedAgent?> HandleAsync(ApprovePairingCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        for (var attempt = 1; ; attempt++)
        {
            var now = time.GetUtcNow();
            var pairing = await db.Pairings.SingleOrDefaultAsync(p => p.UserCode == command.UserCode, cancellationToken);
            if (pairing is null || !pairing.IsOpenAt(now))
            {
                return null;
            }

            var name = command.Name ?? pairing.RequestedName;
            var baseSlug = name == pairing.RequestedName ? pairing.RequestedSlug : AgentSlug.Derive(name);
            var slug = await FreeSlugAsync(baseSlug, cancellationToken);

            var agent = Agent.Create(IdGenerator.NewId(), slug, name, pairing.Platform, command.UserId, now);
            pairing.Approve(now, command.UserId, name, agent.Id);
            db.Agents.Add(agent);
            audit.Add(PairingEvents.Approved, command.Client, agentId: agent.Id, pairingId: pairing.Id, userId: command.UserId);

            // Mesma transação do SaveChanges: o agente e o evento saem juntos ou nenhum dos dois sai.
            await events.PublishAsync(new AgentPaired(IdGenerator.NewId(), now, agent.Id, agent.Slug), cancellationToken);

            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return new ApprovedAgent(agent.Id, agent.Slug, agent.Name, agent.Platform);
            }
            catch (DbUpdateConcurrencyException)
            {
                // Outra aprovação (ou recusa) do mesmo código chegou primeiro.
                db.ChangeTracker.Clear();
                return null;
            }
            catch (DbUpdateException ex) when (attempt < SlugAttempts && IsUniqueViolation(ex))
            {
                // Outro agente tomou o slug entre a consulta e a gravação: recomeça escolhendo o próximo livre.
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>O slug pedido se estiver livre; senão o primeiro sufixo livre (<c>-2</c>, <c>-3</c>...).</summary>
    private async Task<string> FreeSlugAsync(string baseSlug, CancellationToken cancellationToken)
    {
        var taken = await db.Agents.AsNoTracking()
            .Where(a => a.Slug.StartsWith(baseSlug))
            .Select(a => a.Slug)
            .ToListAsync(cancellationToken);

        var candidate = baseSlug;
        for (var n = 1; taken.Contains(candidate, StringComparer.Ordinal); n++)
        {
            candidate = AgentSlug.WithSuffix(baseSlug, n + 1);
        }

        return candidate;
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: UniqueViolation };
}
