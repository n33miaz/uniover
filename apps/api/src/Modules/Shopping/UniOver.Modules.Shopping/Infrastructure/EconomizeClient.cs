using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace UniOver.Modules.Shopping.Infrastructure;

/// <summary>As duas leituras que o Economize oferece a outro sistema do dono, com a chave de integração.</summary>
internal interface IEconomizeClient
{
    Task<EconomizeAdviceFetch> GetAdviceAsync(string? etag, CancellationToken cancellationToken);

    Task<EconomizeTripsFetch> GetTripsAsync(string? cursor, int limit, CancellationToken cancellationToken);
}

internal enum EconomizeFetchStatus
{
    Available,
    NotModified,
    Disabled,
    Unauthorized,
    InvalidCursor,
    RateLimited,
    Unavailable,
}

internal sealed record EconomizeAdviceFetch(EconomizeFetchStatus Status, EconomizeAdvice? Advice = null, string? Etag = null);

internal sealed record EconomizeTripsFetch(EconomizeFetchStatus Status, EconomizeTripsPage? Page = null, TimeSpan? RetryAfter = null);

/// <summary>O conselho, só com o que a tela usa: o melhor dia e quanto está livre até o salário (em centavos).</summary>
internal sealed record EconomizeAdvice(DateTimeOffset GeneratedAt, string? Status, DateOnly? BestDay, string? BestDayWeekday, EconomizeFree? Free);

internal sealed record EconomizeFree(
    bool SalaryKnown,
    DateOnly? SalaryDate,
    int? DaysUntilSalary,
    long? ExpectedSalaryCents,
    long? CommittedBeforeSalaryCents,
    long? CommittedAfterSalaryCents,
    long? FreeCents);

internal sealed record EconomizeTrip(
    Guid Id,
    bool Own,
    string Status,
    string? StoreName,
    DateTimeOffset StartedAt,
    DateTimeOffset? ClosedAt,
    long? PaidTotalCents,
    long? ReceiptTotalCents,
    long? ItemsTotalCents,
    string? ReceiptKey,
    DateTimeOffset? UpdatedAt,
    IReadOnlyList<EconomizeTripItem> Items);

/// <summary>Uma linha da compra. <c>promoNote</c> não é lido: a linha da compra daqui não tem onde guardá-lo.</summary>
internal sealed record EconomizeTripItem(string? Name, decimal? Quantity, long? UnitPriceCents, long? LineTotalCents, bool Checked, DateTimeOffset? CreatedAt);

internal sealed record EconomizeTripsPage(IReadOnlyList<EconomizeTrip> Trips, string? NextCursor, bool HasMore);

/// <summary>
/// O ritmo dos pedidos ao Economize, compartilhado por todas as instâncias do cliente (o cliente tipado é recriado a cada
/// uso): um pedido por vez e um intervalo entre o fim de um e o começo do outro. A chave aceita 60 pedidos por minuto;
/// com o intervalo de 1,1 s, conselho e importação juntos ficam abaixo disso.
/// <para>
/// O ritmo é contado só na memória deste processo e pressupõe uma instância da API, como o resto dos serviços em segundo
/// plano (README da API, "Em produção roda uma instância"). Na sobreposição do deploy, duas instâncias podem somar até o
/// dobro por um instante; o 429 que o Economize devolve então é tentado de novo pela importação, no Retry-After.
/// Com mais de uma instância fixa, este limitador precisa virar distribuído.
/// </para>
/// </summary>
internal sealed class EconomizeThrottle(TimeProvider time) : IDisposable
{
    public static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(1100);

    private readonly TimeProvider _time = time;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTimeOffset? _lastCallAt;

    public async Task<IDisposable> WaitForTurnAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_lastCallAt is { } last)
            {
                var remaining = last + Interval - _time.GetUtcNow();
                if (remaining > TimeSpan.Zero)
                {
                    await Task.Delay(remaining, _time, cancellationToken);
                }
            }
        }
        catch
        {
            _gate.Release();
            throw;
        }

        return new Turn(this);
    }

    public void Dispose() => _gate.Dispose();

    private sealed class Turn(EconomizeThrottle owner) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                owner._lastCallAt = owner._time.GetUtcNow();
                owner._gate.Release();
            }
        }
    }
}

