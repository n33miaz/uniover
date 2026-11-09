using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.AdbRebind;

internal sealed record AdbRebindCommand(TvCommandOrigin Origin);

/// <param name="Unsupported">O agente se apresentou sem a capacidade: nada foi enviado.</param>
internal sealed record AdbRebindResult(bool Unsupported, TvSendOutcome? Outcome);

/// <summary>
/// A saída do bloqueio "outro aparelho no endereço da TV": a pessoa confirma, no app, que o aparelho de agora é a mesma TV
/// (trocou de Wi-Fi para cabo, por exemplo) e o agente refaz o registro da permissão do ADB para o MAC de agora. É uma ação
/// explícita e auditada (quem pediu fica na trilha); o agente nunca troca o aparelho do registro sozinho. A rota é só do
/// dono (administrador), a mesma regra do pareamento da TV: quem só abre apps vê "Peça ao dono da TV". Só para agente que declarou <c>tv.adb.rebind.v1</c>.
/// </summary>
internal sealed class AdbRebindHandler(TvCommandRunner runner, IAgentPresenceReader presence)
{
    public async Task<AdbRebindResult> HandleAsync(AdbRebindCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var target = await runner.ResolveTargetAsync(cancellationToken);

        // Agente que se apresentou sem a capacidade não recebe nada. Agente que nunca se apresentou segue para o comando,
        // que responde "fora do ar" como em qualquer outro.
        if (!string.IsNullOrWhiteSpace(target.AgentSlug)
            && presence.Get(target.AgentSlug) is { } info
            && !info.Capabilities.Contains(TvCapabilities.AdbRebindV1, StringComparer.Ordinal))
        {
            return new AdbRebindResult(true, null);
        }

        var outcome = await runner.RunAsync(
            command.Origin, TvCommandNames.AdbRebind, null, TvMessages.AdbRebind(), waitForReply: true, cancellationToken);
        return new AdbRebindResult(false, outcome);
    }
}

internal static class AdbRebindEndpoint
{
    public const string UnsupportedType = "adb-rebind-unsupported";

    public static void MapAdbRebind(this IEndpointRouteBuilder group) =>
        group.MapPost("/adb/rebind", HandleAsync).RequireAuthorization(UniOverAuth.OwnerPolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<TvCommandOk>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        ICurrentUser current, HttpContext http, AdbRebindHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var result = await handler.HandleAsync(new AdbRebindCommand(origin), cancellationToken);
        if (result.Unsupported)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "O computador da TV precisa ser atualizado para refazer o registro do ADB.",
                type: ProblemDetailsExtensions.TypeBase + UnsupportedType);
        }

        return TvProblems.ToResult(result.Outcome!);
    }
}
