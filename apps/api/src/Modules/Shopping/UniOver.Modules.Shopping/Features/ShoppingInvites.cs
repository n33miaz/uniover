using System.Buffers.Text;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Shopping.Audit;
using UniOver.Modules.Shopping.Domain;
using UniOver.Modules.Shopping.Persistence;

namespace UniOver.Modules.Shopping.Features;

/// <summary>
/// Convites para o grupo, por link ou QR. Quem criou o grupo gera o convite; quem o abre, com a permissão do módulo, entra
/// no grupo. O segredo só existe na resposta da criação (e no link); o banco guarda o SHA-256 dele. Uso único, com prazo
/// e revogável. Entrar segue as regras de incluir uma pessoa: quem já tem a própria lista com itens ou outras pessoas é
/// recusado, para ninguém perder a lista sem saber.
/// </summary>
internal static class ShoppingInvites
{
    /// <summary>Quanto tempo um convite vale.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    /// <summary>Convites esperando ao mesmo tempo, por grupo.</summary>
    public const int MaxPending = 10;

    private const int SecretBytes = 32;

    public static void MapShoppingInvites(this IEndpointRouteBuilder group)
    {
        group.MapPost("/group/invites", CreateAsync)
            .RequireAuthorization(ShoppingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<GroupInviteCreatedResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
        group.MapGet("/group/invites", ListAsync)
            .RequireAuthorization(ShoppingAuth.Module)
            .Produces<IReadOnlyList<GroupInviteResponse>>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
        group.MapPost("/group/invites/{id:guid}/revoke", RevokeAsync)
            .RequireAuthorization(ShoppingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<ShoppingDbContext>();
        group.MapPost("/group/invites/accept", AcceptAsync)
            .RequireAuthorization(ShoppingAuth.Module)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<GroupResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
    }

    /// <summary>Segredo (vai no link) e o hash dele (vai para o banco).</summary>
    internal static (string Secret, byte[] Hash) NewSecret()
    {
        var bytes = RandomNumberGenerator.GetBytes(SecretBytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    /// <summary>O hash do segredo apresentado; nulo se o texto não tem a forma de um segredo nosso.</summary>
    internal static byte[]? HashOf(string? secret)
    {
        if (string.IsNullOrWhiteSpace(secret) || secret.Length > 64)
        {
            return null;
        }

        try
        {
            var bytes = Base64Url.DecodeFromChars(secret);
            return bytes.Length == SecretBytes ? SHA256.HashData(bytes) : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static async Task<IResult> CreateAsync(
        HttpContext http, ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var self = await groups.GetForUserAsync(actor, cancellationToken);
        if (!self.IsOwner)
        {
            return ShoppingProblems.OwnerOnly();
        }

        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        await db.Database.ExecuteSqlAsync($"""SELECT 1 FROM "shopping"."groups" WHERE id = {self.GroupId} FOR UPDATE""", cancellationToken);
        var pending = await db.GroupInvites.CountAsync(
            x => x.GroupId == self.GroupId && x.UsedAt == null && x.RevokedAt == null && x.ExpiresAt > now, cancellationToken);
        if (pending >= MaxPending)
        {
            return ShoppingProblems.TooManyInvites();
        }

        var (secret, hash) = NewSecret();
        var invite = new ShoppingGroupInvite
        {
            Id = Guid.CreateVersion7(),
            GroupId = self.GroupId,
            TokenHash = hash,
            CreatedBy = actor,
            CreatedAt = now,
            ExpiresAt = now + Lifetime,
        };
        db.GroupInvites.Add(invite);
        db.MemberAudit.Add(Audit(ShoppingAuditEvents.InviteCreated, actor, actor, now));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        // O segredo só existe nesta resposta: nada de cache em intermediário.
        http.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(new GroupInviteCreatedResponse(invite.Id, secret, invite.ExpiresAt));
    }

    /// <summary>Os convites que ainda podem ser aceitos, só para quem criou o grupo.</summary>
    private static async Task<IResult> ListAsync(
        ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var self = await groups.GetForUserAsync(actor, cancellationToken);
        if (!self.IsOwner)
        {
            return ShoppingProblems.OwnerOnly();
        }

        var now = time.GetUtcNow();
        var invites = await db.GroupInvites.AsNoTracking()
            .Where(x => x.GroupId == self.GroupId && x.UsedAt == null && x.RevokedAt == null && x.ExpiresAt > now)
            .OrderByDescending(x => x.CreatedAt)
            .Select(x => new GroupInviteResponse(x.Id, x.CreatedAt, x.ExpiresAt))
            .ToListAsync(cancellationToken);
        return TypedResults.Ok((IReadOnlyList<GroupInviteResponse>)invites);
    }

    /// <summary>Cancelar de novo, ou um convite já usado, não muda nada. Convite de outro grupo: 404, sem dizer de quem é.</summary>
    private static async Task<IResult> RevokeAsync(
        Guid id, ICurrentUser current, ShoppingGroupService groups, ShoppingDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        var self = await groups.GetForUserAsync(actor, cancellationToken);
        if (!self.IsOwner)
        {
            return ShoppingProblems.OwnerOnly();
        }

        var invite = await db.GroupInvites.SingleOrDefaultAsync(x => x.Id == id && x.GroupId == self.GroupId, cancellationToken);
        if (invite is null)
        {
            return ShoppingProblems.NotFound();
        }

        var now = time.GetUtcNow();
        if (invite.UsedAt is null && invite.RevokedAt is null)
        {
            invite.RevokedAt = now;
            db.MemberAudit.Add(Audit(ShoppingAuditEvents.InviteRevoked, actor, actor, now));
            await db.SaveChangesAsync(cancellationToken);
        }

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Entra no grupo do convite. Quem já está nele recebe o grupo de volta sem gastar o convite (abrir o link duas vezes
    /// não faz mal). O convite é reivindicado por um UPDATE condicional na mesma transação que inclui a pessoa: dois aceites
    /// do mesmo link ao mesmo tempo incluem uma pessoa só, e uma recusa devolve o convite intacto.
    /// </summary>
    private static async Task<IResult> AcceptAsync(
        AcceptGroupInviteRequest? request,
        ICurrentUser current,
        ShoppingGroupService groups,
        ShoppingDbContext db,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } actor)
        {
            return ShoppingProblems.Unauthenticated();
        }

        if (HashOf(request?.Token) is not { } hash)
        {
            return ShoppingProblems.InviteInvalid();
        }

        var invite = await db.GroupInvites.AsNoTracking().SingleOrDefaultAsync(x => x.TokenHash == hash, cancellationToken);
        if (invite is null)
        {
            return ShoppingProblems.InviteInvalid();
        }

        // Garante que a pessoa tenha um grupo (o próprio, criado no primeiro acesso) antes de travar qualquer coisa. Quem
        // já está no grupo do convite (abriu o link de novo) recebe o grupo, mesmo com o convite já usado.
        var mine = await groups.GetForUserAsync(actor, cancellationToken);
        if (mine.GroupId == invite.GroupId)
        {
            return TypedResults.Ok(new GroupResponse(mine.GroupId, mine.Group!.OwnerUserId, mine.IsOwner));
        }

        // Recusa cedo, sem travar nada, o que já não vale (o que vale mesmo é conferido de novo com os grupos travados).
        if (!invite.IsPendingAt(time.GetUtcNow()))
        {
            return ShoppingProblems.InviteInvalid();
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);

        // Os dois grupos são travados sempre na mesma ordem (a mesma da inclusão direta): pedidos cruzados não se esperam.
        await ShoppingGroupLocks.LockAsync(db, [invite.GroupId, mine.GroupId], cancellationToken);

        // A hora é lida depois da espera pela trava: um convite que venceu enquanto o pedido esperava não é aceito.
        var now = time.GetUtcNow();

        // Quem criou o grupo precisa continuar nele: um grupo que o dono deixou não recebe mais ninguém.
        var owner = await db.Groups.AsNoTracking().Where(x => x.Id == invite.GroupId).Select(x => x.OwnerUserId).SingleAsync(cancellationToken);
        if (!await db.Members.AnyAsync(x => x.GroupId == invite.GroupId && x.UserId == owner && x.DeletedAt == null, cancellationToken))
        {
            return ShoppingProblems.InviteInvalid();
        }

        var inviteId = invite.Id;
        var claimed = await db.GroupInvites
            .Where(x => x.Id == inviteId && x.UsedAt == null && x.RevokedAt == null && x.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.UsedAt, now).SetProperty(x => x.UsedBy, actor), cancellationToken);
        if (claimed != 1)
        {
            return ShoppingProblems.InviteInvalid();
        }

        // Relido com os grupos travados. Sem commit nas saídas abaixo: a transação desfaz a reivindicação.
        var elsewhere = await db.Members.SingleOrDefaultAsync(x => x.UserId == actor && x.DeletedAt == null, cancellationToken);
        if (elsewhere is not null && elsewhere.GroupId != invite.GroupId && elsewhere.GroupId != mine.GroupId)
        {
            // A pessoa mudou de grupo entre a leitura e a trava: o grupo novo não está travado na ordem. Recusa; tentar de novo vale.
            return ShoppingProblems.GroupChanged();
        }

        if (elsewhere is not null && elsewhere.GroupId != invite.GroupId
            && !await ShoppingWrites.LeaveEmptyGroupAsync(db, elsewhere, now, cancellationToken))
        {
            return ShoppingProblems.MemberElsewhere();
        }

        var member = await db.Members.SingleOrDefaultAsync(x => x.GroupId == invite.GroupId && x.UserId == actor, cancellationToken);
        if (member is null)
        {
            member = new ShoppingMember { GroupId = invite.GroupId, UserId = actor, CreatedAt = now };
            db.Members.Add(member);
        }
        else
        {
            member.DeletedAt = null;
        }

        // A entrada vira uma linha do feed do grupo, como a inclusão feita pelo dono: os outros aparelhos ficam sabendo.
        var operationId = Guid.CreateVersion7();
        db.Operations.Add(new ShoppingOperation { Id = operationId, GroupId = invite.GroupId, ActorUserId = actor, AppliedAt = now });
        db.Changes.Add(new ShoppingChange
        {
            GroupId = invite.GroupId,
            OperationId = operationId,
            EntityType = ChangeTypes.Member,
            EntityId = actor,
            Payload = System.Text.Json.JsonSerializer.Serialize(member.ToResponse(), ShoppingJson.Web),
            OccurredAt = now,
        });
        db.MemberAudit.Add(Audit(ShoppingAuditEvents.MemberJoined, actor, actor, now));

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // A pessoa entrou em outro grupo entre a conferência e a gravação: nada fica.
            db.ChangeTracker.Clear();
            return ShoppingProblems.MemberElsewhere();
        }

        await transaction.CommitAsync(cancellationToken);
        return TypedResults.Ok(new GroupResponse(invite.GroupId, owner, false));
    }

    private static ShoppingMemberAuditEntry Audit(string @event, Guid actor, Guid target, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(),
        Event = @event,
        ActorUserId = actor,
        TargetUserId = target,
        OccurredAt = now,
    };
}

/// <summary>
/// Limpeza dos convites que não servem mais: vencidos, usados ou cancelados há mais de <see cref="Retention"/>. Roda no
/// despertar diário do serviço de retenção que já existe (nenhum relógio novo). Os que ainda esperam ficam.
/// </summary>
internal static class ShoppingInviteCleanup
{
    public const string JobName = "shopping.invites";

    /// <summary>Quanto tempo um convite que acabou continua guardado.</summary>
    public static readonly TimeSpan Retention = TimeSpan.FromDays(30);

    /// <summary>Apaga os convites acabados há mais do prazo; devolve quantos saíram.</summary>
    public static async Task<long> RunAsync(ShoppingDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(time);

        var cutoff = time.GetUtcNow() - Retention;
        return await db.GroupInvites
            .Where(x => x.ExpiresAt < cutoff || x.UsedAt < cutoff || x.RevokedAt < cutoff)
            .ExecuteDeleteAsync(cancellationToken);
    }

    /// <summary>Entra na lista de trabalhos do serviço de retenção (o mesmo despertar diário dos outros módulos).</summary>
    public static IServiceCollection AddShoppingInviteCleanup(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton(new AuditPurgeJob(
            JobName,
            (provider, cancellationToken) => RunAsync(
                provider.GetRequiredService<ShoppingDbContext>(),
                provider.GetRequiredService<TimeProvider>(),
                cancellationToken)));
        return services;
    }
}

internal static class ShoppingJson
{
    public static readonly System.Text.Json.JsonSerializerOptions Web = new(System.Text.Json.JsonSerializerDefaults.Web);
}
