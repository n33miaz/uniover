using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.OpenSettings;

/// <param name="Screen">Uma tela da lista fechada: <c>WIFI</c> ou <c>SETTINGS</c> (os nomes do contrato).</param>
internal sealed record OpenSettingsRequest(string? Screen);

/// <summary>
/// A lista fechada de telas que a API sabe pedir à TV. O nome vem do contrato (<c>tv.settings.open.v1</c>); qualquer outro
/// valor é recusado aqui, antes de chegar ao agente.
/// </summary>
internal static class OpenSettingsScreens
{
    public const string Wifi = "WIFI";
    public const string Settings = "SETTINGS";

    public static bool TryParse(string? name, out string screen)
    {
        // Comparação exata de propósito: nada de apelidos nem de maiúsculas diferentes.
        screen = name ?? string.Empty;
        return screen is Wifi or Settings;
    }
}

internal sealed record OpenSettingsCommand(TvCommandOrigin Origin, string Screen);

/// <param name="Unsupported">O agente se apresentou sem a capacidade: nada foi enviado.</param>
internal sealed record OpenSettingsResult(bool Unsupported, TvSendOutcome? Outcome);

/// <summary>
/// Abre na TV a tela de rede ou as configurações. Só quando a pessoa toca no botão (a rota é do controle, <c>tv:control</c>)
/// e só para agente que declarou <c>tv.settings.open.v1</c>: a Samsung e os agentes antigos não a têm, e para eles nada é enviado.
/// A trilha guarda quem pediu e qual tela, como em qualquer comando da TV.
/// </summary>
internal sealed class OpenSettingsHandler(TvCommandRunner runner, IAgentPresenceReader presence)
{
    public async Task<OpenSettingsResult> HandleAsync(OpenSettingsCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var target = await runner.ResolveTargetAsync(cancellationToken);

        // Agente que se apresentou sem a capacidade não recebe nada. Agente que nunca se apresentou segue para o comando,
        // que responde "fora do ar" como em qualquer outro.
        if (!string.IsNullOrWhiteSpace(target.AgentSlug)
            && presence.Get(target.AgentSlug) is { } info
            && !info.Capabilities.Contains(TvCapabilities.SettingsOpenV1, StringComparer.Ordinal))
        {
            return new OpenSettingsResult(true, null);
        }

        var outcome = await runner.RunAsync(
            command.Origin, TvCommandNames.SettingsOpen, command.Screen, TvMessages.OpenSettings(command.Screen), waitForReply: true, cancellationToken);
        return new OpenSettingsResult(false, outcome);
    }
}

internal static class OpenSettingsEndpoint
{
    public const string UnsupportedType = "settings-unsupported";

    public static void MapOpenSettings(this IEndpointRouteBuilder group) =>
        group.MapPost("/settings/open", HandleAsync).RequireAuthorization(TvAuth.Control)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        OpenSettingsRequest request,
        ICurrentUser current,
        HttpContext http,
        OpenSettingsHandler handler,
        CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        if (!OpenSettingsScreens.TryParse(request.Screen, out var screen))
        {
            return ProblemDetailsExtensions.ValidationProblem(
                new Dictionary<string, string[]> { ["screen"] = ["A tela deve ser WIFI ou SETTINGS."] });
        }

        var result = await handler.HandleAsync(new OpenSettingsCommand(origin, screen), cancellationToken);
        if (result.Unsupported)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Esta TV não abre essa tela pelo app.",
                type: ProblemDetailsExtensions.TypeBase + UnsupportedType);
        }

        return TvProblems.ToResult(result.Outcome!);
    }
}
