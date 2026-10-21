using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.GetMe;

/// <summary>
/// A própria conta, e só ela (nenhum dado de outra pessoa passa por aqui).
/// </summary>
/// <param name="DisplayNameConfirmed">Falso enquanto a pessoa não escolheu o nome (o app pergunta no próximo acesso).</param>
/// <param name="Permissions">As permissões em vigor, na ordem do catálogo; para o dono, todas. A mesma lista que o servidor aplica.</param>
internal sealed record MeResponse(
    Guid Id,
    string Email,
    string DisplayName,
    string Role,
    bool DisplayNameConfirmed,
    IReadOnlyList<string> Permissions);

internal sealed class GetMeHandler(IdentityDbContext db, AccessGrantsService grants)
{
    /// <summary>Nulo se a conta já não existe (JWT ainda válido de uma conta apagada).</summary>
    public async Task<MeResponse?> HandleAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var account = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Id, u.Email, u.DisplayName, u.Role, Confirmed = u.DisplayNameConfirmedAt != null })
            .SingleOrDefaultAsync(cancellationToken);
        if (account is null)
        {
            return null;
        }

        // As permissões vêm do banco pelo mesmo caminho (e o mesmo cache de 30 s) que as rotas protegidas usam: o que a tela
        // mostra é o que o servidor aplica.
        var permissions = await grants.GetAsync(account.Id, cancellationToken);
        return new MeResponse(account.Id, account.Email, account.DisplayName, account.Role, account.Confirmed, permissions);
    }
}
