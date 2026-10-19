using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.StartPairing;

internal sealed record StartPairingCommand(string AgentName, string Platform, string AgentVersion, ClientInfo Client);

internal sealed record StartPairingResult(
    bool TooManyActive,
    Guid PairingId = default,
    string? DeviceCode = null,
    string? UserCode = null,
    int ExpiresInSeconds = 0,
    int IntervalSeconds = 0,
    TimeSpan RetryAfter = default);

internal sealed class StartPairingHandler(
    DevicesDbContext db,
    PairingAuditWriter audit,
    TimeProvider time,
    IOptions<DevicesModuleOptions> options)
{
    private const string UniqueViolation = "23505";
    private const int CodeAttempts = 5;

    /// <summary>Pedidos vencidos há mais que isto são apagados: a tabela não cresce e o código volta a ficar livre.</summary>
    private static readonly TimeSpan Retention = TimeSpan.FromHours(1);

    public async Task<StartPairingResult> HandleAsync(StartPairingCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value.Pairing;
        var now = time.GetUtcNow();

        // Limpeza oportunista (a rota é anônima e não há tarefa de fundo): nada pendente mais velho que a retenção sobra.
        var cutoff = now - Retention;
        await db.Pairings
            .Where(p => p.ExpiresAt < cutoff || (p.ConsumedAt != null && p.ConsumedAt < cutoff) || (p.DeniedAt != null && p.DeniedAt < cutoff))
            .ExecuteDeleteAsync(cancellationToken);

        var active = await db.Pairings.CountAsync(
            p => p.ExpiresAt > now && p.ApprovedAt == null && p.DeniedAt == null && p.ConsumedAt == null, cancellationToken);
        if (active >= settings.MaxActive)
        {
            return new StartPairingResult(true, RetryAfter: settings.MinPollInterval);
        }

        var slug = AgentSlug.Derive(command.AgentName);
        for (var attempt = 1; ; attempt++)
        {
            var (deviceCode, deviceCodeHash) = DeviceSecrets.NewDeviceCode();
            var userCode = UserCode.Generate();
            var pairing = PairingRequest.Create(
                deviceCodeHash, userCode, command.AgentName, slug, command.Platform, command.AgentVersion, now, settings.Validity);
            db.Pairings.Add(pairing);
            audit.Add(PairingEvents.Started, command.Client, pairingId: pairing.Id);

            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException ex) when (attempt < CodeAttempts && IsUniqueViolation(ex))
            {
                // Colisão de código de usuário (probabilidade desprezível): descarta e sorteia outro.
                db.ChangeTracker.Clear();
                continue;
            }

            return new StartPairingResult(
                false,
                pairing.Id,
                deviceCode,
                UserCode.Format(userCode),
                (int)settings.Validity.TotalSeconds,
                (int)settings.MinPollInterval.TotalSeconds);
        }
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: UniqueViolation };
}
