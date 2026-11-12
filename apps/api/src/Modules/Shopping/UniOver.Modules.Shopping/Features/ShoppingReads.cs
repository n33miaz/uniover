using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>As leituras. Todas partem do grupo de quem chama (<see cref="ShoppingGroupService"/>) e filtram por ele.</summary>
internal static class ShoppingReads
{
    public const int DefaultChangesLimit = 200;
    public const int MaxChangesLimit = 500;
    private const int PurchasesPage = 100;

    public static void MapShoppingReads(this IEndpointRouteBuilder group)
    {
        group.MapGet("/group", GroupAsync).Read().Produces<GroupResponse>();
        group.MapGet("/group/members", MembersAsync).Read().Produces<IReadOnlyList<MemberResponse>>();
        group.MapGet("/group/people", PeopleAsync).Read().Produces<IReadOnlyList<PersonResponse>>();
        group.MapGet("/changes", ChangesAsync).Read().Produces<ChangesResponse>().ProducesProblem(StatusCodes.Status400BadRequest);
        group.MapGet("/purchases", PurchasesAsync).Read().Produces<IReadOnlyList<PurchaseSummaryResponse>>();
        group.MapGet("/products/{id:guid}/last-price", LastPriceAsync).Read().Produces<LastPriceResponse>().Produces(StatusCodes.Status204NoContent);
    }

    private static RouteHandlerBuilder Read(this RouteHandlerBuilder builder) =>
        builder
            .RequireAuthorization(ShoppingAuth.Module)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> GroupAsync(ICurrentUser current, ShoppingGroupService groups, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var member = await groups.GetForUserAsync(userId, cancellationToken);
        return TypedResults.Ok(new GroupResponse(member.GroupId, member.Group!.OwnerUserId, member.IsOwner));
    }

    private static async Task<IResult> MembersAsync(
        ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        var members = await db.Members.AsNoTracking()
            .Where(x => x.GroupId == groupId)
            .OrderBy(x => x.CreatedAt)
            .ThenBy(x => x.UserId)
            .ToListAsync(cancellationToken);
        return TypedResults.Ok(members.Select(x => x.ToResponse()).ToList());
    }

    /// <summary>
    /// As pessoas do grupo, pelo nome, para a tela de pessoas. Quem criou o grupo recebe também quem pode ser incluído
    /// (contas com a permissão do módulo que não estão neste grupo); os demais só veem quem já participa.
    /// </summary>
    private static async Task<IResult> PeopleAsync(
        ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, IAccountDirectory accounts, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var self = await groups.GetForUserAsync(userId, cancellationToken);
        var members = await db.Members.AsNoTracking()
            .Where(x => x.GroupId == self.GroupId && x.DeletedAt == null)
            .OrderBy(x => x.CreatedAt)
            .ThenBy(x => x.UserId)
            .Select(x => new { x.UserId, x.IsOwner })
            .ToListAsync(cancellationToken);

        var ids = members.Select(x => x.UserId).ToList();
        var names = (await accounts.NamesAsync(ids, cancellationToken)).ToDictionary(x => x.UserId, x => x.DisplayName);
        var people = members
            .Select(x => new PersonResponse(x.UserId, names.GetValueOrDefault(x.UserId, string.Empty), x.IsOwner, true))
            .ToList();

        if (self.IsOwner)
        {
            var inGroup = ids.ToHashSet();
            var candidates = await accounts.WithPermissionAsync(AccessPermissions.ShoppingModule, cancellationToken);
            people.AddRange(candidates
                .Where(x => !inGroup.Contains(x.UserId))
                .Select(x => new PersonResponse(x.UserId, x.DisplayName, false, false)));
        }

        return TypedResults.Ok((IReadOnlyList<PersonResponse>)people);
    }

