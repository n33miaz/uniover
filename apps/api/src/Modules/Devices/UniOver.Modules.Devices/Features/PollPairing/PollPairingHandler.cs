using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PollPairing;

internal enum PollStatus
{
    NotFound,
    Pending,
    SlowDown,
    Approved,
    Expired,
    Denied,
    Consumed,
}

internal sealed record PollPairingCommand(Guid PairingId, string DeviceCode, ClientInfo Client);

internal sealed record PollPairingResult(PollStatus Status, string? AgentId = null, string? DeviceToken = null, int IntervalSeconds = 0);

internal sealed class PollPairingHandler(
    DevicesDbContext db,
    PairingAuditWriter audit,
    TimeProvider time,
    IOptions<DevicesModuleOptions> options)
{
    /// <summary>Quanto o <c>slow_down</c> soma ao intervalo (RFC 8628).</summary>
    public const int SlowDownStepSeconds = 5;

    public async Task<PollPairingResult> HandleAsync(PollPairingCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value.Pairing;
        var now = time.GetUtcNow();

        // Id inexistente e deviceCode errado caem na mesma resposta: quem tenta não enumera pareamentos.
        var presented = DeviceSecrets.HashDeviceCode(command.DeviceCode);
        var pairing = await db.Pairings.SingleOrDefaultAsync(p => p.Id == command.PairingId, cancellationToken);
        if (presented is null || pairing is null || !DeviceSecrets.Matches(pairing.DeviceCodeHash, presented))
        {
            return new PollPairingResult(PollStatus.NotFound);
        }

        var baseInterval = (int)settings.MinPollInterval.TotalSeconds;
        switch (pairing.Evaluate(now, settings.MinPollInterval))
        {
            case PollOutcome.Pending:
                return await RegisterPollAsync(pairing, now, new PollPairingResult(PollStatus.Pending), cancellationToken);

            case PollOutcome.SlowDown:
                // Insistir também conta como consulta: quem corre mais que o intervalo continua mandado esperar.
                return await RegisterPollAsync(
                    pairing, now, new PollPairingResult(PollStatus.SlowDown, IntervalSeconds: baseInterval + SlowDownStepSeconds), cancellationToken);

            case PollOutcome.Expired:
                await AuditExpiredOnceAsync(pairing, command.Client, cancellationToken);
                return new PollPairingResult(PollStatus.Expired);

            case PollOutcome.Denied:
                return new PollPairingResult(PollStatus.Denied);

            case PollOutcome.Consumed:
                return new PollPairingResult(PollStatus.Consumed);

            default:
                return await IssueTokenAsync(pairing, now, command.Client, cancellationToken);
        }
    }

    private async Task<PollPairingResult> RegisterPollAsync(
        PairingRequest pairing, DateTimeOffset now, PollPairingResult result, CancellationToken cancellationToken)
    {
        pairing.RegisterPoll(now);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException)
        {
            // O dono decidiu entre a leitura e a gravação: a próxima consulta já vê a decisão.
            db.ChangeTracker.Clear();
        }

        return result;
    }

    private async Task AuditExpiredOnceAsync(PairingRequest pairing, ClientInfo client, CancellationToken cancellationToken)
    {
        var already = await db.PairingAudit.AnyAsync(
            a => a.PairingId == pairing.Id && a.Event == PairingEvents.Expired, cancellationToken);
        if (!already)
        {
            audit.Add(PairingEvents.Expired, client, pairingId: pairing.Id);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private async Task<PollPairingResult> IssueTokenAsync(
        PairingRequest pairing, DateTimeOffset now, ClientInfo client, CancellationToken cancellationToken)
    {
        var agent = await db.Agents.SingleOrDefaultAsync(a => a.Id == pairing.AgentId, cancellationToken);
        if (agent is null)
        {
            return new PollPairingResult(PollStatus.NotFound);
        }

        // Revogado antes de recolher o token: nada a entregar, e nenhum token novo nasce para um agente revogado.
        if (agent.IsRevoked)
        {
            return new PollPairingResult(PollStatus.Denied);
        }

        // Outra consulta ganhou a corrida entre a leitura do pareamento e a do agente: o token já saiu.
        if (agent.TokenHash is not null)
        {
            return new PollPairingResult(PollStatus.Consumed);
        }

        var (token, hash) = DeviceSecrets.NewDeviceToken();
        pairing.Consume(now);
        agent.IssueToken(hash);
        audit.Add(PairingEvents.TokenIssued, client, agentId: agent.Id, pairingId: pairing.Id);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Revogar e entregar o token usam a mesma versão de RevokedAt: se a revogação venceu, não entregar token.
            db.ChangeTracker.Clear();
            var revoked = await db.Agents.AsNoTracking()
                .AnyAsync(a => a.Id == agent.Id && a.RevokedAt != null, cancellationToken);
            return new PollPairingResult(revoked ? PollStatus.Denied : PollStatus.Consumed);
        }

        return new PollPairingResult(PollStatus.Approved, agent.Slug, token);
    }
}
