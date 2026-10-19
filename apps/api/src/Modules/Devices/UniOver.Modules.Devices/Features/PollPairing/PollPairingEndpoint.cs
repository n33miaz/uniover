using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PollPairing;

internal sealed record PollPairingRequest(Guid? PairingId, string? DeviceCode);

/// <summary>Corpo das respostas 200: <c>status</c> diz o que o agente deve fazer; os demais campos dependem dele.</summary>
internal sealed record PollPairingResponse(
    string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Interval = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AgentId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DeviceToken = null);

internal static class PollPairingEndpoint
{
    // Anônima de propósito: o agente ainda não tem token. O deviceCode (segredo de 32 bytes) é a credencial desta rota.
    public static void MapPollPairing(this IEndpointRouteBuilder group) =>
        group.MapPost("/pairing/poll", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Pairing);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        PollPairingRequest? request,
        PollPairingHandler handler,
        CancellationToken cancellationToken)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.PairingId is not { } pairingId || pairingId == Guid.Empty)
        {
            errors["pairingId"] = ["Informe o pareamento."];
        }

        if (string.IsNullOrWhiteSpace(request?.DeviceCode))
        {
            errors["deviceCode"] = ["Informe o código do aparelho."];
        }

        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(
            new PollPairingCommand(request!.PairingId!.Value, request.DeviceCode!, ClientInfo.From(http)), cancellationToken);

        return result.Status switch
        {
            PollStatus.Pending => TypedResults.Ok(new PollPairingResponse("pending")),
            PollStatus.SlowDown => TypedResults.Ok(new PollPairingResponse("slow_down", result.IntervalSeconds)),
            PollStatus.Approved => TypedResults.Ok(new PollPairingResponse("approved", AgentId: result.AgentId, DeviceToken: result.DeviceToken)),
            PollStatus.Expired => PairingProblems.Expired(),
            PollStatus.Consumed => PairingProblems.Consumed(),
            PollStatus.Denied => PairingProblems.Denied(),
            _ => PairingProblems.NotFound(),
        };
    }
}