/// <summary>
/// O cliente HTTP do Economize. O endereço e a chave vêm só da configuração; desligado ou incompleto, devolve
/// <see cref="EconomizeFetchStatus.Disabled"/> sem abrir conexão. Nenhuma falha carrega a chave: a resposta de erro do
/// Economize não é lida e as exceções viram só um estado.
/// </summary>
internal sealed class HttpEconomizeClient(HttpClient http, IOptions<ShoppingModuleOptions> options, EconomizeThrottle throttle) : IEconomizeClient
{
    /// <summary>O nome do cliente no <c>HttpClientFactory</c> (os testes trocam só o manipulador dele).</summary>
    public const string Name = "economize";

    /// <summary>A API do Economize dorme: a primeira resposta pode passar de 200 s.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(240);

    public const string AdvicePath = "/api/v1/integration/shopping/advice";
    public const string TripsPath = "/api/v1/integration/shopping/trips";

    public async Task<EconomizeAdviceFetch> GetAdviceAsync(string? etag, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(AdvicePath);
        if (request is null)
        {
            return new(EconomizeFetchStatus.Disabled);
        }

        if (!string.IsNullOrWhiteSpace(etag) && EntityTagHeaderValue.TryParse(etag, out var tag))
        {
            request.Headers.IfNoneMatch.Add(tag);
        }

        var (status, document, response) = await SendAsync(request, cancellationToken);
        using (document)
        {
            if (status != EconomizeFetchStatus.Available)
            {
                return new(status);
            }

            var advice = EconomizeMapping.ParseAdvice(document!.RootElement);
            return advice is null ? new(EconomizeFetchStatus.Unavailable) : new(EconomizeFetchStatus.Available, advice, response?.ETag);
        }
    }

    public async Task<EconomizeTripsFetch> GetTripsAsync(string? cursor, int limit, CancellationToken cancellationToken)
    {
        var path = TripsPath + "?limit=" + limit.ToString(CultureInfo.InvariantCulture);
        if (!string.IsNullOrEmpty(cursor))
        {
            path += "&cursor=" + Uri.EscapeDataString(cursor);
        }

        using var request = CreateRequest(path);
        if (request is null)
        {
            return new(EconomizeFetchStatus.Disabled);
        }

        var (status, document, response) = await SendAsync(request, cancellationToken);
        using (document)
        {
            if (status != EconomizeFetchStatus.Available)
            {
                return new(status, RetryAfter: response?.RetryAfter);
            }

            var page = EconomizeMapping.ParseTrips(document!.RootElement);
            return page is null ? new(EconomizeFetchStatus.Unavailable) : new(EconomizeFetchStatus.Available, page);
        }
    }

    private HttpRequestMessage? CreateRequest(string pathAndQuery)
    {
        var economize = options.Value.Economize;
        if (!economize.IsActive || !economize.TryBaseUri(out var baseUri))
        {
            return null;
        }

        var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, pathAndQuery));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", economize.ApiKey);
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    private async Task<(EconomizeFetchStatus Status, JsonDocument? Document, ResponseHints? Hints)> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var turn = await throttle.WaitForTurnAsync(cancellationToken);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            var hints = new ResponseHints(response.Headers.ETag?.ToString(), RetryAfter(response));
            var status = response.StatusCode switch
            {
                HttpStatusCode.OK => EconomizeFetchStatus.Available,
                HttpStatusCode.NotModified => EconomizeFetchStatus.NotModified,
                HttpStatusCode.Unauthorized => EconomizeFetchStatus.Unauthorized,
                HttpStatusCode.BadRequest => EconomizeFetchStatus.InvalidCursor,
                HttpStatusCode.TooManyRequests => EconomizeFetchStatus.RateLimited,
                _ => EconomizeFetchStatus.Unavailable,
            };
            if (status != EconomizeFetchStatus.Available)
            {
                return (status, null, hints);
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            return (EconomizeFetchStatus.Available, document, hints);
        }
        catch (HttpRequestException)
        {
            return (EconomizeFetchStatus.Unavailable, null, null);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // O tempo limite do cliente, não o desligamento do servidor.
            return (EconomizeFetchStatus.Unavailable, null, null);
        }
        catch (JsonException)
        {
            return (EconomizeFetchStatus.Unavailable, null, null);
        }
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response) =>
        response.Headers.RetryAfter?.Delta
        ?? (response.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);

    private sealed record ResponseHints(string? ETag, TimeSpan? RetryAfter);
}

