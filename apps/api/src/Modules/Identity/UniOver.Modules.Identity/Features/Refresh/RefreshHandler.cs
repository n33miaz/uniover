using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Refresh;

internal sealed record RefreshCommand(string? Secret, ClientInfo Client);

internal sealed record RefreshResponse(string AccessToken, [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);

internal enum RefreshStatus
{
    Succeeded,

    /// <summary>Token desconhecido, vencido, revogado ou reutilizado: o cliente precisa de um login novo.</summary>
    Unauthenticated,

    /// <summary>Duas abas giraram o mesmo token juntas; o cliente relê o cookie novo e tenta de novo.</summary>
    Conflict,
}

internal sealed record RefreshResult(
    RefreshStatus Status,
    string? AccessToken = null,
    int ExpiresInSeconds = 0,
    string? RefreshSecret = null,
    TimeSpan RefreshMaxAge = default);

/// <summary>
/// Refresh rotativo. Cada uso gira o token dentro da família; um token já girado que reaparece fora da
/// tolerância revoga a família inteira (alguém guardou uma cópia).
/// </summary>
internal sealed class RefreshHandler(
    IdentityDbContext db,
    AccessTokenIssuer tokens,
    LoginAuditWriter audit,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    public async Task<RefreshResult> HandleAsync(RefreshCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var settings = options.Value;
        var policy = settings.Refresh;
        var now = time.GetUtcNow();

        var hash = SecretTokens.Hash(command.Secret);
        if (hash is null)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var token = await db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        switch (token.Evaluate(now, policy.ReuseGrace))
        {
            case RefreshDecision.Reuse:
                await RevokeFamilyAsync(token, now, command.Client, cancellationToken);
                return new RefreshResult(RefreshStatus.Unauthenticated);
            case RefreshDecision.Conflict:
                return new RefreshResult(RefreshStatus.Conflict);
            case RefreshDecision.Expired:
                return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        // O teto absoluto sai da data do primeiro token da família: não há coluna própria para ele.
        var familyStartedAt = await db.RefreshTokens
            .Where(t => t.FamilyId == token.FamilyId)
            .MinAsync(t => t.CreatedAt, cancellationToken);
        if (policy.FamilyExpired(now, familyStartedAt))
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var (secret, newHash) = SecretTokens.Generate();
        var expiresAt = policy.ExpiryFor(now, familyStartedAt);
        var next = RefreshToken.Create(
            token.UserId, token.FamilyId, newHash, now, expiresAt, command.Client.Ip, command.Client.UserAgent);

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // O UPDATE condicional é o que garante UM vencedor quando duas requisições giram o mesmo token ao
        // mesmo tempo: só quem encontra used_at e revoked_at vazios consegue marcar.
        var tokenId = token.Id;
        var claimed = await db.RefreshTokens
            .Where(t => t.Id == tokenId && t.UsedAt == null && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.UsedAt, now).SetProperty(t => t.ReplacedById, next.Id),
                cancellationToken);
        if (claimed != 1)
        {
            return new RefreshResult(RefreshStatus.Conflict);
        }

        db.RefreshTokens.Add(next);
        audit.Add(token.UserId, AuditEvents.RefreshSucceeded, command.Client);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var access = tokens.Issue(token.UserId, token.FamilyId, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
        return new RefreshResult(
            RefreshStatus.Succeeded,
            access.Value,
            (int)settings.AccessLifetime.TotalSeconds,
            secret,
            expiresAt - now);
    }

    private async Task RevokeFamilyAsync(RefreshToken token, DateTimeOffset now, ClientInfo client, CancellationToken cancellationToken)
    {
        var familyId = token.FamilyId;
        await db.RefreshTokens
            .Where(t => t.FamilyId == familyId && t.RevokedAt == null)
            .ExecuteUpdateAsync(
                s => s.SetProperty(t => t.RevokedAt, now).SetProperty(t => t.RevokedReason, RevokeReasons.Reuse),
                cancellationToken);

        // Sessão possivelmente roubada: nenhuma confirmação dela continua valendo.
        await db.StepUpConfirmations
            .Where(c => c.SessionFamilyId == familyId)
            .ExecuteDeleteAsync(cancellationToken);

        audit.Add(token.UserId, AuditEvents.RefreshReuseDetected, client);
        await db.SaveChangesAsync(cancellationToken);
    }
}
