using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.Commands;
using UniOver.Modules.Tv.Features.LaunchShortcut;
using UniOver.Modules.Tv.Features.PowerOff;
using UniOver.Modules.Tv.Features.Selection;
using UniOver.Modules.Tv.Features.SendKey;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Features.Siri;

/// <summary>
/// O que o atalho do iPhone manda, em JSON. <paramref name="Action"/> é <c>power_off</c>, <c>volume_up</c>,
/// <c>volume_down</c>, <c>mute</c>, <c>key</c> (com <paramref name="Key"/>) ou <c>app</c> (com <paramref name="App"/>, o id
/// do atalho do app). <paramref name="Tv"/> é o id da TV da chave; se vier, tem de ser a mesma.
/// </summary>
internal sealed record SiriCommandRequest(string? Tv, string? Action, string? Key, string? App);

/// <summary>Resposta de uma ordem entregue; <see cref="Message"/> é uma frase curta, boa para a Siri falar.</summary>
internal sealed record SiriCommandOk(bool Ok, string Message, [property: System.Text.Json.Serialization.JsonNumberHandling(System.Text.Json.Serialization.JsonNumberHandling.Strict)] int LatencyMs);

/// <summary>Cabeçalho que leva a chave no atalho. Não é <c>Authorization</c>: a chave não é um JWT e não deve passar pelo leitor de JWT.</summary>
internal static class SiriHeaders
{
    public const string Token = "X-Atalho-Token";
}

internal enum SiriStatus
{
    /// <summary>Chave ausente, desconhecida, revogada ou vencida (a mesma resposta para todas, sem pista de qual).</summary>
    Unauthorized,

    BadRequest,

    /// <summary>A chave existe mas não tem direito a isto: ação fora da lista, outra TV ou permissão perdida.</summary>
    Denied,

    TvNotFound,

    /// <summary>O pedido foi montado e entregue ao agente (ou ao menos tentado): <see cref="SiriResult.Send"/> diz como terminou.</summary>
    Ran,

    ShortcutNotFound,

    ShortcutNotInstalled,
}

internal sealed record SiriResult(SiriStatus Status, string? Message = null, TvSendOutcome? Send = null, string? PowerOutcome = null);

/// <summary>Os motivos de recusa, como ficam na trilha (<c>error_code</c>, até 40 caracteres).</summary>
internal static class SiriDenials
{
    public const string OutOfScope = "out_of_scope";
    public const string OtherTv = "other_tv";
    public const string PermissionLost = "permission_lost";
}

