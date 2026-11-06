using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Devices.Persistence;

namespace UniOver.Modules.Devices.Features.Beacons;

/// <summary>Os limites da baliza de partida. Curtos de propósito: a rota é anônima e grava no banco.</summary>
internal static class BeaconLimits
{
    /// <summary>Tamanho máximo do corpo; o que passar disso é descartado sem ser lido.</summary>
    public const int MaxBodyBytes = 512;

    /// <summary>A mesma etapa e o mesmo código dentro desta janela não gravam de novo.</summary>
    public static readonly TimeSpan RepeatWindow = TimeSpan.FromMinutes(5);

    /// <summary>Quantas balizas por minuto a API aceita de um mesmo agente; o excedente é descartado em silêncio.</summary>
    public const int PerAgentPerMinute = 12;

    /// <summary>Um handshake recusado é anotado, no máximo, uma vez neste intervalo por agente.</summary>
    public static readonly TimeSpan RejectionInterval = TimeSpan.FromMinutes(1);

    public static readonly TimeSpan Window = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Teto da API inteira para as balizas anônimas por minuto. O limite por IP não segura quem troca de endereço (um /64 de IPv6
    /// inteiro) nem o proxy sem IP real; este segura, e o excedente é descartado antes de qualquer consulta.
    /// </summary>
    public const int GlobalBeaconsPerMinute = 120;

    /// <summary>
    /// Teto da API inteira para as anotações de recusa por minuto, em balde à parte: uma enxurrada de balizas não cega as recusas, e a
    /// recusa já é limitada antes pelo teto de tokens inválidos por origem.
    /// </summary>
    public const int GlobalRejectionsPerMinute = 60;

    /// <summary>Quanto tempo um slug que não existe fica lembrado como inexistente (a repetição do mesmo palpite não volta ao banco).</summary>
    public static readonly TimeSpan MissingSlugMemory = TimeSpan.FromMinutes(1);

    /// <summary>Quantos slugs inexistentes a memória guarda; passou disso, esquece tudo (o tamanho não cresce com o abuso).</summary>
    public const int MissingSlugCapacity = 1000;
}

/// <summary>Os motivos de recusa do handshake que a API anota: códigos fixos, nunca texto do cliente nem pedaço de credencial.</summary>
internal static class BeaconRejection
{
    /// <summary>O token não corresponde a nenhum agente.</summary>
    public const string InvalidToken = "invalid_token";

    /// <summary>O token é de outro agente (o do caminho da conexão não é o dele).</summary>
    public const string WrongAgent = "wrong_agent";

