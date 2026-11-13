using System.Globalization;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Features.RemoteCare;
using UniOver.Modules.Devices.Persistence;
using UniOver.Modules.Devices.Security;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>
/// <c>Capabilities</c>: as capacidades <c>pc.*</c> opcionais que o agente declarou (<c>pc.key.v2</c>, <c>pc.text.v2</c>, <c>pc.click.v2</c>...), para a tela
/// esconder o que o PC não entende. Vazio com agente antigo, sem PC ou sem conexão ainda.
/// </summary>
internal sealed record PcStatusResponse(
    bool Available, bool Online, IReadOnlyList<PcApp> Apps, IReadOnlyList<string> Capabilities, PcVolumeState? Volume = null);

/// <summary>O volume de agora do PC, como o agente avisou (<c>pc.volume.state.v1</c>): nível de 0 a 100 e mudo.</summary>
internal sealed record PcVolumeState(int Level, bool Muted);

/// <summary>
/// <c>Seq</c> é opcional: o app numera os pedidos de entrada pela nuvem (movimento, clique, tecla, texto e mídia) em ordem
/// crescente, com um contador só; nos pedidos de clique, tecla, texto e mídia, <c>Epoch</c> (16 hexadecimais sorteados quando a
/// página abre) diz de qual página vem o número (uma página reaberta recomeça a contagem). A API o valida e o repassa apenas a um agente que declarou <c>pc.rtc.v1</c> (o canal
/// direto o usa para separar o que a nuvem entrega tarde, depois da troca de caminho, do que é novo): o esquema desses
/// comandos num agente anterior é fechado e recusaria a mensagem inteira (o touchpad ficaria morto até ele atualizar).
/// </summary>
internal sealed record PcPointerRequest(int? Dx, int? Dy, int? ScrollX, int? ScrollY, int? Seq = null);

/// <summary>
/// <c>Modifiers</c> (Ctrl+clique) e <c>GapMs</c> (o intervalo desde o toque anterior, para o duplo clique) só existem na
/// <c>pc.click.v2</c>, e só valem para <c>CLICK</c> e <c>DOUBLE</c>: segurar o botão (<c>DOWN</c>/<c>UP</c>) nunca leva modificador.
/// </summary>
internal sealed record PcClickRequest(
    string? Button,
    string? Action,
    int? Seq = null,
    string? Epoch = null,
    string[]? Modifiers = null,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? GapMs = null);

/// <summary>
/// <c>Repeat</c> (1 a 50) aperta a tecla várias vezes num pedido só; <c>Action</c> (<c>PRESS</c>, padrão, <c>DOWN</c>, <c>UP</c>)
/// segura e solta um modificador entre toques. Os dois só existem na <c>pc.key.v2</c>.
/// </summary>
/// <remarks>
/// <c>Repeat</c> só é número JSON (nada de texto como "5"): a rota não herda a leitura frouxa de números do resto. <c>Target</c> (na tecla
/// e no texto) é o programa que precisa estar na frente (<c>browser</c>, <c>spotify</c>, <c>vlc</c>): o agente não aperta nada se não estiver.
/// </remarks>
internal sealed record PcKeyRequest(
    string? Key,
    string[]? Modifiers,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Repeat = null,
    string? Action = null,
    int? Seq = null,
    string? Epoch = null,
    string? Target = null);

/// <summary>Soltar um modificador que o app segurou (<c>CTRL</c>, <c>ALT</c>, <c>SHIFT</c> ou <c>WIN</c>).</summary>
internal sealed record PcKeyReleaseRequest(string? Key, int? Seq = null, string? Epoch = null);

/// <summary>
/// <c>Erase</c> (Backspaces) e <c>Key</c> (<c>ENTER</c> ou <c>TAB</c> no fim) só existem na <c>pc.text.v2</c>: o agente apaga, digita e
/// aperta a tecla, nesta ordem, num toque só. <c>Text</c> pode faltar quando um dos outros dois vem.
/// </summary>
internal sealed record PcTextRequest(
    string? Text,
    int? Seq = null,
    string? Epoch = null,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Erase = null,
    string? Key = null,
    string? Target = null);

