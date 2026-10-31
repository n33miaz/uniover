using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Diz o que cada conta pode fazer AGORA, lendo do banco (papel, conta ativa e <c>user_grants</c>): nenhuma permissão
/// vem do JWT. A resposta fica num cache em memória de prazo curto por conta (o mesmo prazo e a mesma opção da revogação
/// do convidado, <see cref="IdentityModuleOptions.GuestStatusCacheSeconds"/>, padrão 30 s), porque a TV e o Treino
/// conferem isso a cada chamada e o banco não pode ser consultado a cada tecla.
/// <para>
/// Mudança vale em até esse prazo: quando as permissões mudam ou o acesso é revogado NESTA instância,
/// <see cref="Invalidate"/> apaga a conta do cache e vale na hora; em outra instância, em até 30 s. O dono tem todas as
/// permissões (sem linhas de concessão). Conta inexistente, revogada ou com erro de leitura: nada (falha fechada, e o
/// erro nunca vai para o cache).
/// </para>
/// Cache em memória do próprio módulo, atrás da porta <see cref="IAccessGrants"/>; a instância é do contêiner.
/// </summary>
internal sealed partial class AccessGrantsService(
    IServiceScopeFactory scopes,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options,
    ILogger<AccessGrantsService> logger) : IAccessGrants
{
    private const int PruneAbove = 512;

    // Só o tipo da exceção: a mensagem de driver pode trazer detalhes de conexão. Nenhum id de conta no log.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível ler as permissões ({ErrorType}): acesso negado por precaução.")]
    private static partial void LogReadFailed(ILogger logger, string errorType);

    private static readonly string[] None = [];

    private readonly ConcurrentDictionary<Guid, Entry> _cache = new();

    // Sobe a cada invalidação. Uma leitura que começou antes de uma invalidação não grava no cache o que leu (podia ser
    // o valor antigo): sem isto, uma leitura em voo desfaria a invalidação por até um prazo inteiro.
    private long _epoch;

    private sealed record Entry(IReadOnlyList<string> Permissions, IReadOnlySet<string> Lookup, DateTimeOffset Expires);

    public async Task<bool> HasAsync(Guid userId, string permission, CancellationToken cancellationToken = default)
    {
        if (!AccessPermissions.IsKnown(permission))
        {
            return false;
        }

        return (await LoadAsync(userId, cancellationToken)).Lookup.Contains(permission);
    }

    public async Task<IReadOnlyList<string>> GetAsync(Guid userId, CancellationToken cancellationToken = default) =>
        (await LoadAsync(userId, cancellationToken)).Permissions;

    /// <summary>Esquece a conta já: a próxima conferência lê o banco. Chamar depois do commit de quem mudou as permissões ou revogou.</summary>
    public void Invalidate(Guid userId)
    {
        Interlocked.Increment(ref _epoch);
        _cache.TryRemove(userId, out _);
    }

    private async Task<Entry> LoadAsync(Guid userId, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        if (_cache.TryGetValue(userId, out var cached) && cached.Expires > now)
        {
            return cached;
        }

        var epoch = Interlocked.Read(ref _epoch);
        IReadOnlyList<string> permissions;
        try
        {
            permissions = await ReadAsync(userId, cancellationToken);
        }
#pragma warning disable CA1031 // Falha fechada: sem conseguir ler, nada é concedido (e nada é gravado no cache).
        catch (Exception ex) when (ex is not OperationCanceledException)
#pragma warning restore CA1031
        {
            LogReadFailed(logger, ex.GetType().Name);
            return new Entry(None, new HashSet<string>(), now);
        }

        var entry = new Entry(permissions, new HashSet<string>(permissions, StringComparer.Ordinal), now + options.Value.GuestStatusCacheLifetime);
        if (Interlocked.Read(ref _epoch) == epoch)
        {
            Store(userId, entry, now);
        }

        return entry;
    }

    private async Task<IReadOnlyList<string>> ReadAsync(Guid userId, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();

        var account = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Role, u.DisabledAt, u.PausedAt })
            .SingleOrDefaultAsync(cancellationToken);

        // Conta que não existe (apagada à mão) ou revogada não tem nada.
        if (account is null || account.DisabledAt is not null || account.PausedAt is not null)
        {
            return None;
        }

        // O dono tem tudo e não tem linhas de concessão.
        if (string.Equals(account.Role, AccountRoles.Owner, StringComparison.Ordinal))
        {
            return AccessPermissions.All;
        }

        if (!string.Equals(account.Role, AccountRoles.Guest, StringComparison.Ordinal))
        {
            return None;
        }

        var stored = await db.UserGrants.AsNoTracking()
            .Where(g => g.UserId == userId)
            .Select(g => g.Permission)
            .ToListAsync(cancellationToken);

        // A segunda trava: ação sem o módulo dela e permissão que saiu do catálogo não valem, mesmo gravadas.
        return PermissionRules.Effective(stored);
    }

    private void Store(Guid userId, Entry entry, DateTimeOffset now)
    {
        if (_cache.Count > PruneAbove)
        {
            foreach (var (key, value) in _cache)
            {
                if (value.Expires <= now)
                {
                    _cache.TryRemove(key, out _);
                }
            }
        }

        _cache[userId] = entry;
    }
}
