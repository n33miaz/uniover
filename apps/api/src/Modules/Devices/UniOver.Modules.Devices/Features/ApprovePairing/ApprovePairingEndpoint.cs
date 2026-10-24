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
        var code = UserCode.Normalize(request?.UserCode);
        var name = request?.Name?.Trim();
        var tvName = request?.TvName?.Trim();
        if (tvName is { Length: 0 })
        {
            tvName = null;
        }

        if (string.IsNullOrEmpty(request?.UserCode))
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

        var agent = await handler.HandleAsync(
            new ApprovePairingCommand(userId, code, name, tvName, tvMemberIds, ClientInfo.From(http)),
            cancellationToken);
        return agent is null
            ? PairingProblems.NotFound()
            : TypedResults.Ok(new ApprovePairingResponse(agent.Id, agent.Slug, agent.Name, agent.Platform));
    }
}