    /// <summary>
    /// As mudanças do grupo depois do cursor, na ordem do servidor. Começar de <c>after=0</c> devolve o estado inteiro
    /// (lápides inclusive): é assim que um aparelho novo, ou alguém que acabou de entrar no grupo, se põe em dia.
    /// </summary>
    private static async Task<IResult> ChangesAsync(
        ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, long? after, int? limit, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var cursor = after ?? 0;
        if (cursor < 0)
        {
            return ShoppingProblems.Invalid("after", "O cursor não é válido.");
        }

        var take = limit ?? DefaultChangesLimit;
        if (take is < 1 or > MaxChangesLimit)
        {
            return ShoppingProblems.Invalid("limit", $"O limite deve ficar entre 1 e {MaxChangesLimit}.");
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        var rows = await db.Changes.AsNoTracking()
            .Where(x => x.GroupId == groupId && x.Sequence > cursor)
            .OrderBy(x => x.Sequence)
            .Take(take + 1)
            .ToListAsync(cancellationToken);

        var hasMore = rows.Count > take;
        var items = new List<ChangeResponse>(Math.Min(rows.Count, take));
        foreach (var row in rows.Take(take))
        {
            using var payload = JsonDocument.Parse(row.Payload);
            items.Add(new ChangeResponse(row.Sequence, row.OperationId, row.EntityType, row.EntityId, payload.RootElement.Clone(), row.OccurredAt));
        }

        return TypedResults.Ok(new ChangesResponse(groupId, items, items.Count == 0 ? cursor : items[^1].Sequence, hasMore));
    }

    /// <summary>As compras do grupo, das mais recentes para as antigas; <c>closed=true</c> é o histórico.</summary>
    private static async Task<IResult> PurchasesAsync(
        ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, bool? closed, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        var query = db.Purchases.AsNoTracking().Where(x => x.GroupId == groupId && x.DeletedAt == null);
        if (closed is { } onlyClosed)
        {
            var status = onlyClosed ? ShoppingPurchase.Closed : ShoppingPurchase.Open;
            query = query.Where(x => x.Status == status);
        }

        var purchases = await query.OrderByDescending(x => x.ClosedAt ?? x.StartedAt).ThenByDescending(x => x.Id).Take(PurchasesPage).ToListAsync(cancellationToken);
        var ids = purchases.Select(x => x.Id).ToList();
        var totals = await db.PurchaseItems.AsNoTracking()
            .Where(x => ids.Contains(x.PurchaseId) && x.DeletedAt == null && x.Picked && x.UnitPrice != null)
            .GroupBy(x => x.PurchaseId)
            .Select(g => new { PurchaseId = g.Key, Total = g.Sum(x => x.Quantity * x.UnitPrice!.Value) })
            .ToDictionaryAsync(x => x.PurchaseId, x => x.Total, cancellationToken);

        return TypedResults.Ok(purchases
            .Select(x => new PurchaseSummaryResponse(x.ToResponse(), decimal.Round(totals.GetValueOrDefault(x.Id), 2)))
            .ToList());
    }

    /// <summary>"Da última vez": o preço mais recente pago por este produto numa compra fechada do grupo.</summary>
    private static async Task<IResult> LastPriceAsync(
        Guid id, ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var groupId = (await groups.GetForUserAsync(userId, cancellationToken)).GroupId;
        var last = await (
            from item in db.PurchaseItems.AsNoTracking()
            join purchase in db.Purchases.AsNoTracking() on item.PurchaseId equals purchase.Id
            where purchase.GroupId == groupId
                && purchase.Status == ShoppingPurchase.Closed
                && purchase.DeletedAt == null
                && purchase.ClosedAt != null
                && item.ProductId == id
                && item.DeletedAt == null
                && item.Picked
                && item.UnitPrice != null
            orderby purchase.ClosedAt descending, item.UpdatedAt descending
            select new { UnitPrice = item.UnitPrice!.Value, purchase.Store, ClosedAt = purchase.ClosedAt!.Value })
            .FirstOrDefaultAsync(cancellationToken);

        return last is null
            ? TypedResults.NoContent()
            : TypedResults.Ok(new LastPriceResponse(last.UnitPrice, last.Store, last.ClosedAt));
    }
}
