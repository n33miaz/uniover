using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Guarda e consome os desafios do WebAuthn. A limpeza das linhas vencidas é oportunista (acontece ao gravar um
/// desafio novo): não há tarefa periódica, para o banco do Neon poder dormir.
/// </summary>
internal sealed class ChallengeStore(IdentityDbContext db, TimeProvider time)
{
    public async Task<WebAuthnChallenge> IssueAsync(
        Guid userId, string purpose, string? action, string optionsJson, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var challenge = WebAuthnChallenge.Create(userId, purpose, action, optionsJson, now);

        await PurgeExpiredAsync(now, cancellationToken);
        db.WebAuthnChallenges.Add(challenge);
        await db.SaveChangesAsync(cancellationToken);
        return challenge;
    }

    /// <summary>
    /// Devolve o desafio e o apaga numa só operação condicional: só quem apaga a linha de fato o recebe, então
    /// repetir a resposta (ou duas respostas ao mesmo tempo) falha. Uma verificação que dá errado depois disso
    /// também gasta o desafio, de propósito: o autenticador precisa de um novo.
    /// </summary>
    public async Task<WebAuthnChallenge?> ConsumeAsync(
        Guid challengeId, Guid userId, string purpose, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var challenge = await db.WebAuthnChallenges.AsNoTracking()
            .SingleOrDefaultAsync(
                c => c.Id == challengeId && c.UserId == userId && c.Purpose == purpose && c.ExpiresAt > now,
                cancellationToken);
        if (challenge is null)
        {
            return null;
        }

        var deleted = await db.WebAuthnChallenges
            .Where(c => c.Id == challengeId && c.ExpiresAt > now)
            .ExecuteDeleteAsync(cancellationToken);
        return deleted == 1 ? challenge : null;
    }

    /// <summary>Apaga desafios e confirmações já vencidos (sem tarefa de fundo, só quando se grava algo novo).</summary>
    public async Task PurgeExpiredAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await db.WebAuthnChallenges.Where(c => c.ExpiresAt <= now).ExecuteDeleteAsync(cancellationToken);
        await db.StepUpConfirmations.Where(c => c.ExpiresAt <= now).ExecuteDeleteAsync(cancellationToken);
    }
}
