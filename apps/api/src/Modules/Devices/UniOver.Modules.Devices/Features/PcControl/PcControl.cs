using System.Globalization;
using System.Text.Json.Serialization;
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

/// <summary>
/// <c>Capabilities</c>: as capacidades <c>pc.*</c> opcionais que o agente declarou (hoje <c>pc.key.v2</c>), para a tela
/// esconder o que o PC não entende. Vazio com agente antigo, sem PC ou sem conexão ainda.
/// </summary>
internal sealed record PcStatusResponse(bool Available, bool Online, IReadOnlyList<PcApp> Apps, IReadOnlyList<string> Capabilities);

/// <summary>
/// <c>Seq</c> é opcional: o app numera os pedidos de movimento em ordem crescente (diagnóstico). A API o aceita e o valida,
/// mas NÃO o repassa ao agente: o esquema do <c>pc.pointer.v1</c> de um agente anterior é fechado e recusaria a mensagem
/// inteira (o touchpad ficaria morto até ele atualizar). Quando a API passar a listar uma capacidade do agente para isso,
/// o repasse volta, condicionado a ela.
/// </summary>
internal sealed record PcPointerRequest(int? Dx, int? Dy, int? ScrollX, int? ScrollY, int? Seq = null);

internal sealed record PcClickRequest(string? Button, string? Action);

/// <summary>
/// <c>Repeat</c> (1 a 50) aperta a tecla várias vezes num pedido só; <c>Action</c> (<c>PRESS</c>, padrão, <c>DOWN</c>, <c>UP</c>)
/// segura e solta um modificador entre toques. Os dois só existem na <c>pc.key.v2</c>.
/// </summary>
/// <remarks><c>Repeat</c> só é número JSON (nada de texto como "5"): a rota não herda a leitura frouxa de números do resto.</remarks>
internal sealed record PcKeyRequest(
    string? Key,
    string[]? Modifiers,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Repeat = null,
    string? Action = null);

