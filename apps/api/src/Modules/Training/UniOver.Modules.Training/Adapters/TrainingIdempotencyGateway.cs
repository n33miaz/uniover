using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Adapters;

/// <summary>
/// Ponte entre a porta do filtro HTTP de idempotência (<c>BuildingBlocks.Web</c>, sem EF) e a loja em Postgres
/// (<c>BuildingBlocks.Persistence</c>): os dois projetos ainda não se referenciam. Some quando o Web puder referenciar o
/// Persistence e a ponte genérica passar a existir nos BuildingBlocks.
/// </summary>
internal sealed class TrainingIdempotencyGateway(IIdempotencyStore<TrainingDbContext> store) : IIdempotencyGateway<TrainingDbContext>
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
        var existing = result.Existing is { } r
            ? new IdempotencyGatewayEntry(r.Method, r.Route, r.RequestHash, r.StatusCode, r.ResponseBody, r.ContentType, r.Location)
            : null;
        return new IdempotencyGatewayResult(outcome, existing, result.LeaseId);
    }

    public Task CompleteAsync(
        Guid userId, Guid key, Guid leaseId, int statusCode, string? responseBody, string? contentType, string? location, CancellationToken cancellationToken) =>
        store.CompleteAsync(userId, key, leaseId, statusCode, responseBody, contentType, location, cancellationToken);

    public Task ReleaseAsync(Guid userId, Guid key, Guid leaseId, CancellationToken cancellationToken) =>
        store.ReleaseAsync(userId, key, leaseId, cancellationToken);
}
