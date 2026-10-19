using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Adapters;

/// <summary>
/// Controle de ritmo do wger, compartilhado por <b>todas</b> as instâncias do cliente: uma chamada por vez no processo e
/// <c>DelayMs</c> de intervalo entre uma e outra. Fica à parte do <see cref="HttpWgerClient"/> porque o cliente tipado
/// do <c>HttpClientFactory</c> é recriado a cada uso; sozinho, ele perderia a conta do último pedido. A contagem de
/// tempo passa pelo <see cref="TimeProvider"/>, então o teste prova o intervalo sem esperar de verdade.
/// </summary>
internal sealed class WgerThrottle(TimeProvider time) : IDisposable
{
    private readonly TimeProvider _time = time;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTimeOffset? _lastCallAt;

    /// <summary>Espera a vez e o intervalo; o <see cref="IDisposable"/> devolvido libera a vez e marca o instante.</summary>
    public async Task<IDisposable> WaitForTurnAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_lastCallAt is { } last && delay > TimeSpan.Zero)
            {
                var remaining = last + delay - _time.GetUtcNow();
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

    private sealed class Turn(WgerThrottle owner) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                // O intervalo conta do fim da chamada (inclusive da que falhou): o serviço de fora não é martelado.
                owner._lastCallAt = owner._time.GetUtcNow();
                owner._gate.Release();
            }
        }
    }
}

/// <summary>
/// Cliente do wger por HTTP. Respeita o serviço de terceiros: uma chamada por vez, com <c>DelayMs</c> de intervalo entre
/// uma e outra (<see cref="WgerThrottle"/>), tempo limite e um <c>User-Agent</c> descritivo sem dado pessoal. Qualquer
/// falha vira <see cref="WgerUnavailableException"/>; nada é repetido sozinho.
/// </summary>
internal sealed class HttpWgerClient(HttpClient http, IOptions<TrainingModuleOptions> options, WgerThrottle throttle) : IWgerClient
{
    public async Task<WgerPage> GetExercisesAsync(int offset, int limit, CancellationToken cancellationToken)
    {
        var wger = options.Value.Import.Wger;
        var path = string.Create(CultureInfo.InvariantCulture, $"/api/v2/exerciseinfo/?limit={limit}&offset={offset}");

        using var turn = await throttle.WaitForTurnAsync(wger.Delay, cancellationToken);
        try
        {
            using var response = await http.GetAsync(new Uri(path, UriKind.Relative), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new WgerUnavailableException($"O wger respondeu {(int)response.StatusCode}.");
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            return WgerResponseParser.ParsePage(document.RootElement);
        }
        catch (HttpRequestException ex)
        {
            throw new WgerUnavailableException("Não foi possível falar com o wger.", ex);
        }
        catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            throw new WgerUnavailableException("O wger demorou demais para responder.", ex);
        }
        catch (JsonException ex)
        {
            throw new WgerUnavailableException("O wger devolveu um corpo que não é o esperado.", ex);
        }
    }
}

/// <summary>
/// Leitura defensiva do JSON do wger. O que faltar ou vier no formato errado vira "indisponível" e nunca um zero: um
/// campo ausente que virasse "0 em português" faria a simulação mentir sobre a cobertura.
/// </summary>
internal static class WgerResponseParser
{
    public static WgerPage ParsePage(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            throw Unexpected();
        }

        var total = root.TryGetProperty("count", out var count) && count.TryGetInt32(out var n) ? n : 0;
        var hasNext = root.TryGetProperty("next", out var next) && next.ValueKind == JsonValueKind.String;
        var items = new List<WgerExercise>();
        foreach (var item in results.EnumerateArray())
        {
            items.Add(ParseExercise(item));
        }

        return new WgerPage(total, hasNext, items);
    }

    private static WgerExercise ParseExercise(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || Text(item, "uuid") is not { Length: > 0 } uuid)
        {
            throw Unexpected();
        }

        // Sem a lista de traduções não há como saber o idioma: é corpo inesperado, não "zero em português".
        if (!item.TryGetProperty("translations", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            throw Unexpected();
        }

        var translations = new List<WgerTranslation>();
        foreach (var t in list.EnumerateArray())
        {
            if (t.ValueKind != JsonValueKind.Object
                || !t.TryGetProperty("language", out var language) || !language.TryGetInt32(out var languageId))
            {
                throw Unexpected();
            }

            var name = Text(t, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            int? licenseId = t.TryGetProperty("license", out var license) && license.TryGetInt32(out var l) ? l : null;
            translations.Add(new WgerTranslation(languageId, name, Text(t, "description"), licenseId, Text(t, "license_author")));
        }

        return new WgerExercise(uuid, Ids(item, "muscles"), Ids(item, "muscles_secondary"), Ids(item, "equipment"), translations);
    }

    private static WgerUnavailableException Unexpected() => new("O wger devolveu um corpo que não é o esperado.");

    private static string? Text(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static List<int> Ids(JsonElement element, string property)
    {
        var ids = new List<int>();
        if (element.TryGetProperty(property, out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in list.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("id", out var id) && id.TryGetInt32(out var value))
                {
                    ids.Add(value);
                }
            }
        }

        return ids;
    }
}
