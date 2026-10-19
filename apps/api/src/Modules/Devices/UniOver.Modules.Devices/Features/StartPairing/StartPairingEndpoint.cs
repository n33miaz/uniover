using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.StartPairing;

internal sealed record StartPairingRequest(string? AgentName, string? Platform, string? AgentVersion);

internal sealed record StartPairingResponse(Guid PairingId, string DeviceCode, string UserCode, int ExpiresIn, int Interval);

/// <summary>
/// Validação de forma na borda: a rota é anônima, então tudo que o agente manda é texto não confiável, com
/// tamanho e alfabeto limitados antes de qualquer gravação.
/// </summary>
internal static partial class StartPairingValidator
{
    [GeneratedRegex(@"^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex NamePattern();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._ -]*$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex PlatformPattern();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9.+_-]*$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex VersionPattern();

    public static bool IsValidName(string value) =>
        value.Length is > 0 and <= PairingText.NameMax && NamePattern().IsMatch(value);

    public static Dictionary<string, string[]> Validate(StartPairingRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        Check(errors, "agentName", request?.AgentName?.Trim(), PairingText.NameMax, NamePattern(), "Informe o nome do agente (letras, números, espaço e . _ ( ) -).");
        Check(errors, "platform", request?.Platform?.Trim(), PairingText.PlatformMax, PlatformPattern(), "Informe a plataforma (letras, números e . _ -).");
        Check(errors, "agentVersion", request?.AgentVersion?.Trim(), PairingText.VersionMax, VersionPattern(), "Informe a versão do agente (letras, números e . + _ -).");
        return errors;
    }

    private static void Check(Dictionary<string, string[]> errors, string field, string? value, int max, Regex pattern, string message)
    {
        if (string.IsNullOrEmpty(value) || value.Length > max || !pattern.IsMatch(value))
        {
            errors[field] = [message];
        }
    }
}

internal static class StartPairingEndpoint
{
    // Anônima de propósito: o agente ainda não tem credencial. O limite por IP e o teto de pareamentos abertos protegem a rota.
    public static void MapStartPairing(this IEndpointRouteBuilder group) =>
        group.MapPost("/pairing/start", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Pairing);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        StartPairingRequest? request,
        StartPairingHandler handler,
        CancellationToken cancellationToken)
    {
        var errors = StartPairingValidator.Validate(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(
            new StartPairingCommand(
                request!.AgentName!.Trim(), request.Platform!.Trim(), request.AgentVersion!.Trim(), ClientInfo.From(http)),
            cancellationToken);

        return result.TooManyActive
            ? PairingProblems.TooManyActive(http.Response, result.RetryAfter)
            : TypedResults.Ok(new StartPairingResponse(
                result.PairingId, result.DeviceCode!, result.UserCode!, result.ExpiresInSeconds, result.IntervalSeconds));
    }
}
