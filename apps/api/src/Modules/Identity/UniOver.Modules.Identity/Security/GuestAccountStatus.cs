using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Diz se a conta de um convidado segue ativa, com cache em memória de prazo curto (padrão 30 s) por usuário: a TV
/// confere isso a cada comando, e o banco não pode ser consultado a cada tecla. A revogação feita nesta instância
/// invalida na hora (<see cref="MarkRevoked"/>); em outra instância vale em até o prazo do cache. Só o convidado
/// passa por aqui: o dono nunca paga a consulta. Cache em memória do próprio módulo, atrás da porta
/// <see cref="IAccountStatus"/>, e a instância é do contêiner.
/// </summary>
internal sealed class GuestAccountStatus(
    IServiceScopeFactory scopes,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options) : IAccountStatus
{
    private const int PruneAbove = 512;

    private readonly ConcurrentDictionary<Guid, (bool Active, DateTimeOffset Expires)> _cache = new();

    public async Task<bool> IsActiveAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        if (_cache.TryGetValue(userId, out var cached) && cached.Expires > now)
        {
            return cached.Active;
        }

        bool active;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();

            // Conta que não existe (apagada à mão) ou que não é de convidado também não vale como convidado ativo.
            var disabledAt = await db.Users.AsNoTracking()
                .Where(u => u.Id == userId && u.Role == AccountRoles.Guest)
                .Select(u => new { u.DisabledAt, u.PausedAt })
                .SingleOrDefaultAsync(cancellationToken);
            active = disabledAt is not null && disabledAt.DisabledAt is null && disabledAt.PausedAt is null;
        }
#pragma warning disable CA1031 // Falha fechada: sem conseguir conferir a conta, o convidado não passa (e nada é gravado no cache).
        catch (Exception ex) when (ex is not OperationCanceledException)
#pragma warning restore CA1031
        {
            return false;
        }

        Store(userId, active, now);
        return active;
    }

    /// <summary>Marca a conta como revogada já, sem esperar o prazo do cache.</summary>
    public void MarkRevoked(Guid userId) => Store(userId, active: false, time.GetUtcNow());

    /// <summary>Esquece a resposta guardada (a conta foi retomada): a próxima conferência lê o banco.</summary>
    public void Forget(Guid userId) => _cache.TryRemove(userId, out _);

    private void Store(Guid userId, bool active, DateTimeOffset now)
    {
        if (_cache.Count > PruneAbove)
        {
            foreach (var (key, entry) in _cache)
            {
                if (entry.Expires <= now)
                {
                    _cache.TryRemove(key, out _);
                }
            }
        }

        _cache[userId] = (active, now + options.Value.GuestStatusCacheLifetime);
    }
}
