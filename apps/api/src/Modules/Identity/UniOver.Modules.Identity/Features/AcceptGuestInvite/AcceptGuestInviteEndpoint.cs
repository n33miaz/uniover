using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Features.Login;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.AcceptGuestInvite;

internal static class AcceptGuestInviteEndpoint
{
    /// <summary>
    /// Única rota anônima nova desta área: quem aceita o convite ainda não tem conta nem sessão. A credencial é o
    /// segredo do convite (32 bytes aleatórios, uso único, validade curta, só o hash no banco), que viaja no corpo
    /// e nunca na URL. O limite por IP é próprio (10 por minuto), separado do balde do login.
    /// </summary>
    public static void MapAcceptGuestInvite(this IEndpointRouteBuilder group) =>
        group.MapPost("/guest-invites/accept", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.GuestInvite)
            .Produces<LoginResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status410Gone)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        AcceptGuestInviteRequest? request,
        AcceptGuestInviteHandler handler,
        AuthCookieWriter cookies,
        IOptions<IdentityModuleOptions> options,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        var errors = Validate(request, options.Value.MinPasswordLength);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(
            new AcceptGuestInviteCommand(request!.Token!, request.Email!.Trim(), request.Password!, ClientInfo.From(http)),
            cancellationToken);

        // Sem rastro em cache: a resposta traz um token de acesso.
        http.Response.Headers.CacheControl = "no-store";
        switch (result.Status)
        {
            case AcceptGuestInviteStatus.Succeeded:
                cookies.AppendRefresh(http.Response, result.RefreshSecret!, result.RefreshMaxAge);
                return TypedResults.Ok(new LoginResponse(result.AccessToken!, result.ExpiresInSeconds));
            case AcceptGuestInviteStatus.EmailUnavailable:
                return IdentityProblems.EmailUnavailable();
            default:
                return IdentityProblems.InviteInvalid();
        }
    }

    /// <summary>
    /// Forma na borda. A senha do convidado segue a regra do dono (só o tamanho mínimo); os códigos de falha da regra
    /// nunca carregam a senha.
    /// </summary>
    internal static Dictionary<string, string[]> Validate(AcceptGuestInviteRequest? request, int minimumPasswordLength)
    {
        var errors = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(request?.Token) || request.Token.Length > 64)
        {
            errors["token"] = ["Abra o link do convite de novo."];
        }

        if (!EmailRules.IsValid(request?.Email?.Trim()))
        {
            errors["email"] = ["Informe um e-mail válido."];
        }

        var passwordProblems = PasswordPolicy.Validate(request?.Password, minimumPasswordLength);
        if (passwordProblems.Count > 0)
        {
            errors["password"] =
            [
                passwordProblems.Contains("password-too-short")
                    ? $"A senha precisa ter ao menos {minimumPasswordLength} caracteres."
                    : "Informe uma senha válida.",
            ];
        }

        return errors;
    }
}
