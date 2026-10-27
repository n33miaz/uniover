using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Adapters;

/// <summary>
/// Ponte entre a porta do filtro HTTP de idempotência (sem EF) e a loja no schema dos aparelhos.
/// </summary>
internal sealed class DevicesIdempotencyGateway(IIdempotencyStore<DevicesDbContext> store) : IIdempotencyGateway<DevicesDbContext>
{
    public async Task<IdempotencyGatewayResult> TryBeginAsync(
        Guid userId, Guid key, string method, string route, byte[] requestHash, CancellationToken cancellationToken)
    {
        var result = await store.TryBeginAsync(userId, key, method, route, requestHash, cancellationToken);
        var outcome = result.Outcome switch
        {
            IdempotencyBeginOutcome.Started => IdempotencyGatewayOutcome.Started,
            IdempotencyBeginOutcome.Completed => IdempotencyGatewayOutcome.Completed,
            _ => IdempotencyGatewayOutcome.InProgress,
        };
        var existing = result.Existing is { } record
            ? new IdempotencyGatewayEntry(record.Method, record.Route, record.RequestHash, record.StatusCode,
                record.ResponseBody, record.ContentType, record.Location)
            : null;
        return new IdempotencyGatewayResult(outcome, existing, result.LeaseId);
    }

    public Task CompleteAsync(
        Guid userId, Guid key, Guid leaseId, int statusCode, string? responseBody, string? contentType, string? location,
        CancellationToken cancellationToken) =>
        store.CompleteAsync(userId, key, leaseId, statusCode, responseBody, contentType, location, cancellationToken);

    public Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken) =>
        store.ReleaseAsync(userId, key, leaseId, cancellationToken);
}
