namespace UniOver.Modules.Shopping.Domain;

/// <summary>O grupo de compras: tudo o mais pertence a um grupo. Contas entram só como UUID.</summary>
public sealed class ShoppingGroup
{
    public Guid Id { get; set; }
    public Guid OwnerUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>Uma pessoa num grupo. Sair é lápide; uma pessoa tem no máximo uma participação ativa.</summary>
public sealed class ShoppingMember
{
    public Guid GroupId { get; set; }
    public Guid UserId { get; set; }
    public bool IsOwner { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public ShoppingGroup? Group { get; set; }
}

public sealed class Product
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string NormalizedName { get; set; } = string.Empty;
    public string Section { get; set; } = string.Empty;
    public string? Unit { get; set; }
    public string? Size { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>Um item da lista permanente da casa.</summary>
public sealed class ShoppingListItem
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public Guid ProductId { get; set; }
    public decimal Quantity { get; set; }
    public string? Note { get; set; }
    public bool Needed { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>Uma ida ao mercado. Fechada, guarda o total pago, a loja, a data e (opcional) a chave da nota.</summary>
public sealed class ShoppingPurchase
{
    public const string Open = "open";
    public const string Closed = "closed";

    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public string Status { get; set; } = Open;
    public decimal? Budget { get; set; }
    public decimal? TotalPaid { get; set; }
    public string? Store { get; set; }
    public string? ReceiptKey { get; set; }
    /// <summary>O id da compra no Economize, quando ela veio de lá; nulo para as compras feitas aqui.</summary>
    public string? ExternalRef { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

public sealed class PurchaseItem
{
    public Guid Id { get; set; }
    public Guid PurchaseId { get; set; }
    public Guid ProductId { get; set; }
    public decimal Quantity { get; set; }
    public decimal? UnitPrice { get; set; }
    public bool Picked { get; set; }

    /// <summary>Quando o preço foi informado (o relógio do aparelho, nunca à frente do servidor). Entre dois preços, vale o mais recente.</summary>
    public DateTimeOffset? PricedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>
/// Um id criado num aparelho sem sinal para algo que o grupo já tinha (o mesmo produto, o mesmo item da lista, a mesma
/// linha da compra). O registro foi juntado ao que existia; quem ainda usa o id antigo é levado ao que vale.
/// </summary>
public sealed class ShoppingMergedId
{
    public Guid GroupId { get; set; }

    /// <summary>De que espécie é o registro (produto, item da lista, linha da compra): um id juntado só vale na própria.</summary>
    public string EntityType { get; set; } = string.Empty;
    public Guid MergedId { get; set; }
    public Guid CanonicalId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Uma operação do cliente já aplicada (o UUID vem do aparelho). É o que torna o reenvio inofensivo e, com
/// <see cref="ShoppingChange"/>, a trilha de quem alterou qual registro e quando.
/// </summary>
public sealed class ShoppingOperation
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public Guid ActorUserId { get; set; }
    public DateTimeOffset AppliedAt { get; set; }
}

/// <summary>Uma linha do feed do grupo. A sequência é dada pelo servidor, na ordem em que as escritas do grupo assentam.</summary>
public sealed class ShoppingChange
{
    public long Sequence { get; set; }
    public Guid GroupId { get; set; }
    public Guid OperationId { get; set; }
    public string EntityType { get; set; } = string.Empty;
    public Guid EntityId { get; set; }
    public string Payload { get; set; } = string.Empty;
    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>Trilha administrativa: só a entrada ou saída de uma pessoa, nunca os toques da lista ou do mercado.</summary>
public sealed class ShoppingMemberAuditEntry
{
    public Guid Id { get; set; }
    public string Event { get; set; } = string.Empty;
    public Guid ActorUserId { get; set; }
    public Guid TargetUserId { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}
