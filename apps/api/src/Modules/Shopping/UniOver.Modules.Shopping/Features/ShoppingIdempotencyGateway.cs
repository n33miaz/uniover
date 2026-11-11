using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

internal sealed class ShoppingIdempotencyGateway(IIdempotencyStore<ShoppingDbContext> store) : IIdempotencyGateway<ShoppingDbContext>
{
    public async Task<IdempotencyGatewayResult> TryBeginAsync(Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken)
    {
        var result = await store.TryBeginAsync(userId, key, method, route, requestHash, cancellationToken);
        var outcome = result.Outcome switch { IdempotencyBeginOutcome.Started => IdempotencyGatewayOutcome.Started, IdempotencyBeginOutcome.Completed => IdempotencyGatewayOutcome.Completed, _ => IdempotencyGatewayOutcome.InProgress };
        var existing = result.Existing is { } row ? new IdempotencyGatewayEntry(row.Method, row.Route, row.RequestHash, row.StatusCode, row.ResponseBody, row.ContentType, row.Location) : null;
        return new IdempotencyGatewayResult(outcome, existing, result.LeaseId);
    }

    public Task CompleteAsync(Guid userId, Guid key, Guid leaseId, int statusCode, string? body, string? contentType, string? location, CancellationToken cancellationToken) => store.CompleteAsync(userId, key, leaseId, statusCode, body, contentType, location, cancellationToken);
    public Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken) => store.ReleaseAsync(userId, key, leaseId, cancellationToken);
}