    /// <summary>O <c>hello</c> do agente não cumpriu o contrato (versão do protocolo ou forma da mensagem).</summary>
    public const string Protocol = "protocol";
}

/// <summary>O corpo da baliza, como o agente o manda. Só descreve o contrato: a leitura é feita à mão (ver <see cref="AgentBeaconParser"/>).</summary>
/// <param name="V">Versão do formato (1).</param>
/// <param name="Stage">Etapa da partida (<c>bootstrap</c>, <c>supervisor</c>, <c>child_spawn</c>...).</param>
/// <param name="Code">Resultado (<c>ok</c>, <c>no_config</c>, <c>crash_loop</c>...).</param>
/// <param name="Ver">Versão do agente.</param>
/// <param name="Os">Sistema do PC.</param>
/// <param name="N">Quantas vezes o agente já partiu (ignorado pela API).</param>
/// <remarks>Qualquer outro campo (como um texto livre de detalhe) é ignorado: a API só guarda o que a tela mostra.</remarks>
internal sealed record AgentBeaconBody(int? V, string? Stage, string? Code, string? Ver, string? Os, int? N);

/// <summary>Uma baliza já conferida, pronta para gravar.</summary>
internal sealed record BeaconInput(string Stage, string Code, string? Version, string? Os);

/// <summary>
/// Leitura defensiva do corpo da baliza. Nada aqui lança: o que não serve vira <c>null</c> e a rota responde 204 do mesmo jeito,
/// para quem manda não descobrir nada pela resposta.
/// </summary>
internal static partial class AgentBeaconParser
{
    [GeneratedRegex("^[a-z][a-z0-9_]{1,31}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex NamePattern();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex VersionPattern();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._ -]{0,23}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 200)]
    private static partial Regex OsPattern();

    public static BeaconInput? Parse(ReadOnlySpan<byte> body)
    {
        if (body.IsEmpty || body.Length > BeaconLimits.MaxBodyBytes)
        {
            return null;
        }

        try
        {
            var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = 4 });
            using var document = JsonDocument.ParseValue(ref reader);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var stage = Text(root, "stage");
            var code = Text(root, "code");
            if (stage is null || code is null || !NamePattern().IsMatch(stage) || !NamePattern().IsMatch(code))
            {
                return null;
            }

            var version = Text(root, "ver");
            var os = Text(root, "os");
            return new BeaconInput(
                stage,
                code,
                version is not null && VersionPattern().IsMatch(version) ? version : null,
                os is not null && OsPattern().IsMatch(os) ? os : null);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or RegexMatchTimeoutException)
        {
            return null;
        }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>
/// O limite por agente, na memória: a API só guarda ids de agentes que existem no banco, então o tamanho dele é o número de
/// agentes. O limite por IP é do limitador da rota; este é o "por slug" que o limitador nativo não sabe fazer.
/// </summary>
internal sealed class AgentBeaconGate(TimeProvider time)
{
    private readonly Lock _gate = new();
    private readonly Dictionary<Guid, (DateTimeOffset Start, int Count)> _beacons = [];
    private readonly Dictionary<Guid, DateTimeOffset> _rejections = [];
    private (DateTimeOffset Start, int Count) _globalBeacons;
    private (DateTimeOffset Start, int Count) _globalRejections;
    private readonly Dictionary<string, DateTimeOffset> _missing = new(StringComparer.Ordinal);

    /// <summary>O teto geral das balizas por minuto; vale antes de qualquer consulta ao banco.</summary>
    public bool TryAcceptGlobalBeacon() => TryAcceptGlobal(ref _globalBeacons, BeaconLimits.GlobalBeaconsPerMinute);

    /// <summary>O teto geral das anotações de recusa por minuto, separado do das balizas.</summary>
    public bool TryAcceptGlobalRejection() => TryAcceptGlobal(ref _globalRejections, BeaconLimits.GlobalRejectionsPerMinute);

    /// <summary>Esse slug acabou de ser procurado e não existia: repetir o palpite não custa consulta nem gasta o teto.</summary>
    public bool IsKnownMissing(string slug)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!_missing.TryGetValue(slug, out var until))
            {
                return false;
            }

            if (now < until)
            {
                return true;
            }

            _missing.Remove(slug);
            return false;
        }
    }

    public void RememberMissing(string slug)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_missing.Count >= BeaconLimits.MissingSlugCapacity)
            {
                _missing.Clear();
            }

            _missing[slug] = now + BeaconLimits.MissingSlugMemory;
        }
    }

    private bool TryAcceptGlobal(ref (DateTimeOffset Start, int Count) bucket, int limit)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (now - bucket.Start >= BeaconLimits.Window)
            {
                bucket = (now, 1);
                return true;
            }

            if (bucket.Count >= limit)
            {
                return false;
            }

            bucket = (bucket.Start, bucket.Count + 1);
            return true;
        }
    }

    public bool TryAcceptBeacon(Guid agentId)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!_beacons.TryGetValue(agentId, out var window) || now - window.Start >= BeaconLimits.Window)
            {
                _beacons[agentId] = (now, 1);
                return true;
            }

            if (window.Count >= BeaconLimits.PerAgentPerMinute)
            {
                return false;
            }

            _beacons[agentId] = (window.Start, window.Count + 1);
            return true;
        }
    }

    public bool TryAcceptRejection(Guid agentId)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_rejections.TryGetValue(agentId, out var last) && now - last < BeaconLimits.RejectionInterval)
            {
                return false;
            }

            _rejections[agentId] = now;
            return true;
        }
    }
}

internal sealed record AgentBeaconItem(
    Guid AgentId,
    string? Stage,
    string? Code,
    DateTimeOffset? At,
    DateTimeOffset? FirstFailAt,
    int Count,
    bool Verified,
    string? Version,
    string? Os,
    string? RejectReason,
    DateTimeOffset? RejectedAt);