internal sealed record PcMediaRequest(string? Action, int? Steps, int? Seq = null, string? Epoch = null);

/// <summary>
/// O zoom da pinça (<c>pc.pointer.zoom.v1</c>): <c>Steps</c> cliques de roda com o Ctrl apertado, de -12 a 12 e nunca zero (positivo aproxima).
/// <c>Steps</c> e <c>Seq</c> só são número JSON (nada de texto como "2").
/// </summary>
internal sealed record PcZoomRequest(
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Steps,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Seq = null,
    string? Epoch = null);

/// <summary>
/// O volume absoluto (<c>pc.volume.v1</c>): <c>Level</c> (0 a 100) e/ou <c>Muted</c> (liga ou desliga o mudo, sem alternar); pelo menos um dos dois.
/// <c>Level</c> e <c>Seq</c> só são número JSON.
/// </summary>
internal sealed record PcVolumeRequest(
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Level,
    bool? Muted,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Seq = null,
    string? Epoch = null);

internal sealed record PcPowerRequest(string? Action, bool? Confirm);

/// <summary>Os limites do contrato <c>pc.*</c>: o que a API deixaria passar e o contrato recusar viraria 500 em vez de 400.</summary>
internal static class PcValidator
{
    public const int MaxPointer = 2000;
    public const int MaxScroll = 1200;
    public const int MaxTextLength = 200;
    public const int MaxModifiers = 4;
    public const int MaxClickModifiers = 3;
    public const int MaxSteps = 10;
    public const int MaxKeyRepeat = 50;
    public const int MaxErase = 200;
    public const int MaxGapMs = 400;
    public const int MaxZoomSteps = 12;
    public const int MaxVolumeLevel = 100;
    public const int EpochLength = 16;

    public static Dictionary<string, string[]> Pointer(PcPointerRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        Range(errors, "dx", request?.Dx, MaxPointer, required: true);
        Range(errors, "dy", request?.Dy, MaxPointer, required: true);
        Range(errors, "scrollX", request?.ScrollX, MaxScroll, required: false);
        Range(errors, "scrollY", request?.ScrollY, MaxScroll, required: false);
        CheckSeq(errors, request?.Seq);
        return errors;
    }

