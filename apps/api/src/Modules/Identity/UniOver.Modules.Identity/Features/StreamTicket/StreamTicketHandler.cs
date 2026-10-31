using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.StreamTicket;

internal sealed record StreamTicketCommand(Guid UserId, Guid SessionId);

internal sealed record StreamTicketResponse([property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);

internal sealed record StreamTicketResult(IssuedToken? Ticket, TimeSpan Lifetime);

internal sealed class StreamTicketHandler(
    IdentityDbContext db,
    AccessTokenIssuer tokens,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    /// <summary>
    /// Bilhete curto (120 s) para abrir uma conexão SSE por cookie. Só sai se a sessão ainda existe: o JWT de
    /// acesso vive até 10 min depois do logout, e não deve poder abrir stream nesse intervalo.
    /// </summary>
    public async Task<StreamTicketResult> HandleAsync(StreamTicketCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var lifetime = options.Value.StreamTicketLifetime;
        var familyId = command.SessionId;
        var userId = command.UserId;
        var alive = await db.RefreshTokens.AnyAsync(
            t => t.FamilyId == familyId && t.UserId == userId && t.RevokedAt == null, cancellationToken);
        if (!alive)
        {
            return new StreamTicketResult(null, lifetime);
        }


        // O bilhete leva o papel (a política do stream decide por ele) e não sai para conta revogada.
        var account = await db.Users
            .Where(u => u.Id == userId)
            .Select(u => new { u.Role, u.DisabledAt, u.PausedAt })
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null || account.DisabledAt is not null || account.PausedAt is not null)
        {
            return new StreamTicketResult(null, lifetime);
        }

        var ticket = tokens.Issue(userId, familyId, account.Role, UniOverAuth.StreamAudience, lifetime, time.GetUtcNow());
        return new StreamTicketResult(ticket, lifetime);
    }
}
