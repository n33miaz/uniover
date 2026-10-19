using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.DenyPairing;

internal sealed record DenyPairingRequest(string? UserCode);

internal sealed record DenyPairingCommand(Guid UserId, string UserCode, ClientInfo Client);

internal sealed class DenyPairingHandler(DevicesDbContext db, PairingAuditWriter audit, TimeProvider time)
{
    /// <summary><c>false</c> quando o código não existe, venceu ou já foi decidido.</summary>
    public async Task<bool> HandleAsync(DenyPairingCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var now = time.GetUtcNow();
        var pairing = await db.Pairings.SingleOrDefaultAsync(p => p.UserCode == command.UserCode, cancellationToken);
        if (pairing is null || !pairing.IsOpenAt(now))
        {
            return false;
        }

        pairing.Deny(now);
        audit.Add(PairingEvents.Denied, command.Client, pairingId: pairing.Id, userId: command.UserId);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            return true;
        }
        catch (DbUpdateConcurrencyException)
        {
            // Uma aprovação do mesmo código chegou primeiro.
            db.ChangeTracker.Clear();
            return false;
        }
    }
}

internal static class DenyPairingEndpoint
{
    // Recusar é ação protetora (impede um pareamento): só pede login, sem passkey.
    public static void MapDenyPairing(this IEndpointRouteBuilder group) =>
        group.MapPost("/pairing/deny", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Pairing);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        HttpContext http,
        DenyPairingRequest? request,
        DenyPairingHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return PairingProblems.Unauthenticated();
        }

        if (string.IsNullOrEmpty(request?.UserCode))
        {
            return ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["userCode"] = ["Informe o código mostrado no aparelho."],
            });
        }

        var code = UserCode.Normalize(request.UserCode);
        if (code is null || !await handler.HandleAsync(new DenyPairingCommand(userId, code, ClientInfo.From(http)), cancellationToken))
        {
            return PairingProblems.NotFound();
        }

        return TypedResults.NoContent();
    }
}
