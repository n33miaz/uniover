using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Net.Http.Headers;

namespace UniOver.BuildingBlocks.Web;

internal static class IdempotencyRequestHandler<TContext>
{
    private const string KeyHeader = "Idempotency-Key";
    private const string ReplayedHeader = "Idempotent-Replayed";
    private const int RetryAfterSeconds = 2;

    /// <summary>Acima disto a resposta guarda só status, tipo e <c>Location</c> (igual ao limite da loja).</summary>
    private const int MaxStoredBodyBytes = 32 * 1024;

    /// <summary>Corpo de requisição que cabe no buffer para o hash; os pedidos de escrita dos módulos são JSON pequeno.</summary>
    private const int MaxRequestBodyBytes = 1024 * 1024;

    private const int RouteMaxLength = 300;

    private const int TooEarly = 425;

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static async Task HandleAsync(HttpContext context, RequestDelegate inner)
    {
        if (!IsWrite(context.Request.Method))
        {
            await inner(context);
            return;
        }

        if (!context.Request.Headers.ContainsKey(KeyHeader))
        {
            // A chave passa a ser obrigatória só depois que os clientes antigos tiverem atualizado.
            await inner(context);
            return;
        }

        if (!TryReadKey(context.Request, out var key))
        {
            await WriteProblemAsync(context, StatusCodes.Status400BadRequest, "idempotency-key-required",
                "Informe o cabeçalho Idempotency-Key com um UUID.");
            return;
        }

        var userId = context.RequestServices.GetRequiredService<ICurrentUser>().UserId;
        if (userId is null)
        {
            await WriteProblemAsync(context, StatusCodes.Status401Unauthorized, "unauthenticated", "Sessão inválida ou expirada.");
            return;
        }

        var requestHash = await TryHashRequestAsync(context);
        if (requestHash is null)
        {
            await WriteProblemAsync(context, StatusCodes.Status413PayloadTooLarge, "payload-too-large",
                "O corpo da requisição é grande demais.");
            return;
        }

        var method = context.Request.Method.ToUpperInvariant();
        var route = Truncate(context.Request.Path.Value ?? "/", RouteMaxLength);
        var gateway = context.RequestServices.GetRequiredService<IIdempotencyGateway<TContext>>();
        var begin = await gateway.TryBeginAsync(userId.Value, key, method, route, requestHash, context.RequestAborted);

        switch (begin.Outcome)
        {
            case IdempotencyGatewayOutcome.Started:
                await ExecuteAndStoreAsync(context, inner, gateway, userId.Value, key,
                    begin.LeaseId ?? throw new InvalidOperationException("A loja iniciou uma chave sem identificador de execução."));
                return;

            case IdempotencyGatewayOutcome.Completed or IdempotencyGatewayOutcome.InProgress
                when begin.Existing is { } existing && !SameRequest(existing, method, route, requestHash):
                await WriteProblemAsync(context, StatusCodes.Status422UnprocessableEntity, "idempotency-key-reused",
                    "Esta chave de idempotência já foi usada em outro pedido.");
                return;

            case IdempotencyGatewayOutcome.Completed when begin.Existing is { } stored:
                await ReplayAsync(context, stored);
                return;

            default:
                context.Response.Headers.RetryAfter = RetryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
                await WriteProblemAsync(context, StatusCodes.Status409Conflict, "idempotency-in-progress",
                    "Um envio com esta chave ainda está em andamento.");
                return;
        }
    }

    private static bool IsWrite(string method) =>
        HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

    private static bool TryReadKey(HttpRequest request, out Guid key)
    {
        key = Guid.Empty;
        var values = request.Headers[KeyHeader];
        return values.Count == 1 && Guid.TryParseExact(values[0], "D", out key);
    }

