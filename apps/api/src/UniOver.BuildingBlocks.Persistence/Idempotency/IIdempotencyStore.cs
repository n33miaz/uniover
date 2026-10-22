namespace UniOver.BuildingBlocks.Persistence;

public enum IdempotencyBeginOutcome
{
    /// <summary>Chave nova (ou "em andamento" vencido): o chamador executa e depois conclui ou libera.</summary>
    Started,

    /// <summary>Já concluída: <see cref="IdempotencyBeginResult.Existing"/> traz a resposta guardada.</summary>
    Completed,

    /// <summary>Outro envio com a mesma chave está executando agora.</summary>
    InProgress,
}

public sealed record IdempotencyBeginResult(IdempotencyBeginOutcome Outcome, IdempotencyRecord? Existing, Guid? LeaseId = null);

/// <summary>Registro das chaves de idempotência de um módulo.</summary>
public interface IIdempotencyStore
{
    /// <summary>
    /// Insere a chave como "em andamento". Violação de unicidade (chave já existe) devolve o registro existente em
    /// vez de lançar. Apaga, de passagem, as chaves vencidas (limpeza oportunista: não há tarefa periódica, para o
    /// banco poder dormir).
    /// </summary>
    Task<IdempotencyBeginResult> TryBeginAsync(
        Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken);

    /// <summary>Guarda a resposta e marca a chave como concluída.</summary>
    Task CompleteAsync(
        Guid userId, Guid key, Guid leaseId, int statusCode, string? responseBody, string? contentType, string? location, CancellationToken cancellationToken);

    /// <summary>Apaga uma chave ainda "em andamento" (o envio falhou de forma que o reenvio deve executar de novo).</summary>
    Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken);
}

/// <summary>A mesma loja, amarrada ao <see cref="ModuleDbContext"/> de um módulo (é o que o DI entrega).</summary>
public interface IIdempotencyStore<TContext> : IIdempotencyStore
    where TContext : ModuleDbContext;