/// <summary>
/// Lê as respostas do Economize sem confiar nelas: campo ausente, nulo ou de outro tipo vira "não sei" (ou descarta o
/// registro), nunca uma exceção que derrube a importação inteira.
/// </summary>
internal static class EconomizeMapping
{
    /// <summary><c>{ generatedAt, incomePattern: { status, advice: { bestDay, ... } | null, ... }, free | null }</c>.</summary>
    public static EconomizeAdvice? ParseAdvice(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || Date(root, "generatedAt") is not { } generated)
        {
            return null;
        }

        string? status = null;
        DateOnly? bestDay = null;
        string? weekday = null;
        if (Property(root, "incomePattern") is { ValueKind: JsonValueKind.Object } income)
        {
            status = Text(income, "status");
            if (Property(income, "advice") is { ValueKind: JsonValueKind.Object } advice)
            {
                bestDay = Day(advice, "bestDay");
                weekday = Text(advice, "bestDayWeekday");
            }
        }

        EconomizeFree? free = null;
        if (Property(root, "free") is { ValueKind: JsonValueKind.Object } value)
        {
            free = new EconomizeFree(
                Bool(value, "salaryKnown") ?? false,
                Day(value, "salaryDate"),
                Int(value, "daysUntilSalary"),
                Long(value, "expectedSalaryCents"),
                Long(value, "committedBeforeSalaryCents"),
                Long(value, "committedAfterSalaryCents"),
                Long(value, "freeCents"));
        }

        return new EconomizeAdvice(generated, status, bestDay, weekday, free);
    }

    /// <summary><c>{ trips: [...], nextCursor, hasMore }</c>. Uma viagem ilegível é deixada de fora; a página não.</summary>
    public static EconomizeTripsPage? ParseTrips(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || Property(root, "trips") is not { ValueKind: JsonValueKind.Array } trips)
        {
            return null;
        }

        var found = new List<EconomizeTrip>();
        foreach (var trip in trips.EnumerateArray())
        {
            if (Trip(trip) is { } parsed)
            {
                found.Add(parsed);
            }
        }

        return new EconomizeTripsPage(found, Text(root, "nextCursor"), Bool(root, "hasMore") ?? false);
    }

    private static EconomizeTrip? Trip(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !Guid.TryParse(Text(value, "id"), out var id)
            || Bool(value, "own") is not { } own
            || Text(value, "status") is not { } status
            || Date(value, "startedAt") is not { } started)
        {
            return null;
        }

        var items = new List<EconomizeTripItem>();
        if (Property(value, "items") is { ValueKind: JsonValueKind.Array } list)
        {
            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object)
                {
                    items.Add(new EconomizeTripItem(
                        Text(item, "name"),
                        Decimal(item, "quantity"),
                        Long(item, "unitPriceCents"),
                        Long(item, "lineTotalCents"),
                        Bool(item, "checked") ?? false,
                        Date(item, "createdAt")));
                }
            }
        }

        return new EconomizeTrip(
            id,
            own,
            status,
            Text(value, "storeName"),
            started,
            Date(value, "closedAt"),
            Long(value, "paidTotalCents"),
            Long(value, "receiptTotalCents"),
            Long(value, "itemsTotalCents"),
            Text(value, "receiptKey"),
            Date(value, "updatedAt"),
            items);
    }

    private static JsonElement? Property(JsonElement value, string name) =>
        value.TryGetProperty(name, out var found) && found.ValueKind != JsonValueKind.Null ? found : null;

    private static string? Text(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } found && !string.IsNullOrWhiteSpace(found.GetString()) ? found.GetString() : null;

    private static bool? Bool(JsonElement value, string name) => Property(value, name) switch
    {
        { ValueKind: JsonValueKind.True } => true,
        { ValueKind: JsonValueKind.False } => false,
        _ => null,
    };

    private static long? Long(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.Number } found && found.TryGetInt64(out var number) ? number : null;

    private static int? Int(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.Number } found && found.TryGetInt32(out var number) ? number : null;

    private static decimal? Decimal(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.Number } found && found.TryGetDecimal(out var number) ? number : null;

    private static DateTimeOffset? Date(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } found && found.TryGetDateTimeOffset(out var date) ? date : null;

    private static DateOnly? Day(JsonElement value, string name) =>
        Text(value, name) is { } text && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;
}
