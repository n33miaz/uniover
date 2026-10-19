using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.Tokens;

public enum TokenCheck
{
    Valid,
    Unknown,
    Revoked,
}

/// <summary>Resultado da validação: <see cref="AgentId"/> é o slug que aparece no envelope; <see cref="Id"/> é a chave do agente.</summary>
public sealed record DeviceTokenValidation(TokenCheck Check, Guid Id, string AgentId)
{
    public static DeviceTokenValidation Unknown { get; } = new(TokenCheck.Unknown, Guid.Empty, string.Empty);

    public bool IsValid => Check == TokenCheck.Valid;
}

/// <summary>Valida o token de dispositivo apresentado por um agente (usado no handshake do transporte).</summary>
public interface IDeviceTokenValidator
{
    Task<DeviceTokenValidation> ValidateAsync(string? token, CancellationToken cancellationToken = default);
}

/// <summary>
/// Porta do cache de validações (cache em memória só atrás de interface do próprio módulo). Guarda só
/// validações positivas; quem revoga chama <see cref="Invalidate"/> para o token não sobreviver aos 30 s.
/// </summary>
public interface IDeviceTokenCache
{
    bool TryGet(string key, out DeviceTokenValidation validation);

    void Store(string key, DeviceTokenValidation validation);

    /// <summary>Remove todas as entradas do agente.</summary>
    void Invalidate(Guid agentId);
}

/// <summary>Cache em processo, com validade curta. O estado é da instância (singleton do módulo), não estático.</summary>
internal sealed class InMemoryDeviceTokenCache(TimeProvider time, IOptions<DevicesModuleOptions> options) : IDeviceTokenCache
{
    private readonly ConcurrentDictionary<string, (DeviceTokenValidation Validation, DateTimeOffset ExpiresAt)> _entries = new();

    public bool TryGet(string key, out DeviceTokenValidation validation)
    {
        if (_entries.TryGetValue(key, out var entry))
        {
            if (time.GetUtcNow() < entry.ExpiresAt)
            {
                validation = entry.Validation;
                return true;
            }

            _entries.TryRemove(key, out _);
        }

        validation = DeviceTokenValidation.Unknown;
        return false;
    }

    public void Store(string key, DeviceTokenValidation validation)
    {
        var lifetime = options.Value.TokenCacheLifetime;
        if (lifetime > TimeSpan.Zero)
        {
            _entries[key] = (validation, time.GetUtcNow() + lifetime);
        }
    }

    public void Invalidate(Guid agentId)
    {
        foreach (var (key, entry) in _entries)
        {
            if (entry.Validation.Id == agentId)
            {
                _entries.TryRemove(key, out _);
            }
        }
    }
}

internal sealed class DeviceTokenValidator(DevicesDbContext db, IDeviceTokenCache cache) : IDeviceTokenValidator
{
    public async Task<DeviceTokenValidation> ValidateAsync(string? token, CancellationToken cancellationToken = default)
    {
        // Texto que nem tem a forma de um token nosso nunca chega ao banco.
        var hash = DeviceSecrets.HashPresentedToken(token);
        if (hash is null)
        {
            return DeviceTokenValidation.Unknown;
        }

        var key = Convert.ToBase64String(hash);
        if (cache.TryGet(key, out var cached))
        {
            return cached;
        }

        var agent = await db.Agents.AsNoTracking()
            .Where(a => a.TokenHash == hash)
            .Select(a => new { a.Id, a.Slug, a.TokenHash, a.RevokedAt })
            .SingleOrDefaultAsync(cancellationToken);

        // A busca pelo índice já casou o hash; a comparação em tempo constante é a confirmação final.
        if (agent is null || !DeviceSecrets.Matches(agent.TokenHash, hash))
        {
            return DeviceTokenValidation.Unknown;
        }

        // Revogado não entra no cache: a próxima tentativa volta ao banco e continua sendo recusada.
        if (agent.RevokedAt is not null)
        {
            return new DeviceTokenValidation(TokenCheck.Revoked, agent.Id, agent.Slug);
        }

        var valid = new DeviceTokenValidation(TokenCheck.Valid, agent.Id, agent.Slug);
        cache.Store(key, valid);
        return valid;
    }
}