/// <summary>Soltar um modificador que o app segurou (<c>CTRL</c>, <c>ALT</c>, <c>SHIFT</c> ou <c>WIN</c>).</summary>
internal sealed record PcKeyReleaseRequest(string? Key);

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
    public const int MaxKeyRepeat = 50;

    public static Dictionary<string, string[]> Pointer(PcPointerRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        Range(errors, "dx", request?.Dx, MaxPointer, required: true);
        Range(errors, "dy", request?.Dy, MaxPointer, required: true);
        Range(errors, "scrollX", request?.ScrollX, MaxScroll, required: false);
        Range(errors, "scrollY", request?.ScrollY, MaxScroll, required: false);
        if (request?.Seq is < 0)
        {
            errors["seq"] = ["Use um número inteiro maior ou igual a zero."];
        }

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
        if (request?.Key is null || !PcMessages.KeysV2.ContainsKey(request.Key))
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

        if (request?.Repeat is { } repeat && (repeat < 1 || repeat > MaxKeyRepeat))
        {
            errors["repeat"] = [$"Use de 1 a {MaxKeyRepeat} repetições."];
        }

        if (request?.Action is not null)
        {
            if (!PcMessages.KeyActions.TryGetValue(request.Action, out var action))
            {
                errors["action"] = ["Escolha PRESS, DOWN ou UP."];
            }
            else if (action != PcKeyV2BodyAction.Press)
            {
                // Segurar e soltar só valem para os modificadores, sozinhos: o agente nunca prende uma letra.
                if (request.Key is not null && !PcMessages.HoldableKeys.Contains(request.Key))
                {
                    errors["action"] = ["Só dá para segurar ou soltar CTRL, ALT, SHIFT ou WIN."];
                }

                if (modifiers.Length > 0 && !errors.ContainsKey("modifiers"))
                {
                    errors["modifiers"] = ["Ao segurar ou soltar uma tecla, não use modificadores."];
                }

                if (request.Repeat is > 1 && !errors.ContainsKey("repeat"))
                {
                    errors["repeat"] = ["Ao segurar ou soltar uma tecla, não repita."];
                }
            }
        }

        return errors;
    }

    public static Dictionary<string, string[]> KeyRelease(PcKeyReleaseRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        if (request?.Key is null || !PcMessages.HoldableKeys.Contains(request.Key))
        {
            errors["key"] = ["Escolha CTRL, ALT, SHIFT ou WIN."];
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
/// ou abrem programas: uma linha de sucesso depois de o agente confirmar e, se ele recusar, falhar ou não responder a
/// tempo (pode ter agido mesmo assim), uma linha de tentativa que não deu certo. Sem sessão viva nada foi enviado e nada
/// é gravado. O movimento do mouse e as teclas não entram na trilha: seriam milhares de linhas sem valor, e o texto pode
/// ser senha (a linha de auditoria nem tem campo para ele). Nenhum comando espera o agente voltar de uma queda: sem
/// sessão viva agora, o pedido falha na hora e volta como "reconectando" (ver <see cref="AgentDelivery.Immediate"/> em
/// <see cref="PcMessages"/>). Isso não cobre a sessão meio aberta (o socket já morto que a API ainda não notou), que pode
/// entregar com atraso: quem descarta o <c>pc.*</c> velho, pela idade, é o agente (outra frente).
/// </summary>
internal sealed class PcControlHandler(
    PcAgentResolver resolver,
    PcAppsStore apps,
    IAgentGateway gateway,
    PairingAuditWriter audit,
    DevicesDbContext db,
    TimeProvider time)
{
    /// <summary>
    /// Quanto tempo depois do <c>hello</c> a falta de uma capacidade ainda pode ser só o agente acabando de subir: ele manda um
    /// segundo <c>hello</c> assim que a API lista a capacidade nova. Antes disso o pedido volta como "tente de novo", e não
    /// como "atualize o agente".
    /// </summary>
    public static readonly TimeSpan CapabilitySettle = TimeSpan.FromSeconds(10);

    /// <summary>O agente só executa uma chamada de sistema e responde.</summary>
    public static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Bloquear e agendar o desligamento chamam programas do Windows: um pouco mais de folga.</summary>
    public static readonly TimeSpan PowerTimeout = TimeSpan.FromSeconds(10);

    public async Task<IResult> StatusAsync(Guid userId, CancellationToken cancellationToken)
    {
        var target = await resolver.ResolveAsync(userId, cancellationToken);
        return TypedResults.Ok(target is null
            ? new PcStatusResponse(false, false, [], [])
            : new PcStatusResponse(true, target.Connected, apps.Get(target.Slug), OptionalCapabilities(target)));
    }

    /// <summary>
    /// Movimento do mouse: não espera nada, nem a resposta do agente (a próxima mensagem já está a caminho) nem a volta dele de
    /// uma queda (sem sessão agora falha na hora, e a tela descarta o movimento pendente), e não entra na auditoria.
    /// Movimento zero é repassado como qualquer outro (é o sinal de vida que a tela manda com o botão apertado).
    /// </summary>
    public async Task<IResult> PointerAsync(Guid userId, PcPointerRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        // O movimento zero também segue: a tela o manda a cada ~10 s enquanto um botão está apertado, e é ele que mantém
        // vivo o temporizador de soltura do agente.
        var (dx, dy, scrollX, scrollY) = (request.Dx!.Value, request.Dy!.Value, request.ScrollX ?? 0, request.ScrollY ?? 0);

        var target = await ReadyTargetAsync(userId, cancellationToken);
        if (target.Failure is not null)
        {
            return target.Failure;
        }

        var sent = await gateway.SendAsync(target.Slug, PcMessages.Pointer(dx, dy, scrollX, scrollY), cancellationToken);
        return sent.IsSuccess ? TypedResults.NoContent() : PcProblems.FromGateway(sent.Error);
    }

    /// <summary>As capacidades <c>pc.*</c> além da base (<see cref="PcMessages.Capability"/>), na ordem em que o agente as declarou.</summary>
    private static IReadOnlyList<string> OptionalCapabilities(PcTarget target) =>
        target.HelloAt is null
            ? []
            : [.. target.Capabilities.Where(c => c.StartsWith("pc.", StringComparison.Ordinal) && c != PcMessages.Capability)];

    /// <summary>
    /// <paramref name="requiredCapability"/>: a capacidade que o agente precisa ter declarado para entender a mensagem (a v2 de
    /// uma tecla). Sem ela nada é enviado e o pedido volta como 409 <c>pc-key-unsupported</c>; PC ausente e desconectado
    /// continuam sendo a resposta de antes.
    /// </summary>
    public async Task<IResult> RunAsync(
        Guid userId,
        OutboundMessage message,
        TimeSpan timeout,
        string? auditEvent,
        ClientInfo client,
        CancellationToken cancellationToken,
        string? requiredCapability = null)
    {
        var target = await ReadyTargetAsync(userId, cancellationToken);
        if (target.Failure is not null)
        {
            return target.Failure;
        }

        if (requiredCapability is not null && CapabilityProblem(target, requiredCapability) is { } problem)
        {
            return problem;
        }

        var reply = await gateway.RequestAsync(target.Slug, message, timeout, cancellationToken);
        if (reply.IsFailure)
        {
            // Sem resposta no prazo o comando já estava com o agente e pode ter sido executado: fica na trilha. Sem sessão
            // para entregar (nada saiu) e mensagem recusada pelo contrato (nunca saiu daqui) não deixam linha. Limite
            // conhecido: se o socket cai depois da entrega e antes da resposta, o gateway também diz "offline" e a
            // tentativa fica sem linha.
            if (reply.Error.Code == AgentErrors.TimeoutCode)
            {
                await AuditFailedAttemptAsync(auditEvent, client, target.AgentId, userId, cancellationToken);
            }

            return PcProblems.FromGateway(reply.Error);
        }

        if (!reply.Value.Ok)
        {
            await AuditFailedAttemptAsync(auditEvent, client, target.AgentId, userId, cancellationToken);
            return RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
        }

        if (auditEvent is not null)
        {
            audit.Add(auditEvent, client, agentId: target.AgentId, userId: userId);
            await db.SaveChangesAsync(cancellationToken);
        }

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Se o agente não puder receber a mensagem que precisa de <paramref name="capability"/>: sem o <c>hello</c> da sessão de
    /// agora (queda recente, API reiniciada) nada se sabe, e a resposta é "reconectando"; com o <c>hello</c> sem a capacidade,
    /// "atualize o agente" só depois de <see cref="CapabilitySettle"/>, pois antes pode ser um agente novo ainda declarando.
    /// </summary>
    private IResult? CapabilityProblem(ReadyTarget target, string capability)
    {
        if (target.HelloAt is not { } helloAt)
        {
            return PcProblems.Reconnecting();
        }

        if (target.Capabilities.Contains(capability, StringComparer.Ordinal))
        {
            return null;
        }

        return time.GetUtcNow() - helloAt < CapabilitySettle ? PcProblems.Reconnecting() : PcProblems.KeyUnsupported();
    }

    /// <summary>Grava a tentativa que o agente recusou ou deixou sem resposta; só as ações auditadas têm linha.</summary>
    private async Task AuditFailedAttemptAsync(
        string? auditEvent, ClientInfo client, Guid agentId, Guid userId, CancellationToken cancellationToken)
    {
        if (auditEvent is null || PairingEvents.PcFailureOf(auditEvent) is not { } failedEvent)
        {
            return;
        }

        audit.Add(failedEvent, client, agentId: agentId, userId: userId);
        await db.SaveChangesAsync(cancellationToken);
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
            return new ReadyTarget(Guid.Empty, string.Empty, [], null, PcProblems.Unavailable());
        }

        return target.Connected
            ? new ReadyTarget(target.AgentId, target.Slug, target.Capabilities, target.HelloAt, null)
            : new ReadyTarget(target.AgentId, target.Slug, target.Capabilities, target.HelloAt, RemoteCareProblems.Offline());
    }

    private readonly record struct ReadyTarget(
        Guid AgentId, string Slug, IReadOnlyList<string> Capabilities, DateTimeOffset? HelloAt, IResult? Failure);
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
            .RequireRateLimiting(RateLimitPolicies.PcInput)
            .WithCommonProblems();

        group.MapPost("/key", KeyAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcInput)
            .WithCommonProblems();

        // Soltar um modificador segurado: balde próprio, para a soltura nunca esperar na fila dos apertos (um 429 aqui
        // deixaria o Alt preso até o agente soltar sozinho, 30 s depois).
        group.MapPost("/key/release", KeyReleaseAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcKeyRelease)
            .WithCommonProblems();

        group.MapPost("/text", TextAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcInput)
            .WithCommonProblems();

        group.MapPost("/media", MediaAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcInput)
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
        PcKeyRequest? request,
        ICurrentUser current,
        HttpContext http,
        PcControlHandler handler,
        PcKeyBudget budget,
        CancellationToken cancellationToken)
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

        // Cada repetição é um aperto: o limite de pedidos do `pc-input` conta um por pedido. Soltar não paga.
        var isUp = request!.Action is not null && PcMessages.KeyActions[request.Action] == PcKeyV2BodyAction.Up;
        var cost = isUp ? 0 : Math.Max(1, request.Repeat ?? 1);
        if (cost > 0 && !budget.TryTake(userId, cost))
        {
            return PcProblems.KeyBudgetExceeded();
        }

        // A v1 sempre que o pedido cabe nela; a v2 só para o que ela diz, e só para o agente que a declarou.
        var result = await handler.RunAsync(
            userId,
            PcMessages.KeyFor(request!),
            PcControlHandler.CommandTimeout,
            null,
            ClientInfo.From(http),
            cancellationToken,
            PcMessages.KeyFitsV1(request!) ? null : PcMessages.KeyV2Capability);

        // O teto conta o que saiu: sem PC (409) ou sem sessão para entregar (503), nada foi enviado e o gasto volta.
        if (cost > 0 && result is IStatusCodeHttpResult { StatusCode: StatusCodes.Status409Conflict or StatusCodes.Status503ServiceUnavailable })
        {
            budget.Refund(userId, cost);
        }

        return result;
    }

    private static async Task<IResult> KeyReleaseAsync(
        PcKeyReleaseRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.KeyRelease(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.RunAsync(
                userId,
                PcMessages.KeyFor(new PcKeyRequest(request!.Key, null, null, "UP")),
                PcControlHandler.CommandTimeout,
                null,
                ClientInfo.From(http),
                cancellationToken,
                PcMessages.KeyV2Capability);
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