    public static Dictionary<string, string[]> Click(PcClickRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        if (request?.Button is null || !PcMessages.Buttons.ContainsKey(request.Button))
        {
            errors["button"] = ["Escolha LEFT, RIGHT ou MIDDLE."];
        }

        if (request?.Action is not null && !PcMessages.ClickActions.ContainsKey(request.Action))
        {
            errors["action"] = ["Escolha CLICK, DOUBLE, DOWN ou UP."];
        }

        var modifiers = request?.Modifiers ?? [];
        if (modifiers.Length > MaxClickModifiers
            || modifiers.Any(m => m is null || !PcMessages.ClickModifiers.ContainsKey(m))
            || modifiers.Distinct(StringComparer.Ordinal).Count() != modifiers.Length)
        {
            errors["modifiers"] = ["Use CTRL, ALT ou SHIFT, sem repetir."];
        }

        if (request?.GapMs is { } gap && (gap < 0 || gap > MaxGapMs))
        {
            errors["gapMs"] = [$"Use de 0 a {MaxGapMs} ms."];
        }

        // Segurar e soltar o botão (o arrastar) nunca leva modificador nem intervalo: um modificador apertado numa ponta e solto na
        // outra seria mais um caminho para a tecla ficar presa.
        if ((modifiers.Length > 0 || request?.GapMs is > 0)
            && request?.Action is not null
            && PcMessages.ClickActions.TryGetValue(request.Action, out var action)
            && action is PcClickV1BodyAction.Down or PcClickV1BodyAction.Up
            && !errors.ContainsKey("action"))
        {
            errors["action"] = ["Modificador e intervalo só valem com CLICK ou DOUBLE."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Key(PcKeyRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        CheckTarget(errors, request?.Target);
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
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        if (request?.Key is null || !PcMessages.HoldableKeys.Contains(request.Key))
        {
            errors["key"] = ["Escolha CTRL, ALT, SHIFT ou WIN."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Text(PcTextRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        CheckTarget(errors, request?.Target);
        var text = request?.Text;
        if (request?.Erase is { } erase && (erase < 0 || erase > MaxErase))
        {
            errors["erase"] = [$"Use de 0 a {MaxErase} caracteres a apagar."];
        }

        if (request?.Key is not null && !PcMessages.TextKeys.ContainsKey(request.Key))
        {
            errors["key"] = ["Escolha ENTER ou TAB."];
        }

        // O texto só pode faltar quando há o que apagar ou uma tecla no fim.
        if (string.IsNullOrEmpty(text))
        {
            if (!errors.ContainsKey("erase") && !errors.ContainsKey("key") && !PcMessages.TextEditsAnything(request))
            {
                errors["text"] = ["Informe o texto a digitar."];
            }
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
        CheckNumbering(errors, request?.Seq, request?.Epoch);
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

    public static Dictionary<string, string[]> Zoom(PcZoomRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        // Zero não é zoom: o contrato o recusa, e a API o barra aqui para o pedido não virar 500.
        if (request?.Steps is not { } steps || steps == 0 || Math.Abs(steps) > MaxZoomSteps)
        {
            errors["steps"] = [$"Use de -{MaxZoomSteps} a {MaxZoomSteps}, sem o zero."];
        }

        return errors;
    }

    public static Dictionary<string, string[]> Volume(PcVolumeRequest? request)
    {
        var errors = new Dictionary<string, string[]>();
        CheckNumbering(errors, request?.Seq, request?.Epoch);
        if (request?.Level is { } level && (level < 0 || level > MaxVolumeLevel))
        {
            errors["level"] = [$"Use de 0 a {MaxVolumeLevel}."];
        }

        // Pelo menos um dos dois: um pedido vazio não faria nada e o contrato o recusa.
        if (request is null || (request.Level is null && request.Muted is null))
        {
            errors["level"] = ["Informe o nível (0 a 100) ou o mudo."];
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

    /// <summary>O número e a época de um pedido de entrada: a época, quando vem, são 16 hexadecimais minúsculos.</summary>
    private static void CheckNumbering(Dictionary<string, string[]> errors, int? seq, string? epoch)
    {
        CheckSeq(errors, seq);
        if (epoch is not null && !IsEpoch(epoch))
        {
            errors["epoch"] = ["Use 16 caracteres hexadecimais minúsculos."];
        }
    }

    /// <summary>O programa que precisa estar na frente, quando vem: um dos que o agente reconhece.</summary>
    private static void CheckTarget(Dictionary<string, string[]> errors, string? target)
    {
        if (target is not null && !PcMessages.Targets.Contains(target))
        {
            errors["target"] = ["Escolha browser, spotify ou vlc."];
        }
    }

    internal static bool IsEpoch(string value) =>
        value.Length == EpochLength && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    private static void CheckSeq(Dictionary<string, string[]> errors, int? seq)
    {
        if (seq is < 0)
        {
            errors["seq"] = ["Use um número inteiro maior ou igual a zero."];
        }
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
internal sealed partial class PcControlHandler(
    PcAgentResolver resolver,
    PcAppsStore apps,
    PcVolumeStore volume,
    IAgentGateway gateway,
    PairingAuditWriter audit,
    DevicesDbContext db,
    TimeProvider time,
    PcOriginReader origins,
    PcDeviceStates deviceStates,
    ILogger<PcControlHandler> logger)
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
            : new PcStatusResponse(true, target.Connected, apps.Get(target.Slug), OptionalCapabilities(target), VolumeOf(target)));
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

        // O agente descarta o movimento de um aparelho não aprovado sem responder (uma resposta por movimento só encheria o canal): quem
        // avisa é ele, com um estado por aparelho (`pc.device.state.v1`, renovado a cada 10 s), e daqui o app recebe o 403 também.
        var origin = origins.Read();
        if (origin.DeviceId is not null && deviceStates.RefusalFor(target.Slug, origin.DeviceId) is { } refusal)
        {
            return PcProblems.DeviceRefused(refusal);
        }

        // O movimento leva o aparelho (a aprovação no PC), mas nunca a operação: é alta taxa e não entra no registro.
        var message = PcMessages.WithOrigin(PcMessages.Pointer(dx, dy, scrollX, scrollY), target.Capabilities, origin, withOperation: false);
        var sent = await gateway.SendAsync(target.Slug, NumberedFor(target, message, request.Seq, null), cancellationToken);
        return sent.IsSuccess ? TypedResults.NoContent() : PcProblems.FromGateway(sent.Error);
    }

    /// <summary>
    /// A mensagem com o <c>seq</c> e a <c>epoch</c> do pedido, se o agente declarou o canal direto (<c>pc.rtc.v1</c>): só ele tem o campo no esquema
    /// (fechado) dos comandos de entrada. Sem número no pedido, ou com agente anterior, a mensagem segue como veio.
    /// </summary>
    private static OutboundMessage NumberedFor(ReadyTarget target, OutboundMessage message, int? seq, string? epoch) =>
        (seq is not null || epoch is not null)
        && target.HelloAt is not null
        && target.Capabilities.Contains(PcMessages.RtcCapability, StringComparer.Ordinal)
            ? PcMessages.WithSeq(message, seq, epoch)
            : message;

    /// <summary>
    /// O volume que o agente avisou, só enquanto ele está conectado e já mandou o <c>hello</c> desta sessão. O que chegou numa sessão
    /// anterior já foi descartado pelo <see cref="PcVolumeStore"/> (queda ou conexão nova): um agente que voltou e ainda não avisou não tem
    /// leitura de agora, e o nível de antes seria mentira. Nulo sem leitura (ou agente anterior ao volume).
    /// </summary>
    private PcVolumeState? VolumeOf(PcTarget target) => target.Connected && target.HelloAt is not null ? volume.Get(target.Slug) : null;

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
        string? requiredCapability = null,
        int? seq = null,
        string? epoch = null,
        string? focus = null)
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

        // O programa que precisa estar na frente: só um agente que o confere recebe o campo. Para um anterior o pedido é recusado (e não
        // mandado sem o campo), pois a tecla iria para a janela que estivesse na frente.
        if (focus is not null && CapabilityProblem(target, PcMessages.TargetCapability) is { } focusProblem)
        {
            return focusProblem;
        }

        var focused = focus is null ? message : PcMessages.WithTarget(message, focus);
        var origin = origins.Read();
        var outbound = PcMessages.WithOrigin(NumberedFor(target, focused, seq, epoch), target.Capabilities, origin, withOperation: true);
        var started = time.GetTimestamp();
        var reply = await gateway.RequestAsync(target.Slug, outbound, timeout, cancellationToken);
        var elapsedMs = (long)time.GetElapsedTime(started).TotalMilliseconds;
        var outcome = OutcomeOf(reply);
        LogOperation(origin.OperationId, message.Type, "nuvem", elapsedMs, outcome);
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
            // O dono não aprovou este aparelho no PC (ainda ou nunca): 403 claro, e não "o agente não conseguiu".
            return PcProblems.IsDeviceRefusal(reply.Value.Error?.Code)
                ? PcProblems.DeviceRefused(reply.Value.Error!.Code)
                : RemoteCareProblems.CommandFailed(reply.Value.Error?.Code);
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

    /// <summary>O resultado em texto fixo para o registro: nunca o texto livre do agente, só o código estável dele.</summary>
    private static string OutcomeOf(UniOver.SharedKernel.Result<AgentReply> reply) =>
        reply.IsFailure
            ? reply.Error.Code
            : reply.Value.Ok ? "ok" : reply.Value.Error?.Code ?? "falhou";

    /// <summary>
    /// Uma linha por comando do PC que não é movimento: a operação (o <c>X-Operation-Id</c> do pedido, o mesmo que o agente registra), o tipo, o
    /// caminho, quanto levou até o resultado e como terminou. Nunca o texto, as teclas nem as coordenadas.
    /// </summary>
    [LoggerMessage(Level = LogLevel.Information, Message = "Operação {OperationId}: {Type} via {Path}; {ElapsedMs} ms; resultado {Outcome}.")]
    private partial void LogOperation(string operationId, string type, string path, long elapsedMs, string outcome);

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

        // O zoom da pinça e o volume absoluto: o balde das entradas (cliques, teclas, texto, mídia), como a mídia.
        group.MapPost("/zoom", ZoomAsync)
            .RequireAuthorization(ModulePolicy)
            .RequireRateLimiting(RateLimitPolicies.PcInput)
            .WithCommonProblems();

        group.MapPost("/volume", VolumeAsync)
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
            .ProducesProblem(StatusCodes.Status403Forbidden)
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

        // A v1 sempre que o pedido cabe nela; a v2 só com modificador ou intervalo, e só para o agente que a declarou.
        return await handler.RunAsync(
            userId,
            PcMessages.ClickFor(request!),
            PcControlHandler.CommandTimeout,
            null,
            ClientInfo.From(http),
            cancellationToken,
            PcMessages.ClickFitsV1(request!) ? null : PcMessages.ClickV2Capability,
            request!.Seq,
            request.Epoch);
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
            PcMessages.KeyFitsV1(request!) ? null : PcMessages.KeyV2Capability,
            request!.Seq,
            request.Epoch,
            request.Target);

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
                PcMessages.KeyV2Capability,
                request.Seq,
                request.Epoch);
    }

    private static async Task<IResult> TextAsync(
        PcTextRequest? request,
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

        var errors = PcValidator.Text(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        // Cada Backspace e a tecla do fim são apertos: contam no mesmo teto das teclas (o texto puro, como sempre, não paga).
        var cost = PcMessages.TextPresses(request!);
        if (cost > 0 && !budget.TryTake(userId, cost))
        {
            return PcProblems.KeyBudgetExceeded();
        }

        // A v1 para o texto puro; a v2 só com apagar ou tecla no fim, e só para o agente que a declarou.
        var result = await handler.RunAsync(
            userId,
            PcMessages.TextFor(request!),
            PcControlHandler.CommandTimeout,
            null,
            ClientInfo.From(http),
            cancellationToken,
            PcMessages.TextFitsV1(request!) ? null : PcMessages.TextV2Capability,
            request!.Seq,
            request.Epoch,
            request.Target);

        // O teto conta o que saiu: sem PC (409) ou sem sessão para entregar (503), nada foi enviado e o gasto volta.
        if (cost > 0 && result is IStatusCodeHttpResult { StatusCode: StatusCodes.Status409Conflict or StatusCodes.Status503ServiceUnavailable })
        {
            budget.Refund(userId, cost);
        }

        return result;
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
                cancellationToken,
                seq: request.Seq,
                epoch: request.Epoch);
    }

    private static async Task<IResult> ZoomAsync(
        PcZoomRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Zoom(request);
        // Mensagem nova, sem v1: só o agente que declarou a capacidade a recebe (409 pc-key-unsupported para os outros).
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.RunAsync(
                userId,
                PcMessages.Zoom(request!.Steps!.Value),
                PcControlHandler.CommandTimeout,
                null,
                ClientInfo.From(http),
                cancellationToken,
                PcMessages.ZoomCapability,
                request.Seq,
                request.Epoch);
    }

    private static async Task<IResult> VolumeAsync(
        PcVolumeRequest? request, ICurrentUser current, HttpContext http, PcControlHandler handler, CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return RemoteCareProblems.Unauthenticated();
        }

        var errors = PcValidator.Volume(request);
        return errors.Count > 0
            ? ProblemDetailsExtensions.ValidationProblem(errors)
            : await handler.RunAsync(
                userId,
                PcMessages.Volume(request!.Level, request.Muted),
                PcControlHandler.CommandTimeout,
                null,
                ClientInfo.From(http),
                cancellationToken,
                PcMessages.VolumeCapability,
                request.Seq,
                request.Epoch);
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
