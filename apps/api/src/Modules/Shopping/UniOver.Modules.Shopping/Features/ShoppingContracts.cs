using System.Text.Json;
using UniOver.Modules.Shopping.Domain;

namespace UniOver.Modules.Shopping.Features;

// Toda escrita leva `operationId`: o UUID que o aparelho deu àquela mutação. Reenviar a mesma operação não a aplica de novo.

internal sealed record MemberRequest(Guid OperationId, bool Deleted = false);

internal sealed record ProductRequest(Guid OperationId, string? Name, string? Section, string? Unit, string? Size, bool Deleted = false);

internal sealed record ListItemRequest(Guid OperationId, Guid ProductId, decimal Quantity, string? Note, bool Needed, bool Deleted = false);

internal sealed record OpenPurchaseRequest(Guid OperationId, decimal? Budget);

internal sealed record PurchaseItemRequest(Guid OperationId, Guid ProductId, decimal Quantity, decimal? UnitPrice, bool Picked, bool Deleted = false);

internal sealed record BudgetRequest(Guid OperationId, decimal? Budget);

internal sealed record ClosePurchaseRequest(Guid OperationId, decimal TotalPaid, string? Store, string? ReceiptKey);

internal sealed record GroupResponse(Guid Id, Guid OwnerUserId, bool IsOwner);

internal sealed record MemberResponse(Guid UserId, bool IsOwner, bool Deleted, DateTimeOffset CreatedAt);

internal sealed record ProductResponse(Guid Id, string Name, string Section, string? Unit, string? Size, bool Deleted, DateTimeOffset UpdatedAt);

internal sealed record ListItemResponse(Guid Id, Guid ProductId, decimal Quantity, string? Note, bool Needed, bool Deleted, DateTimeOffset UpdatedAt);

internal sealed record PurchaseResponse(
    Guid Id,
    string Status,
    decimal? Budget,
    decimal? TotalPaid,
    string? Store,
    string? ReceiptKey,
    DateTimeOffset StartedAt,
    DateTimeOffset? ClosedAt,
    bool Deleted,
    DateTimeOffset UpdatedAt);

internal sealed record PurchaseItemResponse(
    Guid Id, Guid PurchaseId, Guid ProductId, decimal Quantity, decimal? UnitPrice, bool Picked, bool Deleted, DateTimeOffset UpdatedAt);

/// <summary>Uma compra na listagem, com o total corrente (a soma do que já foi pego e tem preço).</summary>
internal sealed record PurchaseSummaryResponse(PurchaseResponse Purchase, decimal PickedTotal);

internal sealed record LastPriceResponse(decimal UnitPrice, string? Store, DateTimeOffset PaidAt);

/// <param name="EntityType">Uma de <see cref="ChangeTypes"/>; diz a forma de <paramref name="Payload"/> (a resposta daquela entidade).</param>
internal sealed record ChangeResponse(long Sequence, Guid OperationId, string EntityType, Guid EntityId, JsonElement Payload, DateTimeOffset OccurredAt);

/// <param name="GroupId">O grupo do feed. Se mudar entre duas leituras, a pessoa trocou de grupo: o cliente recomeça do zero.</param>
/// <param name="NextCursor">O valor de <c>after</c> da próxima leitura.</param>
internal sealed record ChangesResponse(Guid GroupId, IReadOnlyList<ChangeResponse> Items, long NextCursor, bool HasMore);

internal static class ChangeTypes
{
    public const string Member = "member";
    public const string Product = "product";
    public const string ListItem = "listItem";
    public const string Purchase = "purchase";
    public const string PurchaseItem = "purchaseItem";
}

internal static class ShoppingMapping
{
    public static MemberResponse ToResponse(this ShoppingMember value) =>
        new(value.UserId, value.IsOwner, value.DeletedAt is not null, value.CreatedAt);

    public static ProductResponse ToResponse(this Product value) =>
        new(value.Id, value.Name, value.Section, value.Unit, value.Size, value.DeletedAt is not null, value.UpdatedAt);

    public static ListItemResponse ToResponse(this ShoppingListItem value) =>
        new(value.Id, value.ProductId, value.Quantity, value.Note, value.Needed, value.DeletedAt is not null, value.UpdatedAt);

    public static PurchaseResponse ToResponse(this ShoppingPurchase value) =>
        new(
            value.Id,
            value.Status,
            value.Budget,
            value.TotalPaid,
            value.Store,
            value.ReceiptKey,
            value.StartedAt,
            value.ClosedAt,
            value.DeletedAt is not null,
            value.UpdatedAt);

    public static PurchaseItemResponse ToResponse(this PurchaseItem value) =>
        new(value.Id, value.PurchaseId, value.ProductId, value.Quantity, value.UnitPrice, value.Picked, value.DeletedAt is not null, value.UpdatedAt);
}
