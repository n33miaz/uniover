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

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var familyId = token.FamilyId;

        // Toda rotação e revogação da família passa pela mesma trava transacional. Sem ela, o replay pode atualizar
        // os tokens existentes enquanto uma rotação ainda está para inserir o sucessor, deixando esse sucessor ativo.
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({familyId.ToString("N")}, 0))",
            cancellationToken);
        await db.Entry(token).ReloadAsync(cancellationToken);
        if (db.Entry(token).State == EntityState.Detached)
        {
            return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        var now = time.GetUtcNow();

        switch (token.Evaluate(now, policy.ReuseGrace))
        {
            case RefreshDecision.Reuse:
                await RevokeFamilyAsync(token, now, command.Client, cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new RefreshResult(RefreshStatus.Unauthenticated);
            case RefreshDecision.Conflict:
                return new RefreshResult(RefreshStatus.Conflict);
            case RefreshDecision.Expired:
                return new RefreshResult(RefreshStatus.Unauthenticated);
        }

        // O papel entra no JWT novo e a conta revogada não renova: o dono troca de papel ou revoga sem esperar o refresh vencer.
        var userId = token.UserId;
        var account = await db.Users
            .Where(u => u.Id == userId)
            .Select(u => new { u.Role, u.DisabledAt })
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null || account.DisabledAt is not null)
        {
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

        var access = tokens.Issue(token.UserId, token.FamilyId, account.Role, UniOverAuth.ApiAudience, settings.AccessLifetime, now);
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

        // Quem apresentou o token já usado não está autenticado (pode ser o ladrão ou o aparelho do dono com um cookie velho):
        // o ator fica nulo e a conta do token é o alvo, como nas tentativas de login que falham.
        audit.Add(null, AuditEvents.RefreshReuseDetected, client, AuditAboutAccount.Detail(token.UserId));
        await db.SaveChangesAsync(cancellationToken);
    }
}