    /// <summary>Hash SHA-256 do corpo e da query canônica, ou <c>null</c> se passar do limite. Deixa o corpo legível para o endpoint.</summary>
    private static async Task<byte[]?> TryHashRequestAsync(HttpContext context)
    {
        var request = context.Request;
        request.EnableBuffering(bufferThreshold: 64 * 1024, bufferLimit: MaxRequestBodyBytes);
        try
        {
            var bodyHash = await SHA256.HashDataAsync(request.Body, context.RequestAborted);
            request.Body.Position = 0;
            if (request.Query.Count == 0)
            {
                return bodyHash;
            }

            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(bodyHash);
            hash.AppendData(Encoding.UTF8.GetBytes(CanonicalQuery(request.Query)));
            return hash.GetHashAndReset();
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    private static string CanonicalQuery(IQueryCollection query) => string.Join('&', query
        .OrderBy(parameter => parameter.Key, StringComparer.Ordinal)
        .SelectMany(parameter => parameter.Value
            .OrderBy(value => value, StringComparer.Ordinal)
            .Select(value => $"{Uri.EscapeDataString(parameter.Key)}={Uri.EscapeDataString(value ?? string.Empty)}")));

    private static bool SameRequest(IdempotencyGatewayEntry existing, string method, string route, byte[] requestHash) =>
        string.Equals(existing.Method, method, StringComparison.Ordinal)
        && string.Equals(existing.Route, route, StringComparison.Ordinal)
        && CryptographicOperations.FixedTimeEquals(existing.RequestHash, requestHash);

    private static async Task ExecuteAndStoreAsync(
        HttpContext context, RequestDelegate inner, IIdempotencyGateway<TContext> gateway, Guid userId, Guid key, Guid leaseId)
    {
        var response = context.Response;
        var original = response.Body;
        var capture = new CapturingStream(original, MaxStoredBodyBytes);
        response.Body = capture;
        try
        {
            await inner(context);
            await response.BodyWriter.FlushAsync(CancellationToken.None);
        }
        catch
        {
            response.Body = original;
            await TryReleaseAsync(gateway, userId, key, leaseId);
            throw;
        }

        response.Body = original;
        var status = response.StatusCode;
        if (!IsStorable(status))
        {
            await TryReleaseAsync(gateway, userId, key, leaseId);
            return;
        }

        var body = capture.Overflowed || capture.Length == 0 ? null : TryDecode(capture.Captured);
        var contentType = response.ContentType is { Length: > 0 } type ? Truncate(type, 200) : null;
        var location = response.Headers.Location.ToString();

        // Sem o token da requisição: se o cliente desistiu, o resultado ainda precisa ser guardado.
        // Se o processo cair entre o efeito e CompleteAsync, o reenvio após o lease pode repetir a ação.
        await gateway.CompleteAsync(userId, key, leaseId, status, body, contentType,
            location.Length == 0 ? null : Truncate(location, 2000), CancellationToken.None);
    }

    /// <summary>
    /// Guarda 2xx e 4xx determinísticos. 5xx não (o reenvio deve tentar de novo), nem 408, 425 e 429, que dependem do
    /// momento e não do pedido.
    /// </summary>
    private static bool IsStorable(int status) =>
        status < StatusCodes.Status500InternalServerError
        && status is not (StatusCodes.Status408RequestTimeout or TooEarly or StatusCodes.Status429TooManyRequests);

    private static async Task TryReleaseAsync(IIdempotencyGateway<TContext> gateway, Guid userId, Guid key, Guid leaseId)
    {
        try
        {
            await gateway.ReleaseAsync(userId, key, leaseId, CancellationToken.None);
        }
#pragma warning disable CA1031 // Liberar é melhor esforço: se falhar, o "em andamento" vence sozinho em 60 s.
        catch (Exception)
#pragma warning restore CA1031
        {
        }
    }

    private static string? TryDecode(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            return StrictUtf8.GetString(bytes.Span);
        }
        catch (DecoderFallbackException)
        {
            // Resposta que não é texto não cabe na coluna de texto: guarda só status, tipo e Location.
            return null;
        }
    }

    private static async Task ReplayAsync(HttpContext context, IdempotencyGatewayEntry stored)
    {
        var response = context.Response;
        response.StatusCode = stored.StatusCode ?? StatusCodes.Status200OK;
        response.Headers[ReplayedHeader] = "true";
        if (stored.Location is { Length: > 0 } location)
        {
            response.Headers.Location = location;
        }

        if (stored.ResponseBody is { Length: > 0 } text)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            response.ContentType = stored.ContentType;
            response.ContentLength = bytes.Length;
            await response.Body.WriteAsync(bytes, context.RequestAborted);
        }
        else if (stored.ContentType is { Length: > 0 } type)
        {
            response.ContentType = type;
        }
    }

    private static async Task WriteProblemAsync(HttpContext context, int status, string code, string title)
    {
        var problem = new ProblemDetails
        {
            Status = status,
            Title = title,
            Type = ProblemDetailsExtensions.TypeBase + code,
        };
        await TypedResults.Problem(problem).ExecuteAsync(context);
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];

    /// <summary>Repassa tudo ao fluxo real e guarda uma cópia dos primeiros bytes (até o limite + 1, para detectar estouro).</summary>
    private sealed class CapturingStream(Stream inner, int limit) : Stream
    {
        private readonly MemoryStream _captured = new();

        public bool Overflowed { get; private set; }

        public ReadOnlyMemory<byte> Captured => _captured.GetBuffer().AsMemory(0, (int)_captured.Length);

        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => _captured.Length;

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            Capture(buffer);
            inner.Write(buffer);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Capture(buffer.Span);
            return inner.WriteAsync(buffer, cancellationToken);
        }

        private void Capture(ReadOnlySpan<byte> buffer)
        {
            if (Overflowed)
            {
                return;
            }

            if (_captured.Length + buffer.Length > limit)
            {
                Overflowed = true;
                return;
            }

            _captured.Write(buffer);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _captured.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
