using System.Globalization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

internal sealed record PcStatusResponse(bool Available, bool Online, IReadOnlyList<PcApp> Apps);

internal sealed record PcPointerRequest(int? Dx, int? Dy, int? ScrollX, int? ScrollY);

internal sealed record PcClickRequest(string? Button, string? Action);

internal sealed record PcKeyRequest(string? Key, string[]? Modifiers);

internal sealed record PcTextRequest(string? Text);

internal sealed record PcMediaRequest(string? Action, int? Steps);

internal sealed record PcPowerRequest(string? Action, bool? Confirm);

/// <summary>Os limites do contrato <c>pc.*</c>: o que a API deixaria passar e o contrato recusar viraria 500 em vez de 400.</summary>
internal static class PcValidator
{
    public const int MaxPointer = 2000;
    public const int MaxScroll = 1200;
    public const int MaxTextLength = 200;
    public const int MaxModifiers = 4;
    public const int MaxSteps = 10;

    public static Dictionary<string, string[]> Pointer(PcPointerRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        Range(errors, "dx", request?.Dx, MaxPointer, required: true);
        Range(errors, "dy", request?.Dy, MaxPointer, required: true);
        Range(errors, "scrollX", request?.ScrollX, MaxScroll, required: false);
        Range(errors, "scrollY", request?.ScrollY, MaxScroll, required: false);
        return errors;
    }

    public static Dictionary<string, string[]> Click(PcClickRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Button is null || !PcMessages.Buttons.ContainsKey(request.Button))
        {
            errors["button"] = ["Escolha LEFT, RIGHT ou MIDDLE."];
        }

