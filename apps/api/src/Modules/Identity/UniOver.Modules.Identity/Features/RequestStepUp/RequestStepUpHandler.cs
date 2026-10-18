using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.RequestStepUp;

internal sealed record RequestStepUpRequest(string? Action);

internal sealed record RequestStepUpResponse(Guid ChallengeId, JsonElement Options);

internal sealed class RequestStepUpHandler(IdentityDbContext db, WebAuthn webAuthn, ChallengeStore challenges)
{
    /// <summary>Nulo quando o usuário não tem nenhuma passkey (a borda devolve 404 <c>no-passkey</c>).</summary>
    public async Task<RequestStepUpResponse?> HandleAsync(Guid userId, string action, CancellationToken cancellationToken = default)
    {
        var passkeys = await db.Passkeys.AsNoTracking().Where(p => p.UserId == userId).ToListAsync(cancellationToken);
        if (passkeys.Count == 0)
        {
            return null;
        }

        var options = webAuthn.CreateAssertionOptions(passkeys);

        // O desafio nasce preso à ação: a confirmação gravada depois sai daqui, não do que o cliente disser.
        var challenge = await challenges.IssueAsync(userId, ChallengePurposes.StepUp, action, options.ToJson(), cancellationToken);
        return new RequestStepUpResponse(challenge.Id, OptionsJson.Parse(challenge.OptionsJson));
    }
}
