using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Security;

/// <summary>Respostas de erro do módulo como ProblemDetails, com os <c>type</c> estáveis que o cliente reconhece.</summary>
internal static class IdentityProblems
{
    public const string ClientHeader = "X-UniOver-Client";
    public const string ClientHeaderValue = "web";

    public const string LoginLocked = "login-locked";
    public const string RefreshConflict = "refresh-conflict";

    /// <summary>
    /// O cabeçalho obrigatório é uma defesa extra contra CSRF: um formulário de outra origem não consegue
    /// mandar cabeçalho próprio sem passar por CORS (que a API não libera).
    /// </summary>
    public static bool HasClientHeader(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        return request.Headers.TryGetValue(ClientHeader, out StringValues value)
            && string.Equals(value.ToString(), ClientHeaderValue, StringComparison.Ordinal);
    }

    public static IResult MissingClientHeader() =>
        ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
        {
            [ClientHeader] = [$"O cabeçalho {ClientHeader}: {ClientHeaderValue} é obrigatório."],
        });

    public static IResult InvalidCredentials() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "E-mail ou senha inválidos.");

    public static IResult Unauthenticated() =>
        Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Sessão inválida ou expirada.");

    public static IResult Locked(HttpResponse response, TimeSpan retryAfter)
    {
        ArgumentNullException.ThrowIfNull(response);
        response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
            .ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.Problem(
            statusCode: StatusCodes.Status429TooManyRequests,
            title: "Conta temporariamente bloqueada. Tente de novo mais tarde.",
            type: ProblemDetailsExtensions.TypeBase + LoginLocked);
    }

    public const string StepUpFailedType = "step-up-failed";
    public const string InvalidPasswordType = "invalid-password";
    public const string NoPasskeyType = "no-passkey";
    public const string LastPasskeyType = "last-passkey";
    public const string PasskeyRegistrationFailedType = "passkey-registration-failed";

    /// <summary>Confirmação recusada (desafio vencido ou repetido, assinatura inválida...): sem detalhe para quem tenta.</summary>
    public static IResult StepUpFailed() =>
        Results.Problem(
            statusCode: StatusCodes.Status403Forbidden,
            title: "Não foi possível confirmar a ação com a passkey.",
            type: ProblemDetailsExtensions.TypeBase + StepUpFailedType);

    /// <summary>
    /// Senha errada numa confirmação com a sessão já aberta. Não é 401 de propósito: o app trataria como sessão
    /// vencida e tentaria renovar, em vez de mostrar que a senha digitada não confere.
    /// </summary>
    public static IResult InvalidPassword() =>
        Results.Problem(
            statusCode: StatusCodes.Status403Forbidden,
            title: "Senha incorreta.",
            type: ProblemDetailsExtensions.TypeBase + InvalidPasswordType);

    public static IResult NoPasskey() =>
        Results.Problem(
            statusCode: StatusCodes.Status404NotFound,
            title: "Nenhuma passkey cadastrada.",
            type: ProblemDetailsExtensions.TypeBase + NoPasskeyType);

    public static IResult LastPasskey() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Esta é a última passkey: cadastre outra antes de remover.",
            type: ProblemDetailsExtensions.TypeBase + LastPasskeyType);

    public static IResult PasskeyRegistrationFailed() =>
        Results.Problem(
            statusCode: StatusCodes.Status400BadRequest,
            title: "Não foi possível cadastrar a passkey.",
            type: ProblemDetailsExtensions.TypeBase + PasskeyRegistrationFailedType);

    public const string InviteInvalidType = "invite-invalid";
    public const string EmailUnavailableType = "email-unavailable";
    public const string TooManyInvitesType = "too-many-invites";
    public const string InviteNotPendingType = "invite-not-pending";

    /// <summary>
    /// Convite desconhecido, vencido, usado ou revogado: a mesma resposta para todos, sem dizer qual (quem tem só um
    /// palpite não aprende nada).
    /// </summary>
    public static IResult InviteInvalid() =>
        Results.Problem(
            statusCode: StatusCodes.Status410Gone,
            title: "Este convite não vale mais. Peça um novo a quem o enviou.",
            type: ProblemDetailsExtensions.TypeBase + InviteInvalidType);

    public static IResult EmailUnavailable() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Este e-mail não pode ser usado. Escolha outro.",
            type: ProblemDetailsExtensions.TypeBase + EmailUnavailableType);

    public static IResult TooManyInvites() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Há convites pendentes demais. Revogue algum antes de criar outro.",
            type: ProblemDetailsExtensions.TypeBase + TooManyInvitesType);

    public static IResult InviteNotPending() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "Este convite já foi aceito: revogue a conta do convidado.",
            type: ProblemDetailsExtensions.TypeBase + InviteNotPendingType);

    public static IResult Conflict() =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "A sessão acabou de ser renovada em outra aba. Tente de novo.",
            type: ProblemDetailsExtensions.TypeBase + RefreshConflict);
}
