using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace UniOver.Modules.Devices.Features.GetModuleInfo;

/// <summary>
/// Nome e versão do módulo e o que a API sabe receber dos agentes além do básico (<c>Features</c>): o agente consulta isto
/// antes de declarar uma capacidade nova no <c>hello</c>, porque uma API anterior recusa capacidade que não conhece.
/// </summary>
public sealed record DevicesModuleInfo(string Module, string Version, IReadOnlyList<string> Features);

public sealed class GetModuleInfoHandler(string version)
{
    /// <summary>Mensagens opcionais que esta API aceita dos agentes (o agente só as usa se estiverem aqui).</summary>
    public static readonly IReadOnlyList<string> AgentFeatures = ["agent.diagnostics.v1"];

    public DevicesModuleInfo Handle() => new(DevicesModule.Name, version, AgentFeatures);
}

internal static class GetModuleInfoEndpoint
{
    // Pública como a dos outros módulos: nome, versão e as mensagens opcionais que aceita, nenhum dado do usuário.
    public static void MapGetModuleInfo(this IEndpointRouteBuilder group) =>
        group.MapGet("/info", (GetModuleInfoHandler handler) => TypedResults.Ok(handler.Handle())).AllowAnonymous();
}
