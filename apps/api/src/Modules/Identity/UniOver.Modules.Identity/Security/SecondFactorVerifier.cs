using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

internal enum SecondFactorStatus { NotRequired, Required, Accepted, Invalid, Unavailable }

/// <summary>Valida um passo TOTP ou consome um código de recuperação dentro da transação do chamador.</summary>
internal sealed class SecondFactorVerifier(IdentityDbContext db, TotpKeyProvider key)
{
    public async Task<SecondFactorStatus> VerifyAsync(
        Guid userId, string? totpCode, string? recoveryCode, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var factor = await db.TotpFactors.AsNoTracking().SingleOrDefaultAsync(
            f => f.UserId == userId && f.ActivatedAt != null, cancellationToken);
        if (factor is null) return SecondFactorStatus.NotRequired;
        if (string.IsNullOrEmpty(totpCode) && string.IsNullOrEmpty(recoveryCode)) return SecondFactorStatus.Required;
        if (!string.IsNullOrEmpty(totpCode) && !string.IsNullOrEmpty(recoveryCode)) return SecondFactorStatus.Invalid;

        if (!string.IsNullOrEmpty(recoveryCode))
        {
            var hash = RecoveryCodes.Hash(recoveryCode);
            if (hash is null) return SecondFactorStatus.Invalid;
            var consumed = await db.AccountRecoveryCodes
                .Where(c => c.UserId == userId && c.CodeHash == hash && c.UsedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.UsedAt, now), cancellationToken);
            return consumed == 1 ? SecondFactorStatus.Accepted : SecondFactorStatus.Invalid;
        }

        if (!key.Available) return SecondFactorStatus.Unavailable;
        byte[] secret;
        try { secret = key.Unprotect(userId, factor.EncryptedSecret); }
        catch (CryptographicException) { return SecondFactorStatus.Unavailable; }
        var step = TotpCodes.Match(secret, totpCode, now, factor.LastAcceptedStep ?? -1);
        CryptographicOperations.ZeroMemory(secret);
        if (step is null) return SecondFactorStatus.Invalid;
        var updated = await db.TotpFactors
            .Where(f => f.UserId == userId && f.ActivatedAt != null &&
                (f.LastAcceptedStep == null || f.LastAcceptedStep < step.Value))
            .ExecuteUpdateAsync(s => s.SetProperty(f => f.LastAcceptedStep, step.Value), cancellationToken);
        return updated == 1 ? SecondFactorStatus.Accepted : SecondFactorStatus.Invalid;
    }
}
