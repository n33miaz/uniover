using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Shopping.Features;

internal static class ShoppingProblems
{
    public const string OperationInUseType = "shopping-operation-in-use";
    public const string IdInUseType = "shopping-id-in-use";
    public const string DuplicateType = "shopping-duplicate";
    public const string PurchaseClosedType = "shopping-purchase-closed";
    public const string MemberElsewhereType = "shopping-member-in-another-group";
    public const string MembershipChangedType = "shopping-membership-changed";
    public const string GroupChangedType = "shopping-group-changed";
    public const string PurchaseAlreadyOpenType = "shopping-purchase-already-open";
    public const string InviteInvalidType = "shopping-invite-invalid";
    public const string TooManyInvitesType = "shopping-too-many-invites";

    /// <summary>O campo extra do problema "já existe uma compra aberta": o id dela, para o aparelho seguir nela.</summary>
    public const string OpenPurchaseIdExtension = "openPurchaseId";

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    public static IResult Invalid(string field, string message) =>
        ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>(StringComparer.Ordinal) { [field] = [message] });

    public static IResult NotFound() =>
        Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Registro não encontrado neste grupo.");

    public static IResult OwnerOnly() =>
        Results.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Só quem criou o grupo gerencia as pessoas dele.");

    /// <summary>O UUID da operação já foi usado fora deste grupo: nada é aplicado nem revelado.</summary>
    public static IResult OperationInUse() => Conflict(OperationInUseType, "Este identificador de operação já foi usado.");

    /// <summary>O UUID do registro já existe fora do alcance de quem chama. A resposta não diz onde.</summary>
    public static IResult IdInUse() => Conflict(IdInUseType, "Este identificador já está em uso.");

    public static IResult Duplicate(string title) => Conflict(DuplicateType, title);

    public static IResult PurchaseClosed() => Conflict(PurchaseClosedType, "A compra já foi fechada.");

    public static IResult MemberElsewhere() =>
        Conflict(MemberElsewhereType, "Esta pessoa já participa de outro grupo de compras com itens ou outras pessoas.");

    public static IResult MembershipChanged() =>
        Conflict(MembershipChangedType, "Você não participa mais deste grupo. Atualize e tente de novo.");

    /// <summary>
    /// O grupo de quem entra mudou entre a leitura e a trava: nada foi feito, e tentar de novo vale. Não é o caso de "tem
    /// lista com itens" (<see cref="MemberElsewhere"/>), que pede esvaziar ou sair.
    /// </summary>
    public static IResult GroupChanged() => Conflict(GroupChangedType, "A situação mudou. Tente de novo.");

    /// <summary>Convite desconhecido, vencido, usado ou cancelado: a resposta não diz qual.</summary>
    public static IResult InviteInvalid() =>
        Results.Problem(
            statusCode: StatusCodes.Status410Gone,
            title: "Este convite não vale mais. Peça outro.",
            type: ProblemDetailsExtensions.TypeBase + InviteInvalidType);

    public static IResult TooManyInvites() => Conflict(TooManyInvitesType, "Há convites demais esperando. Cancele algum antes.");

    public static IResult PurchaseAlreadyOpen(Guid id) =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Já existe uma compra aberta neste grupo.",
            type: ProblemDetailsExtensions.TypeBase + PurchaseAlreadyOpenType,
            extensions: new Dictionary<string, object?> { [OpenPurchaseIdExtension] = id });

    private static IResult Conflict(string type, string title) =>
        Results.Problem(statusCode: StatusCodes.Status409Conflict, title: title, type: ProblemDetailsExtensions.TypeBase + type);
}
