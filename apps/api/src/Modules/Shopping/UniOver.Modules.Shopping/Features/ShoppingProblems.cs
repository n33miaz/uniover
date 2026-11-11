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

    private static IResult Conflict(string type, string title) =>
        Results.Problem(statusCode: StatusCodes.Status409Conflict, title: title, type: ProblemDetailsExtensions.TypeBase + type);
}
