namespace UniOver.BuildingBlocks.Web;

/// <summary>Resultado de abrir uma chave de idempotência (ver <see cref="IIdempotencyGateway{TContext}"/>).</summary>
public enum IdempotencyGatewayOutcome
{
    /// <summary>Chave nova: executar o endpoint e depois concluir ou liberar.</summary>
    Started,

    /// <summary>Chave já concluída: <see cref="IdempotencyGatewayResult.Existing"/> traz a resposta guardada.</summary>
    Completed,

    /// <summary>Outro envio com a mesma chave está executando agora.</summary>
    InProgress,
}

/// <summary>Registro anterior de uma chave: o que foi pedido e, se concluída, a resposta guardada.</summary>
public sealed record IdempotencyGatewayEntry(
    string Method,
    string Route,
    byte[] RequestHash,
    int? StatusCode,
    string? ResponseBody,
    string? ContentType,
    string? Location);

public sealed record IdempotencyGatewayResult(IdempotencyGatewayOutcome Outcome, IdempotencyGatewayEntry? Existing, Guid? LeaseId = null);

/// <summary>
/// Porta que o filtro HTTP de idempotência usa para guardar as chaves, sem conhecer EF Core. O adaptador é a loja
/// de <c>BuildingBlocks.Persistence</c> (<c>IIdempotencyStore&lt;TContext&gt;</c>); o <typeparamref name="TContext"/>
/// só identifica de qual módulo (de qual schema) são as chaves.
/// </summary>
public interface IIdempotencyGateway<TContext>
{
    Task<IdempotencyGatewayResult> TryBeginAsync(
        Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken);

    Task CompleteAsync(
        Guid userId, Guid key, Guid leaseId, int statusCode, string? responseBody, string? contentType, string? location, CancellationToken cancellationToken);

    Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken);
}
