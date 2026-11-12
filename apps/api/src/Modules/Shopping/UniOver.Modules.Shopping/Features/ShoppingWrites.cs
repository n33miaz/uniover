using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Audit;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>
/// As escritas: cada uma é uma operação pequena, com o id do registro gerado no aparelho. Todas passam por
/// <see cref="ShoppingWriter"/>, que dá o grupo de quem chama; cada consulta filtra por ele, então o id de um registro de
/// outro grupo nunca é lido nem alterado (responde 404 ou 409 sem revelar nada).
/// </summary>
internal static class ShoppingWrites
{
    private static readonly JsonSerializerOptions OperationJson = new(JsonSerializerDefaults.Web);

    public static void MapShoppingWrites(this IEndpointRouteBuilder group)
    {
        group.MapPut("/group/members/{userId:guid}", PutMemberAsync).Write<MemberResponse>();
        group.MapPost("/group/leave", LeaveGroupAsync).Write<GroupResponse>();
        group.MapPut("/products/{id:guid}", PutProductAsync).Write<ProductResponse>();
        group.MapPut("/list-items/{id:guid}", PutListItemAsync).Write<ListItemResponse>();
        group.MapPost("/purchases/{id:guid}/open", OpenPurchaseAsync).Write<PurchaseResponse>();
        group.MapPut("/purchases/{id:guid}/budget", PutBudgetAsync).Write<PurchaseResponse>();
        group.MapPost("/purchases/{id:guid}/close", ClosePurchaseAsync).Write<PurchaseResponse>();
        group.MapPut("/purchases/{purchaseId:guid}/items/{id:guid}", PutPurchaseItemAsync).Write<PurchaseItemResponse>();
        group.MapPost("/operations", OperationsAsync)
            .RequireAuthorization(ShoppingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<IReadOnlyList<ShoppingOperationResult>>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    private static void Write<TResponse>(this RouteHandlerBuilder builder) =>
        builder
            .RequireAuthorization(ShoppingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<ShoppingDbContext>();

    private static IResult MissingBody() => ShoppingProblems.Invalid("body", "O corpo é obrigatório.");

    private static WriteStep Reject(IResult result) => WriteStep.Rejected(result);

    /// <summary>
    /// Quem entrou como membro pode sair. A conta recebe de imediato outro grupo vazio, sem depender da próxima leitura.
    /// </summary>
    private static async Task<IResult> LeaveGroupAsync(
        MemberRequest? request,
        ICurrentUser current,
        ShoppingWriter writer,
        ShoppingGroupService groups,
        ShoppingDbContext db,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        // O reenvio chega depois de a pessoa já estar no grupo novo, e a operação ficou anotada no antigo: o escritor a
        // tomaria por operação de outro grupo. Por isso a operação já aplicada por esta conta é respondida aqui.
        if (await db.Operations.AsNoTracking().AnyAsync(x => x.Id == request.OperationId && x.ActorUserId == actor, cancellationToken))
        {
            var now = await groups.GetForUserAsync(actor, cancellationToken);
            return TypedResults.Ok(new GroupResponse(now.GroupId, now.Group!.OwnerUserId, now.IsOwner));
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, ReplayAsync, cancellationToken);

        Task<IResult> ReplayAsync(Guid groupId, CancellationToken _) =>
            Task.FromResult<IResult>(TypedResults.Ok(new GroupResponse(groupId, actor, true)));

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            if (scope.IsOwner)
            {
                return Reject(ShoppingProblems.Invalid("group", "Quem criou o grupo não pode sair dele."));
            }

            var member = await db.Members.SingleAsync(x => x.GroupId == scope.GroupId && x.UserId == actor && x.DeletedAt == null, ct);
            var own = await MoveToOwnGroupAsync(db, scope, member, ct);
            return WriteStep.Done(TypedResults.Ok(new GroupResponse(own.Id, actor, true)));
        }
    }

    /// <summary>
    /// Tira a pessoa do grupo e lhe dá, na mesma transação, um grupo só dela, vazio. Assim uma escrita offline que chegar
    /// depois não recria a participação no grupo antigo nem fica sem destino. A lápide é gravada antes da participação
    /// nova: as duas têm a mesma conta, e só uma participação viva por conta é aceita.
    /// </summary>
    private static async Task<ShoppingGroup> MoveToOwnGroupAsync(ShoppingDbContext db, ShoppingScope scope, ShoppingMember member, CancellationToken ct)
    {
        member.DeletedAt = scope.Now;
        scope.Change(ChangeTypes.Member, member.UserId, member.ToResponse());
        db.MemberAudit.Add(new ShoppingMemberAuditEntry
        {
            Id = Guid.CreateVersion7(),
            Event = ShoppingAuditEvents.MemberRemoved,
            ActorUserId = scope.ActorId,
            TargetUserId = member.UserId,
            OccurredAt = scope.Now,
        });
        await db.SaveChangesAsync(ct);

        var own = new ShoppingGroup { Id = Guid.CreateVersion7(), OwnerUserId = member.UserId, CreatedAt = scope.Now };
        db.Groups.Add(own);
        db.Members.Add(new ShoppingMember { GroupId = own.Id, UserId = member.UserId, IsOwner = true, CreatedAt = scope.Now });
        return own;
    }

    /// <summary>
    /// Só quem criou o grupo inclui ou remove pessoas. Quem entra precisa ter a permissão do módulo. Quem já abriu o
    /// módulo tem um grupo próprio: se esse grupo está vazio (só a pessoa, nenhum produto nem compra), ela o deixa e
    /// entra neste; se tem conteúdo ou outras pessoas, a inclusão é recusada, para ninguém perder a lista sem saber.
    /// </summary>
    private static async Task<IResult> PutMemberAsync(
        Guid userId,
        MemberRequest? request,
        ICurrentUser current,
        ShoppingWriter writer,
        ShoppingDbContext db,
        IAccessGrants grants,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, ReplayAsync, cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            if (!scope.IsOwner)
            {
                return Reject(ShoppingProblems.OwnerOnly());
            }

            var member = await db.Members.SingleOrDefaultAsync(x => x.GroupId == scope.GroupId && x.UserId == userId, ct);
            if (request.Deleted)
            {
                if (member is null)
                {
                    return Reject(ShoppingProblems.NotFound());
                }

                if (member.IsOwner)
                {
                    return Reject(ShoppingProblems.Invalid("userId", "Quem criou o grupo não pode ser removido dele."));
                }

                if (member.DeletedAt is null)
                {
                    await MoveToOwnGroupAsync(db, scope, member, ct);
                }

                return WriteStep.Done(TypedResults.Ok(member.ToResponse()));
            }

            if (member is { DeletedAt: null })
            {
                return WriteStep.Done(TypedResults.Ok(member.ToResponse()));
            }

            if (!await grants.HasAsync(userId, AccessPermissions.ShoppingModule, ct))
            {
                return Reject(ShoppingProblems.Invalid("userId", "A conta não existe ou não tem a permissão do módulo Compras."));
            }

            var elsewhere = await db.Members.SingleOrDefaultAsync(x => x.UserId == userId && x.DeletedAt == null, ct);
            if (elsewhere is not null)
            {
                if (!await LeaveEmptyGroupAsync(db, elsewhere, scope.Now, ct))
                {
                    return Reject(ShoppingProblems.MemberElsewhere());
                }
            }

            if (member is null)
            {
                member = new ShoppingMember { GroupId = scope.GroupId, UserId = userId, CreatedAt = scope.Now };
                db.Members.Add(member);
            }
            else
            {
                member.DeletedAt = null;
            }

            scope.Change(ChangeTypes.Member, userId, member.ToResponse());
            db.MemberAudit.Add(new ShoppingMemberAuditEntry
            {
                Id = Guid.CreateVersion7(),
                Event = ShoppingAuditEvents.MemberAdded,
                ActorUserId = scope.ActorId,
                TargetUserId = userId,
                OccurredAt = scope.Now,
            });
            return WriteStep.Done(TypedResults.Ok(member.ToResponse()));
        }

        async Task<IResult> ReplayAsync(Guid groupId, CancellationToken ct) =>
            await db.Members.AsNoTracking().SingleOrDefaultAsync(x => x.GroupId == groupId && x.UserId == userId, ct) is { } member
                ? TypedResults.Ok(member.ToResponse())
                : ShoppingProblems.NotFound();
    }

    /// <summary>
    /// Tira a pessoa do grupo próprio dela, se ele estiver vazio. O grupo é travado antes de ser conferido, para um
    /// produto criado no mesmo instante não ficar para trás. Devolve falso se o grupo tem conteúdo ou outras pessoas.
    /// </summary>
    private static async Task<bool> LeaveEmptyGroupAsync(ShoppingDbContext db, ShoppingMember membership, DateTimeOffset now, CancellationToken ct)
    {
        var groupId = membership.GroupId;
        await db.Database.ExecuteSqlAsync($"""SELECT 1 FROM "shopping"."groups" WHERE id = {groupId} FOR UPDATE""", ct);

        var empty = membership.IsOwner
            && !await db.Members.AnyAsync(x => x.GroupId == groupId && x.UserId != membership.UserId && x.DeletedAt == null, ct)
            && !await db.Products.AnyAsync(x => x.GroupId == groupId, ct)
            && !await db.Purchases.AnyAsync(x => x.GroupId == groupId, ct);
        if (!empty)
        {
            return false;
        }

        // Gravado já (dentro da transação): a participação nova não pode ser incluída antes de a antiga virar lápide.
        membership.DeletedAt = now;
        await db.SaveChangesAsync(ct);
        return true;
    }

    private static async Task<IResult> PutProductAsync(
        Guid id, ProductRequest? request, ICurrentUser current, ShoppingWriter writer, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        var name = ShoppingRules.Clean(request.Name);
        var section = ShoppingRules.Clean(request.Section) ?? string.Empty;
        var unit = ShoppingRules.Clean(request.Unit);
        var size = ShoppingRules.Clean(request.Size);
        if (!request.Deleted)
        {
            if (name is null)
            {
                return ShoppingProblems.Invalid("name", "O nome é obrigatório.");
            }

            if (!ShoppingRules.Fits(name, ShoppingLimits.Name))
            {
                return ShoppingProblems.Invalid("name", $"O nome aceita no máximo {ShoppingLimits.Name} caracteres.");
            }

            if (!ShoppingRules.Fits(section, ShoppingLimits.Section))
            {
                return ShoppingProblems.Invalid("section", $"A seção aceita no máximo {ShoppingLimits.Section} caracteres.");
            }

            if (!ShoppingRules.Fits(unit, ShoppingLimits.Unit))
            {
                return ShoppingProblems.Invalid("unit", $"A unidade aceita no máximo {ShoppingLimits.Unit} caracteres.");
            }

            if (!ShoppingRules.Fits(size, ShoppingLimits.Size))
            {
                return ShoppingProblems.Invalid("size", $"O tamanho aceita no máximo {ShoppingLimits.Size} caracteres.");
            }
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, ReplayAsync, cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            var product = await db.Products.SingleOrDefaultAsync(x => x.Id == id && x.GroupId == scope.GroupId, ct);
            if (request.Deleted)
            {
                if (product is null)
                {
                    return Reject(ShoppingProblems.NotFound());
                }

                // A lápide não mexe no conteúdo: só marca e avisa o feed.
                if (product.DeletedAt is null)
                {
                    product.DeletedAt = scope.Now;
                    product.UpdatedAt = scope.Now;
                    scope.Change(ChangeTypes.Product, id, product.ToResponse());
                }

                return WriteStep.Done(TypedResults.Ok(product.ToResponse()));
            }

            var normalized = ProductNames.Normalize(name!);
            if (await db.Products.AnyAsync(x => x.GroupId == scope.GroupId && x.NormalizedName == normalized && x.DeletedAt == null && x.Id != id, ct))
            {
                return Reject(ShoppingProblems.Duplicate("Já existe um produto com esse nome neste grupo."));
            }

            if (product is null)
            {
                product = new Product { Id = id, GroupId = scope.GroupId, CreatedAt = scope.Now };
                db.Products.Add(product);
            }

            product.Name = name!;
            product.NormalizedName = normalized;
            product.Section = section;
            product.Unit = unit;
            product.Size = size;
            product.DeletedAt = null;
            product.UpdatedAt = scope.Now;
            scope.Change(ChangeTypes.Product, id, product.ToResponse());
            return WriteStep.Done(TypedResults.Ok(product.ToResponse()));
        }

        async Task<IResult> ReplayAsync(Guid groupId, CancellationToken ct) =>
            await db.Products.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.GroupId == groupId, ct) is { } product
                ? TypedResults.Ok(product.ToResponse())
                : ShoppingProblems.NotFound();
    }

