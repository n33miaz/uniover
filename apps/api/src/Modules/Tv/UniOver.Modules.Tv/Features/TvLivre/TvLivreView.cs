using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>Um app da TV como o agente o relatou: o de fábrica (de sistema e nunca atualizado) e se está desativado.</summary>
internal sealed record LivreAppView(string Package, bool Factory, bool Disabled);

/// <summary>
/// O que a tela do TV Livre mostra. <c>Available</c> diz se há agente online da TV atual com a capacidade; o resto do
/// estado é o último que o agente relatou (<c>Supported</c> e <c>StateAt</c> são nulos enquanto nenhum chegou).
/// <c>Revision</c> é a última aplicação enviada (0 = nunca aplicada).
/// </summary>
internal sealed record TvLivreView(
    bool Available,
    bool? Supported,
    bool Installed,
    string? Version,
    bool IsHome,
    string? FactoryLauncher,
    IReadOnlyList<string> DisabledPackages,
    IReadOnlyList<LivreAppView> Apps,
    DateTimeOffset? StateAt,
    LivreConfig Config,
    bool HasPhoto,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int Revision)
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>Monta a resposta a partir da linha guardada (nula se a TV ainda não tem nada) e da presença do agente.</summary>
    public static TvLivreView From(TvLivreEntry? entry, bool available)
    {
        var state = ReadState(entry?.StateJson);
        return new TvLivreView(
            available,
            state?.Supported,
            state?.Installed ?? false,
            state?.Version,
            state?.IsHome ?? false,
            state?.FactoryLauncher,
            state?.DisabledPackages ?? [],
            state?.Apps ?? [],
            entry?.StateAt,
            LivreConfigValidator.Parse(entry?.ConfigJson),
            entry?.PhotoData is { Length: > 0 },
            entry?.Revision ?? 0);
    }

    /// <summary>O estado guardado vem do agente (já conferido pelo contrato); ilegível por defeito vira "sem estado".</summary>
    private static LivreAgentState? ReadState(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<LivreAgentState>(json, Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>O corpo de <c>tv.livre.state.v1</c> como foi guardado (só o que a tela usa).</summary>
internal sealed record LivreAgentState(
    bool Supported,
    bool Installed,
    string? Version,
    bool IsHome,
    string? FactoryLauncher,
    IReadOnlyList<string>? DisabledPackages,
    IReadOnlyList<LivreAppView>? Apps);

/// <summary>Corpo de <c>POST /livre/set-home</c>: desativar o launcher de fábrica depois de verificar a home nova (reversível).</summary>
internal sealed record SetHomeRequest(bool DisableFactory = false);

/// <summary>Corpo de <c>POST /livre/restore</c>: desinstalar o launcher depois de voltar e verificar (o padrão é sim).</summary>
internal sealed record RestoreRequest(bool Uninstall = true);

/// <summary>Corpo de <c>POST /livre/apps/visibility</c>: pacotes a desativar e a reativar (reversível).</summary>
internal sealed record AppsVisibilityRequest(IReadOnlyList<string>? Disable = null, IReadOnlyList<string>? Enable = null);

/// <summary>Como as falhas do TV Livre viram <c>ProblemDetails</c> (tipos estáveis que a tela reconhece).</summary>
internal static class LivreProblems
{
    public const string UnsupportedType = "tv-livre-unsupported";
    public const string BusyType = "tv-livre-busy";
    public const string PhotoTooLargeType = "tv-livre-photo-too-large";

    /// <summary>Código com que o agente diz que a TV não é Android TV/Google TV com Android 9 ou mais.</summary>
    public const string AgentUnsupportedCode = "unsupported";

    /// <summary>Esta TV (ou o agente dela) não oferece o TV Livre: a tela esconde o módulo.</summary>
    public static IResult Unsupported(string? agentError = null) => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "Esta TV não suporta o TV Livre.",
        type: ProblemDetailsExtensions.TypeBase + UnsupportedType,
        extensions: agentError is null ? null : new Dictionary<string, object?> { ["agentError"] = agentError });

    public static IResult Busy() => Results.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "Já há um passo do TV Livre em andamento nesta TV.",
        type: ProblemDetailsExtensions.TypeBase + BusyType);

    public static IResult PhotoTooLarge() => Results.Problem(
        statusCode: StatusCodes.Status413PayloadTooLarge,
        title: "A foto passa do limite de 400 KB.",
        type: ProblemDetailsExtensions.TypeBase + PhotoTooLargeType);

    public static IResult NotJpeg() => Results.Problem(
        statusCode: StatusCodes.Status415UnsupportedMediaType,
        title: "Envie a foto em JPEG.");

    /// <summary>
    /// Uma falha de entrega ou do agente. Os códigos do agente (<c>not_installed</c>, <c>invalid_config</c>,
    /// <c>photo_missing</c>, <c>adb_unreachable</c>...) seguem no campo <c>agentError</c> do problema e a tela traduz por eles;
    /// só <c>unsupported</c> ganha tipo próprio, porque é o que faz o módulo sumir e não um erro a repetir.
    /// </summary>
    public static IResult Fail(TvSendOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);

        return outcome.Status == TvSendStatus.CommandFailed
            && string.Equals(outcome.ErrorCode, AgentUnsupportedCode, StringComparison.Ordinal)
            ? Unsupported(AgentUnsupportedCode)
            : TvProblems.Fail(outcome);
    }
}