        if (request?.Action is not null && !PcMessages.ClickActions.ContainsKey(request.Action))
        {
            errors["action"] = ["Escolha CLICK, DOUBLE, DOWN ou UP."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Key(PcKeyRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Key is null || !PcMessages.Keys.ContainsKey(request.Key))
        {
            errors["key"] = ["Escolha uma tecla da lista."];
        }

        var modifiers = request?.Modifiers ?? [];
        if (modifiers.Length > MaxModifiers
            || modifiers.Any(m => m is null || !PcMessages.Modifiers.ContainsKey(m))
            || modifiers.Distinct(StringComparer.Ordinal).Count() != modifiers.Length)
        {
            errors["modifiers"] = ["Use CTRL, ALT, SHIFT ou WIN, sem repetir."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Text(PcTextRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        var text = request?.Text;
        if (string.IsNullOrEmpty(text))
        {
            errors["text"] = ["Informe o texto a digitar."];
        }
        else if (text.EnumerateRunes().Count() > MaxTextLength)
        {
            errors["text"] = [$"O texto deve ter no máximo {MaxTextLength} caracteres."];
        }
        else if (text.Any(IsControl))
        {
            errors["text"] = ["O texto não pode ter quebra de linha nem outros caracteres de controle."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Media(PcMediaRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Action is null || !PcMessages.MediaActions.ContainsKey(request.Action))
        {
            errors["action"] = ["Escolha uma ação de mídia da lista."];
        }

        if (request?.Steps is { } steps && (steps < 1 || steps > MaxSteps))
        {
            errors["steps"] = [$"Use de 1 a {MaxSteps} passos."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Power(PcPowerRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Action is null || !PcMessages.PowerActions.TryGetValue(request.Action, out var action))
        {
            errors["action"] = ["Escolha LOCK, SLEEP, SHUTDOWN ou CANCEL_SHUTDOWN."];
        }
        else if (action is PcPowerV1BodyAction.Sleep or PcPowerV1BodyAction.Shutdown && request.Confirm != true)
        {
            // Suspender e desligar derrubam a conexão com o PC: sem a confirmação explícita nada é enviado.
            errors["confirm"] = ["Confirme para suspender ou desligar o PC."];
        }

        return errors;
    }

    private static void Range(Dictionary<string, string[]> errors, string field, int? value, int limit, bool required)
    {
        if (value is null)
        {
            if (required)
            {
                errors[field] = ["Informe um número inteiro."];
            }
        }
        else if (value < -limit || value > limit)
        {
            errors[field] = [string.Create(CultureInfo.InvariantCulture, $"Use de -{limit} a {limit}.")];
        }
    }

    private static bool IsControl(char c) => c <= '\u001f' || (c >= '\u007f' && c <= '\u009f');
}

/// <summary>
/// O caminho comum dos comandos do PC: acha o computador, entrega, e deixa a linha de auditoria dos que mexem na energia
/// ou abrem programas (só depois de o agente confirmar, como na manutenção remota: pedido recusado não mudou nada). O
/// movimento do mouse e as teclas não entram na trilha: seriam milhares de linhas sem valor, e o texto pode ser senha.
/// </summary>
internal sealed class PcControlHandler(
    PcAgentResolver resolver,
    PcAppsStore apps,
    IAgentGateway gateway,
    PairingAuditWriter audit,
    DevicesDbContext db)
{
    /// <summary>O agente só executa uma chamada de sistema e responde.</summary>
    public static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Bloquear e agendar o desligamento chamam programas do Windows: um pouco mais de folga.</summary>
    public static readonly TimeSpan PowerTimeout = TimeSpan.FromSeconds(10);

    public async Task<IResult> StatusAsync(Guid userId, CancellationToken cancellationToken)
    {
        var target = await resolver.ResolveAsync(userId, cancellationToken);
        return TypedResults.Ok(target is null
            ? new PcStatusResponse(false, false, [])
            : new PcStatusResponse(true, target.Connected, apps.Get(target.Slug)));
    }

    /// <summary>Movimento do mouse: sem esperar resposta (a próxima mensagem já está a caminho) e sem auditoria.</summary>
    public async Task<IResult> PointerAsync(Guid userId, PcPointerRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var (dx, dy, scrollX, scrollY) = (request.Dx!.Value, request.Dy!.Value, request.ScrollX ?? 0, request.ScrollY ?? 0);
        if (dx == 0 && dy == 0 && scrollX == 0 && scrollY == 0)
        {
            return TypedResults.NoContent();
        }

        var target = await ReadyTargetAsync(userId, cancellationToken);
        if (target.Failure is not null)
        {
            return target.Failure;
        }

        var sent = await gateway.SendAsync(target.Slug, PcMessages.Pointer(dx, dy, scrollX, scrollY), cancellationToken);
        return sent.IsSuccess ? TypedResults.NoContent() : RemoteCareProblems.FromGateway(sent.Error);
    }

    public async Task<IResult> RunAsync(
        Guid userId,
        OutboundMessage message,
        TimeSpan timeout,
        string? auditEvent,
        ClientInfo client,
        CancellationToken cancellationToken)
    {
        var target = await ReadyTargetAsync(userId, cancellationToken);
        if (target.Failure is not null)
        {
            return target.Failure;
        }

        var reply = await gateway.RequestAsync(target.Slug, message, timeout, cancellationToken);
        if (reply.IsFailure)
        {
            return RemoteCareProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            return RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        if (auditEvent is not null)
        {
            audit.Add(auditEvent, client, agentId: target.AgentId, userId: userId);
            await db.SaveChangesAsync(cancellationToken);
        }

        return TypedResults.NoContent();
    }

    public async Task<IResult> LaunchAsync(
        Guid userId, string appId, ClientInfo client, CancellationToken cancellationToken)
    {
        var target = await ReadyTargetAsync(userId, cancellationToken);
        if (target.Failure is not null)
        {
            return target.Failure;
        }

        // Só abre o que o próprio PC anunciou: um identificador inventado nem chega ao agente.
        if (!apps.Get(target.Slug).Any(a => string.Equals(a.Id, appId, StringComparison.Ordinal)))
        {
            return TypedResults.NotFound();
        }

        return await RunAsync(userId, PcMessages.AppLaunch(appId), CommandTimeout, PairingEvents.PcAppLaunch, client, cancellationToken);
    }

    private async Task<ReadyTarget> ReadyTargetAsync(Guid userId, CancellationToken cancellationToken)
    {
        var target = await resolver.ResolveAsync(userId, cancellationToken);
        if (target is null)
        {
            return new ReadyTarget(Guid.Empty, string.Empty, PcProblems.Unavailable());
        }

        return target.Connected
            ? new ReadyTarget(target.AgentId, target.Slug, null)
            : new ReadyTarget(target.AgentId, target.Slug, RemoteCareProblems.Offline());
    }

    private readonly record struct ReadyTarget(Guid AgentId, string Slug, IResult? Failure);
}

internal static class PcControlEndpoints
{
    private static readonly string ModulePolicy = AccessPermissions.Policy(AccessPermissions.PcModule);

    /// <summary>Mapeia as rotas do controle do PC em <c>/api/v1/pc</c>. Todas pedem a permissão <c>module:pc</c> (o dono tem todas).</summary>
    public static void MapPcControl(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/pc");

        group.MapGet("/status", StatusAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<PcStatusResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/pointer", PointerAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcPointer)
            .WithCommonProblems();

        group.MapPost("/click", ClickAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .WithCommonProblems();

        group.MapPost("/key", KeyAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .WithCommonProblems();

        group.MapPost("/text", TextAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .WithCommonProblems();

        group.MapPost("/media", MediaAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .WithCommonProblems();

        group.MapPost("/power", PowerAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcPower)
            .WithCommonProblems();

        group.MapPost("/apps/{appId}/launch", LaunchAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcPower)
            .WithCommonProblems();
    }

    private static RouteHandlerBuilder WithCommonProblems(this RouteHandlerBuilder builder) =>
        builder
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static Task<IResult> StatusAsync(ICurrentUser current, PcControlHandler handler, CancellationToken cancellationToken) =>
        current.UserId is { } userId
            ? handler.StatusAsync(userId, cancellationToken)
            : Task.FromResult(RemoteCareProblems.Unauthenticated());

    private static async Task<IResult> PointerAsync(
        PcPointerRequest? request, ICurrentUser current, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Pointer(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.PointerAsync(userId, request!, cancellationToken);
    }

    private static async Task<IResult> ClickAsync(
        PcClickRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Click(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var action = request!.Action is null ? PcClickV1BodyAction.Click : PcMessages.ClickActions[request.Action];
        return await handler.RunAsync(
            userId, PcMessages.Click(PcMessages.Buttons[request.Button!], action), PcControlHandler.CommandTimeout, null, ClientInfo.From(http), cancellationToken);
    }

    private static async Task<IResult> KeyAsync(
        PcKeyRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Key(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var modifiers = (request!.Modifiers ?? []).Select(m => PcMessages.Modifiers[m]).ToList();
        return await handler.RunAsync(
            userId, PcMessages.Key(PcMessages.Keys[request.Key!], modifiers), PcControlHandler.CommandTimeout, null, ClientInfo.From(http), cancellationToken);
    }

    private static async Task<IResult> TextAsync(
        PcTextRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Text(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.RunAsync(
                userId, PcMessages.Text(request!.Text!), PcControlHandler.CommandTimeout, null, ClientInfo.From(http), cancellationToken);
    }

    private static async Task<IResult> MediaAsync(
        PcMediaRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Media(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.RunAsync(
                userId,
                PcMessages.Media(PcMessages.MediaActions[request!.Action!], request.Steps ?? 1),
                PcControlHandler.CommandTimeout,
                null,
                ClientInfo.From(http),
                cancellationToken);
    }

    private static async Task<IResult> PowerAsync(
        PcPowerRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Power(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var action = PcMessages.PowerActions[request!.Action!];
        var auditEvent = action switch
        {
            PcPowerV1BodyAction.Lock => PairingEvents.PcLock,
            PcPowerV1BodyAction.Sleep => PairingEvents.PcSleep,
            PcPowerV1BodyAction.Shutdown => PairingEvents.PcShutdown,
            _ => PairingEvents.PcShutdownCancelled,
        };
        return await handler.RunAsync(
            userId, PcMessages.Power(action), PcControlHandler.PowerTimeout, auditEvent, ClientInfo.From(http), cancellationToken);
    }

    private static async Task<IResult> LaunchAsync(
        string appId, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        return await handler.LaunchAsync(userId, appId, ClientInfo.From(http), cancellationToken);
    }
}
