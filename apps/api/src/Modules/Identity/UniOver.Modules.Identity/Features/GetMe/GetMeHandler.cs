using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.GetMe;

internal sealed record MeResponse(Guid Id, string Email, string DisplayName, string Role);

internal sealed class GetMeHandler(IdentityDbContext db)
{
    /// <summary>Nulo se a conta já não existe (JWT ainda válido de uma conta apagada).</summary>
    public async Task<MeResponse?> HandleAsync(Guid userId, CancellationToken cancellationToken = default) =>
        await db.Users
            .Where(u => u.Id == userId)
            .Select(u => new MeResponse(u.Id, u.Email, u.DisplayName, u.Role))
            .SingleOrDefaultAsync(cancellationToken);
}