    private static async Task<IResult> PutListItemAsync(
        Guid id, ListItemRequest? request, ICurrentUser current, ShoppingWriter writer, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        var note = ShoppingRules.Clean(request.Note);
        if (!request.Deleted)
        {
            if (!ShoppingRules.IsQuantity(request.Quantity))
            {
                return ShoppingProblems.Invalid("quantity", "A quantidade deve ser maior que zero.");
            }

            if (!ShoppingRules.Fits(note, ShoppingLimits.Note))
            {
                return ShoppingProblems.Invalid("note", $"A observação aceita no máximo {ShoppingLimits.Note} caracteres.");
            }
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, ReplayAsync, cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            var item = await db.ListItems.SingleOrDefaultAsync(x => x.Id == id && x.GroupId == scope.GroupId, ct);
            if (request.Deleted)
            {
                if (item is null)
                {
                    return Reject(ShoppingProblems.NotFound());
                }

                if (item.DeletedAt is null)
                {
                    item.DeletedAt = scope.Now;
                    item.UpdatedAt = scope.Now;
                    scope.Change(ChangeTypes.ListItem, id, item.ToResponse());
                }

                return WriteStep.Done(TypedResults.Ok(item.ToResponse()));
            }

            if (!await db.Products.AnyAsync(x => x.Id == request.ProductId && x.GroupId == scope.GroupId && x.DeletedAt == null, ct))
            {
                return Reject(ShoppingProblems.Invalid("productId", "Produto não encontrado neste grupo."));
            }

            if (await db.ListItems.AnyAsync(x => x.GroupId == scope.GroupId && x.ProductId == request.ProductId && x.DeletedAt == null && x.Id != id, ct))
            {
                return Reject(ShoppingProblems.Duplicate("Este produto já está na lista."));
            }

            if (item is null)
            {
                item = new ShoppingListItem { Id = id, GroupId = scope.GroupId, CreatedAt = scope.Now };
                db.ListItems.Add(item);
            }

            item.ProductId = request.ProductId;
            item.Quantity = request.Quantity;
            item.Note = note;
            item.Needed = request.Needed;
            item.DeletedAt = null;
            item.UpdatedAt = scope.Now;
            scope.Change(ChangeTypes.ListItem, id, item.ToResponse());
            return WriteStep.Done(TypedResults.Ok(item.ToResponse()));
        }

        async Task<IResult> ReplayAsync(Guid groupId, CancellationToken ct) =>
            await db.ListItems.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.GroupId == groupId, ct) is { } item
                ? TypedResults.Ok(item.ToResponse())
                : ShoppingProblems.NotFound();
    }

    /// <summary>Abre a ida ao mercado a partir da lista: cada item marcado como "precisa" vira uma linha da compra.</summary>
    private static async Task<IResult> OpenPurchaseAsync(
        Guid id, OpenPurchaseRequest? request, ICurrentUser current, ShoppingWriter writer, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        if (!ShoppingRules.IsMoney(request.Budget))
        {
            return ShoppingProblems.Invalid("budget", "O teto não é um valor válido.");
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, (groupId, ct) => ReplayPurchaseAsync(db, id, groupId, ct), cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            var existing = await db.Purchases.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.GroupId == scope.GroupId, ct);
            if (existing is not null)
            {
                // Outra operação já abriu esta compra: nada a refazer, vale o que está lá.
                return WriteStep.Done(TypedResults.Ok(existing.ToResponse()));
            }

            // Uma compra aberta por grupo: o grupo está travado, então duas aberturas ao mesmo tempo não passam juntas.
            var open = await db.Purchases.AsNoTracking()
                .Where(x => x.GroupId == scope.GroupId && x.Status == ShoppingPurchase.Open && x.DeletedAt == null)
                .OrderBy(x => x.StartedAt)
                .FirstOrDefaultAsync(ct);
            if (open is not null)
            {
                return Reject(ShoppingProblems.PurchaseAlreadyOpen(open.Id));
            }

            var purchase = new ShoppingPurchase
            {
                Id = id,
                GroupId = scope.GroupId,
                Status = ShoppingPurchase.Open,
                Budget = request.Budget,
                StartedAt = scope.Now,
                UpdatedAt = scope.Now,
            };
            db.Purchases.Add(purchase);
            scope.Change(ChangeTypes.Purchase, id, purchase.ToResponse());

            var needed = await db.ListItems.AsNoTracking()
                .Where(x => x.GroupId == scope.GroupId && x.Needed && x.DeletedAt == null)
                .OrderBy(x => x.CreatedAt)
                .ToListAsync(ct);
            foreach (var listItem in needed)
            {
                var line = new PurchaseItem
                {
                    Id = Guid.CreateVersion7(),
                    PurchaseId = id,
                    ProductId = listItem.ProductId,
                    Quantity = listItem.Quantity,
                    CreatedAt = scope.Now,
                    UpdatedAt = scope.Now,
                };
                db.PurchaseItems.Add(line);
                scope.Change(ChangeTypes.PurchaseItem, line.Id, line.ToResponse());
            }

            return WriteStep.Done(TypedResults.Ok(purchase.ToResponse()));
        }
    }

    private static async Task<IResult> PutBudgetAsync(
        Guid id, BudgetRequest? request, ICurrentUser current, ShoppingWriter writer, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        if (!ShoppingRules.IsMoney(request.Budget))
        {
            return ShoppingProblems.Invalid("budget", "O teto não é um valor válido.");
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, (groupId, ct) => ReplayPurchaseAsync(db, id, groupId, ct), cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            var purchase = await db.Purchases.SingleOrDefaultAsync(x => x.Id == id && x.GroupId == scope.GroupId && x.DeletedAt == null, ct);
            if (purchase is null)
            {
                return Reject(ShoppingProblems.NotFound());
            }

            if (purchase.Status != ShoppingPurchase.Open)
            {
                return Reject(ShoppingProblems.PurchaseClosed());
            }

            purchase.Budget = request.Budget;
            purchase.UpdatedAt = scope.Now;
            scope.Change(ChangeTypes.Purchase, id, purchase.ToResponse());
            return WriteStep.Done(TypedResults.Ok(purchase.ToResponse()));
        }
    }

    /// <summary>Fecha a compra com o total pago e a loja. Fechar de novo não muda nada: vale o primeiro fechamento.</summary>
    private static async Task<IResult> ClosePurchaseAsync(
        Guid id, ClosePurchaseRequest? request, ICurrentUser current, ShoppingWriter writer, ShoppingDbContext db, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        var store = ShoppingRules.Clean(request.Store);
        var receiptKey = ShoppingRules.Clean(request.ReceiptKey);
        if (!ShoppingRules.IsMoney(request.TotalPaid))
        {
            return ShoppingProblems.Invalid("totalPaid", "O total pago não é um valor válido.");
        }

        if (!ShoppingRules.Fits(store, ShoppingLimits.Store))
        {
            return ShoppingProblems.Invalid("store", $"A loja aceita no máximo {ShoppingLimits.Store} caracteres.");
        }

        if (!ShoppingRules.Fits(receiptKey, ShoppingLimits.ReceiptKey))
        {
            return ShoppingProblems.Invalid("receiptKey", $"A chave da nota aceita no máximo {ShoppingLimits.ReceiptKey} caracteres.");
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, (groupId, ct) => ReplayPurchaseAsync(db, id, groupId, ct), cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            var purchase = await db.Purchases.SingleOrDefaultAsync(x => x.Id == id && x.GroupId == scope.GroupId && x.DeletedAt == null, ct);
            if (purchase is null)
            {
                return Reject(ShoppingProblems.NotFound());
            }

            if (purchase.Status == ShoppingPurchase.Open)
            {
                purchase.Status = ShoppingPurchase.Closed;
                purchase.TotalPaid = request.TotalPaid;
                purchase.Store = store;
                purchase.ReceiptKey = receiptKey;
                purchase.ClosedAt = scope.Now;
                purchase.UpdatedAt = scope.Now;
                scope.Change(ChangeTypes.Purchase, id, purchase.ToResponse());

                // A lista da casa continua existindo, mas o que foi pego deixa de estar pendente nela.
                var pickedProducts = await db.PurchaseItems
                    .Where(x => x.PurchaseId == id && x.Picked && x.DeletedAt == null)
                    .Select(x => x.ProductId)
                    .Distinct()
                    .ToListAsync(ct);
                if (pickedProducts.Count != 0)
                {
                    var listItems = await db.ListItems
                        .Where(x => x.GroupId == scope.GroupId && x.Needed && x.DeletedAt == null && pickedProducts.Contains(x.ProductId))
                        .ToListAsync(ct);
                    foreach (var listItem in listItems)
                    {
                        listItem.Needed = false;
                        listItem.UpdatedAt = scope.Now;
                        scope.Change(ChangeTypes.ListItem, listItem.Id, listItem.ToResponse());
                    }
                }
            }

            return WriteStep.Done(TypedResults.Ok(purchase.ToResponse()));
        }
    }

    /// <summary>"Peguei": inclui ou altera uma linha da compra aberta (quantidade, preço opcional, pego ou não).</summary>
    private static async Task<IResult> PutPurchaseItemAsync(
        Guid purchaseId,
        Guid id,
        PurchaseItemRequest? request,
        ICurrentUser current,
        ShoppingWriter writer,
        ShoppingDbContext db,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request is null)
        {
            return MissingBody();
        }

        if (!request.Deleted)
        {
            if (!ShoppingRules.IsQuantity(request.Quantity))
            {
                return ShoppingProblems.Invalid("quantity", "A quantidade deve ser maior que zero.");
            }

            if (!ShoppingRules.IsMoney(request.UnitPrice))
            {
                return ShoppingProblems.Invalid("unitPrice", "O preço não é um valor válido.");
            }
        }

        return await writer.RunAsync(actor, request.OperationId, ApplyAsync, ReplayAsync, cancellationToken);

        async Task<WriteStep> ApplyAsync(ShoppingScope scope, CancellationToken ct)
        {
            // A compra é procurada dentro do grupo; a linha, dentro da compra. É o que impede alcançar a linha de outro grupo.
            var purchase = await db.Purchases.SingleOrDefaultAsync(x => x.Id == purchaseId && x.GroupId == scope.GroupId && x.DeletedAt == null, ct);
            if (purchase is null)
            {
                return Reject(ShoppingProblems.NotFound());
            }

            if (purchase.Status != ShoppingPurchase.Open)
            {
                return Reject(ShoppingProblems.PurchaseClosed());
            }

            var item = await db.PurchaseItems.SingleOrDefaultAsync(x => x.Id == id && x.PurchaseId == purchaseId, ct);
            if (request.Deleted)
            {
                if (item is null)
                {
                    return Reject(ShoppingProblems.NotFound());
                }

                if (item.DeletedAt is null)
                {
                    item.DeletedAt = scope.Now;
                    item.UpdatedAt = scope.Now;
                    scope.Change(ChangeTypes.PurchaseItem, id, item.ToResponse());
                }

                return WriteStep.Done(TypedResults.Ok(item.ToResponse()));
            }

            if (!await db.Products.AnyAsync(x => x.Id == request.ProductId && x.GroupId == scope.GroupId && x.DeletedAt == null, ct))
            {
                return Reject(ShoppingProblems.Invalid("productId", "Produto não encontrado neste grupo."));
            }

            if (await db.PurchaseItems.AnyAsync(x => x.PurchaseId == purchaseId && x.ProductId == request.ProductId && x.DeletedAt == null && x.Id != id, ct))
            {
                return Reject(ShoppingProblems.Duplicate("Este produto já está nesta compra."));
            }

            if (item is null)
            {
                item = new PurchaseItem { Id = id, PurchaseId = purchaseId, CreatedAt = scope.Now };
                db.PurchaseItems.Add(item);
            }

            item.ProductId = request.ProductId;
            item.Quantity = request.Quantity;
            item.UnitPrice = request.UnitPrice;
            item.Picked = request.Picked;
            item.DeletedAt = null;
            item.UpdatedAt = scope.Now;
            scope.Change(ChangeTypes.PurchaseItem, id, item.ToResponse());
            return WriteStep.Done(TypedResults.Ok(item.ToResponse()));
        }

        async Task<IResult> ReplayAsync(Guid groupId, CancellationToken ct)
        {
            var item = await (
                from line in db.PurchaseItems.AsNoTracking()
                join purchase in db.Purchases.AsNoTracking() on line.PurchaseId equals purchase.Id
                where line.Id == id && line.PurchaseId == purchaseId && purchase.GroupId == groupId
                select line).SingleOrDefaultAsync(ct);
            return item is null ? ShoppingProblems.NotFound() : TypedResults.Ok(item.ToResponse());
        }
    }

    private static async Task<IResult> ReplayPurchaseAsync(ShoppingDbContext db, Guid id, Guid groupId, CancellationToken ct) =>
        await db.Purchases.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.GroupId == groupId, ct) is { } purchase
            ? TypedResults.Ok(purchase.ToResponse())
            : ShoppingProblems.NotFound();

    public const int MaxOperations = 50;

    /// <summary>
    /// Aplica até cinquenta escritas guardadas no aparelho, na ordem recebida. Cada uma passa pela mesma rotina da sua
    /// rota (mesmo grupo de quem chama, mesma validação, mesma idempotência) e tem a própria transação: uma recusa não
    /// desfaz as anteriores nem impede as seguintes. A resposta traz o desfecho de cada operação.
    /// </summary>
    private static async Task<IResult> OperationsAsync(
        ShoppingOperationsRequest? request,
        ICurrentUser current,
        ShoppingWriter writer,
        ShoppingDbContext db,
        IAccessGrants grants,
        CancellationToken cancellationToken)
    {
        if (current.UserId is null)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (request?.Operations is not { Count: > 0 and <= MaxOperations } operations || operations.Any(x => x is null))
        {
            return ShoppingProblems.Invalid("operations", $"Envie entre 1 e {MaxOperations} operações.");
        }

        if (operations.Any(x => x.OperationId == Guid.Empty))
        {
            return ShoppingProblems.Invalid("operationId", "Cada operação precisa de um UUID.");
        }

        var results = new List<ShoppingOperationResult>(operations.Count);
        foreach (var operation in operations)
        {
            IResult result;
            try
            {
                result = await DispatchAsync(operation, current, writer, db, grants, cancellationToken);
            }
            catch (JsonException)
            {
                result = ShoppingProblems.Invalid("body", "O corpo da operação não é válido.");
            }

            results.Add(ToResult(operation.OperationId, result));

            // Cada operação começa sem nada rastreado da anterior.
            db.ChangeTracker.Clear();
        }

        return TypedResults.Ok((IReadOnlyList<ShoppingOperationResult>)results);
    }

    /// <summary>O desfecho de uma operação do lote. Um resultado sem status conhecido conta como falha, nunca como aplicado.</summary>
    private static ShoppingOperationResult ToResult(Guid operationId, IResult result)
    {
        var status = (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status500InternalServerError;
        if (result is not ProblemHttpResult problem)
        {
            return new ShoppingOperationResult(operationId, status, null, null);
        }

        var open = problem.ProblemDetails.Extensions.TryGetValue(ShoppingProblems.OpenPurchaseIdExtension, out var value) ? value as Guid? : null;
        return new ShoppingOperationResult(operationId, status, problem.ProblemDetails.Type, open);
    }

    private static Task<IResult> DispatchAsync(
        ShoppingOperationRequest operation,
        ICurrentUser current,
        ShoppingWriter writer,
        ShoppingDbContext db,
        IAccessGrants grants,
        CancellationToken ct) => operation.Kind switch
    {
        OperationKinds.Member => PutMemberAsync(operation.Id, Read<MemberRequest>(operation), current, writer, db, grants, ct),
        OperationKinds.Product => PutProductAsync(operation.Id, Read<ProductRequest>(operation), current, writer, db, ct),
        OperationKinds.ListItem => PutListItemAsync(operation.Id, Read<ListItemRequest>(operation), current, writer, db, ct),
        OperationKinds.OpenPurchase => OpenPurchaseAsync(operation.Id, Read<OpenPurchaseRequest>(operation), current, writer, db, ct),
        OperationKinds.Budget => PutBudgetAsync(operation.Id, Read<BudgetRequest>(operation), current, writer, db, ct),
        OperationKinds.ClosePurchase => ClosePurchaseAsync(operation.Id, Read<ClosePurchaseRequest>(operation), current, writer, db, ct),
        OperationKinds.PurchaseItem when operation.PurchaseId is { } purchaseId =>
            PutPurchaseItemAsync(purchaseId, operation.Id, Read<PurchaseItemRequest>(operation), current, writer, db, ct),
        _ => Task.FromResult(ShoppingProblems.Invalid("kind", "A operação não é reconhecida.")),
    };

    /// <summary>O corpo da operação na forma do pedido da rota. O UUID que vale é sempre o do envelope, nunca um vindo no corpo.</summary>
    private static T? Read<T>(ShoppingOperationRequest operation)
        where T : class
    {
        if (operation.Body is not { ValueKind: JsonValueKind.Object } body)
        {
            return null;
        }

        var node = new JsonObject();
        foreach (var property in body.EnumerateObject())
        {
            if (!string.Equals(property.Name, "operationId", StringComparison.OrdinalIgnoreCase))
            {
                node[property.Name] = JsonNode.Parse(property.Value.GetRawText());
            }
        }

        node["operationId"] = operation.OperationId;
        return node.Deserialize<T>(OperationJson);
    }
}