internal sealed class SiriCommandHandler(
    TvDbContext db,
    IAccessGrants grants,
    TvSelectionService selection,
    ITvCurrentSelection current,
    SendKeyHandler sendKey,
    PowerOffHandler powerOff,
    LaunchShortcutHandler launch,
    ITvCommandAudit audit,
    TimeProvider time)
{
    /// <summary>A chave só é lembrada como usada a cada minuto: não vale uma gravação por tecla de volume.</summary>
    private static readonly TimeSpan LastUsedGranularity = TimeSpan.FromMinutes(1);

    public async Task<SiriResult> HandleAsync(
        string? presentedToken, SiriCommandRequest? request, ClientInfo client, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(client);

        // Texto que nem tem a forma de uma chave nossa não chega ao banco.
        if (SiriSecrets.HashPresented(presentedToken) is not { } hash)
        {
            return new SiriResult(SiriStatus.Unauthorized);
        }

        var now = time.GetUtcNow();
        var token = await db.SiriTokens.AsNoTracking().SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null || !token.IsUsable(now))
        {
            return new SiriResult(SiriStatus.Unauthorized);
        }

        var code = request is null ? null : SiriActions.CodeOf(request.Action, request.Key, request.App);
        if (code is null)
        {
            return new SiriResult(SiriStatus.BadRequest);
        }

        // A TV é a da chave. Se o atalho citar uma, tem de ser a mesma: um atalho montado para outra TV não pode "dar certo".
        if (!string.IsNullOrWhiteSpace(request!.Tv) && !(Guid.TryParse(request.Tv.Trim(), out var requestedTv) && requestedTv == token.TvId))
        {
            return await DenyAsync(token, code, SiriDenials.OtherTv, client, now);
        }

        if (!token.Actions.Contains(code, StringComparer.Ordinal))
        {
            return await DenyAsync(token, code, SiriDenials.OutOfScope, client, now);
        }

        // A conta pode ter perdido o direito depois de criar a chave (ou ter sido desativada): a chave nunca vale mais que ela.
        if (!await grants.HasAsync(token.UserId, AccessPermissions.TvModule, cancellationToken)
            || !await grants.HasAsync(token.UserId, SiriActions.PermissionOf(code), cancellationToken))
        {
            return await DenyAsync(token, code, SiriDenials.PermissionLost, client, now);
        }

        // Só o administrador cria chaves, então quem a criou vê todas as TVs; a TV pode ter sido excluída desde então.
        var target = await selection.ResolveAsync(token.UserId, isOwner: true, token.TvId, cancellationToken);
        if (target is null)
        {
            return new SiriResult(SiriStatus.TvNotFound);
        }

        current.Set(target);
        await TouchAsync(token, now, cancellationToken);

        var origin = new TvCommandOrigin(token.UserId, client, TvCommandOrigin.ViaSiri);
        return await RunAsync(code, origin, cancellationToken);
    }

    private async Task<SiriResult> RunAsync(string code, TvCommandOrigin origin, CancellationToken cancellationToken)
    {
        if (code == SiriActions.PowerOff)
        {
            // Sempre o desligar com leitura: se a TV já está desligada nada é enviado, e ele nunca a liga por engano.
            var (send, outcome) = await powerOff.HandleAsync(new PowerOffCommand(origin, Safe: true, RequireSafe: true), cancellationToken);
            var done = send.IsDelivered || outcome == PowerOffOutcomes.AlreadyOff;
            return new SiriResult(SiriStatus.Ran, done ? PowerOffMessage(outcome) : null, send, done ? outcome : null);
        }

        if (SiriActions.AppIdOf(code) is { } appId)
        {
            var result = await launch.HandleAsync(new LaunchShortcutCommand(origin, appId), cancellationToken);
            return !result.Found
                ? new SiriResult(SiriStatus.ShortcutNotFound)
                : !result.Installed
                    ? new SiriResult(SiriStatus.ShortcutNotInstalled)
                    : new SiriResult(SiriStatus.Ran, "App aberto.", result.Outcome);
        }

        // Volume, mudo e as teclas de navegação: o nome da tecla vem do catálogo fechado, nunca do pedido solto.
        var keyName = SiriActions.KeyOf(code)!;
        var key = TvMessages.Keys[keyName];
        var sent = await sendKey.HandleAsync(new SendKeyCommand(origin, keyName, key, null), cancellationToken);
        return new SiriResult(SiriStatus.Ran, KeyMessage(code), sent);
    }

    private async Task<SiriResult> DenyAsync(SiriToken token, string code, string reason, ClientInfo client, DateTimeOffset now)
    {
        // A recusa também é rastro: alguém tentou usar a chave para o que ela não permite.
        await audit.RecordAsync(
            CommandAuditEntry.Create(
                token.UserId, null, TvCommandNames.SiriDenied, code, ok: false, errorCode: reason, latencyMs: null, client, now, token.TvId),
            CancellationToken.None);
        return new SiriResult(SiriStatus.Denied);
    }

    private async Task TouchAsync(SiriToken token, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (token.LastUsedAt is { } last && now - last < LastUsedGranularity)
        {
            return;
        }

        // Atualização direta: o token foi lido sem rastreamento e nada mais dele muda aqui.
        await db.SiriTokens.Where(t => t.Id == token.Id).ExecuteUpdateAsync(
            set => set.SetProperty(t => t.LastUsedAt, now), cancellationToken);
    }

    private static string PowerOffMessage(string? outcome) => outcome switch
    {
        PowerOffOutcomes.Off => "TV desligada.",
        PowerOffOutcomes.AlreadyOff => "A TV já estava desligada.",
        _ => "Pedido de desligar enviado.",
    };

    private static string KeyMessage(string code) => code switch
    {
        SiriActions.VolumeUp => "Volume aumentado.",
        SiriActions.VolumeDown => "Volume diminuído.",
        SiriActions.Mute => "Som alternado.",
        _ => "Tecla enviada.",
    };
}

internal static class SiriCommandEndpoint
{
    /// <summary>Mora fora do grupo da TV: o filtro dele exige o JWT de uma sessão, e aqui a credencial é a chave do atalho.</summary>
    public const string Path = "/api/v1/shortcuts/tv";

    public static void MapSiriCommand(this IEndpointRouteBuilder endpoints) =>
        // Pública de propósito (fica na lista de rotas anônimas): quem chama é o app Atalhos, sem sessão. A credencial é a
        // chave no cabeçalho (32 bytes aleatórios, só o hash no banco), e o limite por IP corta tentativa em massa.
        endpoints.MapPost(Path, HandleAsync).AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Siri)
            .Produces<SiriCommandOk>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> HandleAsync(
        HttpContext http, SiriCommandHandler handler, CancellationToken cancellationToken, SiriCommandRequest? request = null)
    {
        var result = await handler.HandleAsync(
            http.Request.Headers[SiriHeaders.Token].ToString(), request, TvHttp.ClientOf(http), cancellationToken);

        return result.Status switch
        {
            SiriStatus.Ran => result.Send is { IsDelivered: true } || result.PowerOutcome is not null
                ? TypedResults.Ok(new SiriCommandOk(true, result.Message ?? "Pronto.", (int)(result.Send?.Latency.TotalMilliseconds ?? 0)))
                : TvProblems.Fail(result.Send!),
            SiriStatus.Unauthorized => Results.Problem(
                statusCode: StatusCodes.Status401Unauthorized, title: "Atalho sem permissão. Gere uma nova chave no app."),
            SiriStatus.Denied => Results.Problem(
                statusCode: StatusCodes.Status403Forbidden, title: "Este atalho não tem permissão para isso."),
            SiriStatus.TvNotFound or SiriStatus.ShortcutNotFound => TypedResults.NotFound(),
            SiriStatus.ShortcutNotInstalled => Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "O app não está mais instalado na TV.",
                type: ProblemDetailsExtensions.TypeBase + TvProblems.ShortcutDisabledType),
            _ => ProblemDetailsExtensions.ValidationProblem(new Dictionary<string, string[]>
            {
                ["action"] = ["Ação inválida. Use power_off, volume_up, volume_down, mute, key ou app."],
            }),
        };
    }
}
