using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace UniOver.BuildingBlocks.Web;

public static class IdempotencyOpenApi
{
    /// <summary>
    /// Declara o cabeçalho opcional <c>Idempotency-Key</c> nas operações que usam <c>RequireIdempotency</c>. Fica aqui, e não
    /// no Host, porque o Host só compõe e não pode ter tipos de regra.
    /// </summary>
    public static OpenApiOptions AddIdempotencyHeader(this OpenApiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.AddOperationTransformer(TransformAsync);
    }

    private static Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (!context.Description.ActionDescriptor.EndpointMetadata.OfType<IdempotencyMetadata>().Any())
        {
            return Task.CompletedTask;
        }

        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "Idempotency-Key",
            In = ParameterLocation.Header,
            Required = false,
            Description = "UUID opcional para repetir uma escrita sem repetir seu efeito.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String, Format = "uuid" },
        });
        return Task.CompletedTask;
    }
}
