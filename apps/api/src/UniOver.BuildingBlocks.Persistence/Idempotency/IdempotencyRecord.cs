namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// Uma chave de idempotência já vista pelo módulo. Mora em <c>&lt;schema&gt;.idempotency_keys</c> (cada módulo tem a
/// sua), com chave primária (<see cref="UserId"/>, <see cref="Key"/>): o mesmo UUID de dois usuários não colide.
/// <see cref="CompletedAt"/> nulo significa "em andamento".
/// </summary>
public sealed class IdempotencyRecord
{
    public Guid Key { get; set; }

    public Guid UserId { get; set; }

    public string Method { get; set; } = string.Empty;

    public string Route { get; set; } = string.Empty;

    /// <summary>SHA-256 do corpo da requisição: prova que o reenvio é o mesmo pedido.</summary>
    public byte[] RequestHash { get; set; } = [];

    public int? StatusCode { get; set; }

    /// <summary>Corpo da resposta (até 32 KB). Nulo quando a resposta era vazia ou passou do limite.</summary>
    public string? ResponseBody { get; set; }

    public string? ContentType { get; set; }

    public string? Location { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? CompletedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
}
