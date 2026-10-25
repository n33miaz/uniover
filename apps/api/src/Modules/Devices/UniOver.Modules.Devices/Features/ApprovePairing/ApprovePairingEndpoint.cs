using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.StartPairing;
using UniOver.Modules.Devices.Security;
using UniOver.Modules.Tv.Contracts;

namespace UniOver.Modules.Devices.Features.ApprovePairing;

internal sealed record ApprovePairingRequest(string? UserCode, string? Name, string? TvName, IReadOnlyList<Guid>? TvMemberIds);

/// <summary>O convidado só diz qual código aprova e como chamar o computador e a TV dele: nunca quem mais a vê.</summary>
internal sealed record ApproveOwnPairingRequest(string? UserCode, string? Name, string? TvName);

internal sealed record ApprovePairingResponse(Guid Id, string Slug, string Name, string Platform);

internal static class ApprovePairingEndpoint
{
    /// <summary>Ação de confirmação: quem pareia ganha poder de comandar a casa, então pede a passkey.</summary>
    public const string StepUpAction = TvPairingActions.BindAgent;

    public static void MapApprovePairing(this IEndpointRouteBuilder group)
    {
        var route = group.MapPost("/pairing/approve", HandleAsync).RequireRateLimiting(RateLimitPolicies.Pairing)
            .Produces<ApprovePairingResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        // A exigência é decidida ao mapear a rota. Só Development aceita dispensá-la (teste por curl sem a tela de
        // Aparelhos); em qualquer outro ambiente o valor false é ignorado e a passkey continua exigida.
        var services = group.ServiceProvider;
        var environment = services.GetRequiredService<IHostEnvironment>();
        var settings = services.GetRequiredService<IOptions<DevicesModuleOptions>>().Value.Pairing;
        if (environment.IsDevelopment() && !settings.RequireStepUp)
        {
            route.RequireAuthorization();
        }
        else
        {
            route.RequireAuthorization(StepUp.Policy(StepUpAction));
        }
    }

    /// <summary>
    /// A aprovação do convidado para a PRÓPRIA TV. Rota separada da do administrador (nunca a mesma com outro papel): o corpo
    /// não tem lista de pessoas, a política exige a permissão da TV mais a confirmação recente da senha, e o convidado não
    /// alcança a rota do administrador (passkey, só dono). Em Development com a confirmação dispensada vale só a permissão.
    /// </summary>
    public static void MapApproveOwnPairing(this IEndpointRouteBuilder group)
    {
        var route = group.MapPost("/pairing/approve-own", HandleOwnAsync).RequireRateLimiting(RateLimitPolicies.Pairing)
            .Produces<ApprovePairingResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        var services = group.ServiceProvider;
        var environment = services.GetRequiredService<IHostEnvironment>();
        var settings = services.GetRequiredService<IOptions<DevicesModuleOptions>>().Value.Pairing;
        if (environment.IsDevelopment() && !settings.RequireStepUp)
        {
            route.RequireAuthorization(AccessPermissions.Policy(AccessPermissions.TvModule));
        }
        else
        {
            route.RequireAuthorization(PairingPolicies.ApproveOwn);
        }
    }

    private static async Task<IResult> HandleAsync(
        ICurrentUser current,
        HttpContext http,
        ApprovePairingRequest? request,
        ApprovePairingHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return PairingProblems.Unauthenticated();
        }

        var errors = new Dictionary<string, string[]>();
        var (code, name, tvName) = Normalize(request?.UserCode, request?.Name, request?.TvName, errors);

        // Omitido vale lista vazia: a TV sai sempre da aprovação (cliente antigo ou aba com JS velho não volta ao passo manual).
        var tvMemberIds = request?.TvMemberIds ?? [];
        if (tvMemberIds.Count != tvMemberIds.Distinct().Count())
        {
            errors["tvMemberIds"] = ["Informe as pessoas da TV sem repetir."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        // Código com forma inválida responde igual a código inexistente: sem pista sobre o que existe.
        if (code is null)
        {
            return PairingProblems.NotFound();
        }

        var result = await handler.HandleAsync(
            new ApprovePairingCommand(userId, code, name, tvName, tvMemberIds, ClientInfo.From(http)),
            cancellationToken);
        return Respond(result);
    }

    private static async Task<IResult> HandleOwnAsync(
        ICurrentUser current,
        ClaimsPrincipal principal,
        HttpContext http,
        ApproveOwnPairingRequest? request,
        ApprovePairingHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return PairingProblems.Unauthenticated();
        }

        // O administrador aprova pela rota dele (passkey e escolha de pessoas); esta existe só para a conta de convidado.
        if (!string.Equals(AccountRoles.Of(principal), AccountRoles.Guest, StringComparison.Ordinal))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Esta aprovação é só para contas de convidado.");
        }

        var errors = new Dictionary<string, string[]>();
        var (code, name, tvName) = Normalize(request?.UserCode, request?.Name, request?.TvName, errors);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        if (code is null)
        {
            return PairingProblems.NotFound();
        }

        var result = await handler.HandleAsync(
            new ApprovePairingCommand(userId, code, name, tvName, [], ClientInfo.From(http), OwnTvOnly: true),
            cancellationToken);
        return Respond(result);
    }

    private static IResult Respond(ApprovalResult result) => result switch
    {
        { Agent: { } agent } => TypedResults.Ok(new ApprovePairingResponse(agent.Id, agent.Slug, agent.Name, agent.Platform)),
        { Failure: ApprovalFailure.GuestLimitReached } => PairingProblems.GuestLimit(),
        _ => PairingProblems.NotFound(),
    };

    /// <summary>Código normalizado e textos aparados e conferidos; o que estiver errado entra em <paramref name="errors"/>.</summary>
    private static (string? Code, string? Name, string? TvName) Normalize(
        string? userCode, string? rawName, string? rawTvName, Dictionary<string, string[]> errors)
    {
        var code = UserCode.Normalize(userCode);
        var name = rawName?.Trim();
        var tvName = rawTvName?.Trim();
        if (tvName is { Length: 0 })
        {
            tvName = null;
        }

        if (string.IsNullOrEmpty(userCode))
        {
            errors["userCode"] = ["Informe o código mostrado no aparelho."];
        }

        if (name is not null && !StartPairingValidator.IsValidName(name))
        {
            errors["name"] = ["Informe um nome válido (letras, números, espaço e . _ ( ) -)."];
        }

        // O nome da TV é livre (pode levar o nome de uma pessoa, com acento ou apóstrofo), só sem controle e no limite.
        if (tvName is not null && (tvName.Length > PairingText.NameMax || tvName.Any(char.IsControl)))
        {
            errors["tvName"] = ["Informe um nome válido para a TV."];
        }

        return (code, name, tvName);
    }
}
