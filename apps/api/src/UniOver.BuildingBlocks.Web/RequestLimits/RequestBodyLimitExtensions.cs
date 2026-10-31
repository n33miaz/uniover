using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Teto do corpo de requisição (<c>RequestLimits</c>): padrão para toda rota; foto e importação declaram o próprio teto na rota.</summary>
public sealed class RequestLimitsOptions
{
    public const string SectionName = "RequestLimits";

    /// <summary>
    /// Bytes aceitos no corpo quando a rota não declara outro limite. O padrão do Kestrel é 28,6 MB, e login, refresh,
    /// pareamento e convite leem JSON: um corpo de megabytes ali só serve para gastar memória do plano gratuito (512 MB).
    /// 256 KiB cobre com folga o maior JSON legítimo do app (uma rotina completa) e fica longe do abuso.
    /// </summary>
    public long MaxBodyBytes { get; set; } = 256 * 1024;

    public static bool IsValid(RequestLimitsOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.MaxBodyBytes is >= 1024 and <= 64L * 1024 * 1024;
    }
}

public static class RequestBodyLimitExtensions
{
    public static IServiceCollection AddUniOverRequestLimits(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<RequestLimitsOptions>()
            .Bind(configuration.GetSection(RequestLimitsOptions.SectionName))
            .Validate(RequestLimitsOptions.IsValid, "RequestLimits:MaxBodyBytes fora do permitido (1 KiB a 64 MiB).")
            .ValidateOnStart();
        return services;
    }

    /// <summary>
    /// Recusa corpo acima do teto: 413 na hora quando o <c>Content-Length</c> já o declara maior (nada é lido), e, para corpo
    /// sem tamanho declarado (chunked), um leitor que falha com 413 ao passar do teto. Vale o limite que a ROTA declara
    /// (<see cref="RequestSizeLimitAttribute"/>, ou <c>DisableRequestSizeLimit</c> para nenhum); sem declaração, o padrão
    /// de <see cref="RequestLimitsOptions"/>. Depois do roteamento (que escolhe a rota) e antes de tudo que lê o corpo.
    /// </summary>
    public static IApplicationBuilder UseUniOverRequestBodyLimit(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseMiddleware<RequestBodyLimitMiddleware>();
    }
}

internal sealed class RequestBodyLimitMiddleware(RequestDelegate next, IOptions<RequestLimitsOptions> options)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var limit = LimitFor(context);
        if (limit is { } max)
        {
            if (context.Request.ContentLength > max)
            {
                await WriteTooLargeAsync(context);
                return;
            }

            // O Kestrel também aplica o teto (e fecha a conexão sem ler o excesso); o leitor abaixo vale para qualquer
            // servidor e para o corpo chunked.
            var feature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (feature is { IsReadOnly: false })
            {
                feature.MaxRequestBodySize = max;
            }

            if (context.Request.ContentLength is null && CarriesBody(context.Request.Method))
            {
                context.Request.Body = new LimitedReadStream(context.Request.Body, max);
            }
        }

        await next(context);
    }

    // GET, HEAD e OPTIONS não têm corpo (e o upgrade do WebSocket é um GET): nada a vigiar ali.
    private static bool CarriesBody(string method) =>
        HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

    private long? LimitFor(HttpContext context)
    {
        // Rota que declarou o próprio teto (ou nenhum): vale o que ela disse.
        if (context.GetEndpoint()?.Metadata.GetMetadata<IRequestSizeLimitMetadata>() is { } declared)
        {
            return declared.MaxRequestBodySize;
        }

        return options.Value.MaxBodyBytes;
    }

    private static async Task WriteTooLargeAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
        var problems = context.RequestServices.GetRequiredService<IProblemDetailsService>();
        await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status413PayloadTooLarge,
                Title = "O corpo da requisição é grande demais.",
                Type = ProblemDetailsExtensions.TypeBase + ProblemDetailsExtensions.PayloadTooLarge,
            },
        });
    }

    /// <summary>Lê o corpo até o teto; passou, falha com a mesma exceção do Kestrel (que o tratador global já devolve como 413).</summary>
    private sealed class LimitedReadStream(Stream inner, long limit) : Stream
    {
        private long _read;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            Count(await inner.ReadAsync(buffer, cancellationToken));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));

        private int Count(int read)
        {
            _read += read;
            if (_read > limit)
            {
                throw new BadHttpRequestException("O corpo da requisição passou do teto.", StatusCodes.Status413PayloadTooLarge);
            }

            return read;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
