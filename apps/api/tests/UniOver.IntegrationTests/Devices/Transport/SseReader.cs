using System.Text.Json;

namespace UniOver.IntegrationTests.Devices.Transport;

/// <summary>Um quadro SSE: evento com dado, ou comentário (keep-alive).</summary>
internal sealed record SseFrame(string? EventType, JsonElement? Data, string? Comment);

/// <summary>Lê um fluxo <c>text/event-stream</c> quadro a quadro, com prazo em tempo real em cada leitura.</summary>
internal sealed class SseReader(Stream stream) : IDisposable
{
    private readonly StreamReader _reader = new(stream);

    /// <summary>Próximo quadro, ou nulo quando o servidor encerrou o fluxo.</summary>
    public async Task<SseFrame?> NextAsync()
    {
        using var timeout = new CancellationTokenSource(FakeAgent.Patience);
        string? eventType = null;
        string? data = null;
        string? comment = null;
        while (true)
        {
            var line = await _reader.ReadLineAsync(timeout.Token);
            if (line is null)
            {
                return null;
            }

            if (line.Length == 0)
            {
                if (eventType is not null || data is not null || comment is not null)
                {
                    return new SseFrame(
                        eventType,
                        data is null ? null : JsonSerializer.Deserialize<JsonElement>(data),
                        comment);
                }

                continue;
            }

            if (line.StartsWith(':'))
            {
                comment = line[1..].Trim();
            }
            else if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventType = line["event:".Length..].Trim();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                data = line["data:".Length..].Trim();
            }
        }
    }

    public void Dispose() => _reader.Dispose();
}