/// <summary>A última baliza e a última recusa de handshake de cada agente, como o dono as vê.</summary>
internal sealed record AgentBeaconsResponse(IReadOnlyList<AgentBeaconItem> Items);

/// <summary>
/// Grava e lê as balizas de partida. Defensivo em tudo que vem de fora: agente desconhecido ou revogado não grava nada (a
/// baliza), o excedente é descartado e a falha do banco nunca chega a quem mandou.
/// </summary>
internal sealed partial class AgentBeaconStore(
    DevicesDbContext db,
    AgentBeaconGate gate,
    TimeProvider time,
    ILogger<AgentBeaconStore> logger)
{
    /// <summary>Anota a baliza do agente de slug <paramref name="slug"/>. Nunca lança por causa do banco.</summary>
    public async Task RecordBeaconAsync(string slug, BeaconInput input, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(input);
        try
        {
            // Palpite repetido de um slug que não existe: nem consulta nem teto gasto. Os outros gastam o teto das balizas.
            if (gate.IsKnownMissing(slug) || !gate.TryAcceptGlobalBeacon())
            {
                return;
            }

            var agentId = await FindAgentAsync(slug, includeRevoked: false, cancellationToken);
            if (agentId is null)
            {
                gate.RememberMissing(slug);
                return;
            }

            if (!gate.TryAcceptBeacon(agentId.Value))
            {
                return;
            }

            var now = time.GetUtcNow();
            var row = await db.AgentBeacons.SingleOrDefaultAsync(b => b.AgentId == agentId, cancellationToken);
            if (row is null)
            {
                row = AgentBeacon.Create(agentId.Value);
                db.AgentBeacons.Add(row);
            }
            else if (row.IsRepeat(input.Stage, input.Code, now, BeaconLimits.RepeatWindow))
            {
                return;
            }

            row.ApplyBeacon(input.Stage, input.Code, input.Version, input.Os, now);
            await SaveAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // A baliza é só uma pista: falha do banco não pode virar resposta nem derrubar a conexão.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogFailed("baliza", ex.GetType().Name);
        }
    }

    /// <summary>Anota que o handshake do agente do caminho <paramref name="slug"/> foi recusado. Sem agente com esse slug, não grava nada.</summary>
    public async Task TryRecordRejectionAsync(string? slug, string reason, CancellationToken cancellationToken)
    {
        if (!AgentSlug.IsValid(slug) || gate.IsKnownMissing(slug!) || !gate.TryAcceptGlobalRejection())
        {
            return;
        }

        try
        {
            var agentId = await FindAgentAsync(slug!, includeRevoked: false, cancellationToken);
            if (agentId is null)
            {
                gate.RememberMissing(slug!);
                return;
            }

            if (!gate.TryAcceptRejection(agentId.Value))
            {
                return;
            }

            var row = await db.AgentBeacons.SingleOrDefaultAsync(b => b.AgentId == agentId, cancellationToken);
            if (row is null)
            {
                row = AgentBeacon.Create(agentId.Value);
                db.AgentBeacons.Add(row);
            }

            row.ApplyRejection(reason, time.GetUtcNow());
            await SaveAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Anotar a recusa é secundário: o handshake já foi decidido e nada disso pode mudar a resposta.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogFailed("recusa", ex.GetType().Name);
        }
    }

    /// <summary>
    /// O agente mandou um hello aceito: a recusa de protocolo anotada antes já não vale (ele foi atualizado ou corrigido) e sai.
    /// Só mexe na linha que tem essa recusa; sem ela não grava nada. Nunca lança por causa do banco.
    /// </summary>
    public async Task ClearProtocolRejectionAsync(string slug, CancellationToken cancellationToken)
    {
        try
        {
            var agentId = await FindAgentAsync(slug, includeRevoked: false, cancellationToken);
            if (agentId is null)
            {
                return;
            }

            await db.AgentBeacons
                .Where(b => b.AgentId == agentId && b.LastRejectReason == BeaconRejection.Protocol)
                .ExecuteUpdateAsync(
                    set => set.SetProperty(b => b.LastRejectReason, (string?)null).SetProperty(b => b.LastRejectedAt, (DateTimeOffset?)null),
                    cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Limpar a recusa é secundário: falha do banco não pode derrubar a conexão do agente.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            LogFailed("limpeza da recusa", ex.GetType().Name);
        }
    }

    public async Task<AgentBeaconsResponse> ListAsync(CancellationToken cancellationToken)
    {
        var rows = await (from b in db.AgentBeacons.AsNoTracking()
                          join a in db.Agents.AsNoTracking() on b.AgentId equals a.Id
                          where a.RevokedAt == null
                          orderby a.CreatedAt
                          select new AgentBeaconItem(
                              b.AgentId,
                              b.LastStage,
                              b.LastCode,
                              b.LastAt,
                              b.FirstFailAt,
                              b.Count,
                              b.Verified,
                              b.Version,
                              b.Os,
                              b.LastRejectReason,
                              b.LastRejectedAt))
            .ToListAsync(cancellationToken);
        return new AgentBeaconsResponse(rows);
    }

    private async Task<Guid?> FindAgentAsync(string slug, bool includeRevoked, CancellationToken cancellationToken) =>
        await db.Agents.AsNoTracking()
            .Where(a => a.Slug == slug && (includeRevoked || a.RevokedAt == null))
            .Select(a => (Guid?)a.Id)
            .SingleOrDefaultAsync(cancellationToken);

    private async Task SaveAsync(CancellationToken cancellationToken)
    {
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Duas balizas do mesmo agente criaram a linha ao mesmo tempo (a chave é o agente): a que chegou antes já gravou.
            // Qualquer outro erro (permissão, coluna, agente apagado no meio) sobe e é registrado por quem chamou, só com o tipo.
            db.ChangeTracker.Clear();
        }
    }

    // Só o tipo do erro: a mensagem de uma falha de banco cita servidor e conexão.
    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível gravar a {Kind} do agente ({ErrorType}).")]
    private partial void LogFailed(string kind, string errorType);
}

internal static class AgentBeaconEndpoints
{
    // Anônima de propósito: o agente que não consegue partir ainda não tem (ou não consegue ler) a credencial. O limite por IP é
    // do limitador da rota; o por agente fica no AgentBeaconGate. Responde sempre 204, exista o slug ou não (429 só pelo IP).
    public static void MapAgentBeacon(this IEndpointRouteBuilder group) =>
        group.MapPost("/agents/{slug}/beacon", HandleAsync)
            .AllowAnonymous()
            .WithMetadata(new RequestSizeLimitAttribute(BeaconLimits.MaxBodyBytes))
            .RequireRateLimiting(RateLimitPolicies.Beacon)
            .Accepts<AgentBeaconBody>("application/json")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    public static void MapAgentBeacons(this IEndpointRouteBuilder group) =>
        group.MapGet("/agents/beacons", ListAsync)
            .RequireAuthorization(UniOverAuth.OwnerPolicy)
            .Produces<AgentBeaconsResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static async Task<IResult> HandleAsync(
        string slug, HttpRequest request, AgentBeaconStore store, CancellationToken cancellationToken)
    {
        // O corpo é lido à mão: um corpo malformado ou grande demais não pode virar 400 e contar nada a quem mandou.
        if (AgentSlug.IsValid(slug) && await ReadBodyAsync(request, cancellationToken) is { } body
            && AgentBeaconParser.Parse(body) is { } input)
        {
            await store.RecordBeaconAsync(slug, input, cancellationToken);
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListAsync(HttpContext http, AgentBeaconStore store, CancellationToken cancellationToken)
    {
        // Pistas sobre os PCs de casa, só do dono: nada em cache de navegador nem de proxy.
        http.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(await store.ListAsync(cancellationToken));
    }

    private static async Task<byte[]?> ReadBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength is > BeaconLimits.MaxBodyBytes)
        {
            return null;
        }

        try
        {
            var buffer = new byte[BeaconLimits.MaxBodyBytes + 1];
            var total = 0;
            while (total < buffer.Length)
            {
                var read = await request.Body.ReadAsync(buffer.AsMemory(total), cancellationToken);
                if (read == 0)
                {
                    break;
                }

                total += read;
            }

            return total is > 0 and <= BeaconLimits.MaxBodyBytes ? buffer[..total] : null;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or BadHttpRequestException)
        {
            return null;
        }
    }
}
