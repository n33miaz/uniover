using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Idempotência de escrita para os módulos: <c>app.MapPost(...).RequireIdempotency&lt;TContext&gt;()</c>.
/// <para>
/// Contrato com o cliente (a fila offline do PWA depende dele):
/// </para>
/// <list type="bullet">
/// <item>cabeçalho <c>Idempotency-Key: &lt;uuid&gt;</c> obrigatório em POST, PUT, PATCH e DELETE; ausente ou fora do
/// formato dá 400 <c>idempotency-key-required</c> (outros métodos passam direto);</item>
/// <item>chave nova: executa e guarda status e corpo das respostas 2xx e 4xx determinísticas; 5xx (e 408, 425, 429)
/// não guarda e libera a chave, para o reenvio executar de novo;</item>
/// <item>chave concluída com o mesmo pedido: devolve a resposta guardada com <c>Idempotent-Replayed: true</c>;
/// pedido diferente (corpo, método ou rota) com a mesma chave: 422 <c>idempotency-key-reused</c>;</item>
/// <item>chave em andamento: 409 <c>idempotency-in-progress</c> com <c>Retry-After: 2</c>;</item>
/// <item>a chave é do usuário autenticado: outro usuário com o mesmo UUID não colide;</item>
/// <item>resposta com corpo acima de 32 KB guarda só o status, o <c>Content-Type</c> e o <c>Location</c>.</item>
/// </list>
/// O handler do módulo continua idempotente pelo id de negócio: o filtro é a rede de segurança, e a janela entre
/// "o handler gravou" e "a chave foi concluída" pode repetir a execução.
/// </summary>
public static class IdempotencyEndpointExtensions
{
    public static RouteHandlerBuilder RequireIdempotency<TContext>(this RouteHandlerBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.Finally(Wrap<TContext>);
        return builder;
    }

    /// <summary>
    /// Embrulha o <see cref="RequestDelegate"/> do endpoint, e não um filtro de endpoint: o filtro roda depois do
    /// binding de parâmetros, quando o corpo JSON já foi lido e não dá mais para calcular o hash do corpo cru.
    /// A autorização do endpoint já rodou antes (o usuário está identificado).
    /// </summary>
    private static void Wrap<TContext>(EndpointBuilder endpoint)
    {
        var inner = endpoint.RequestDelegate;
        if (inner is null)
        {
            return;
        }

        endpoint.RequestDelegate = context => IdempotencyRequestHandler<TContext>.HandleAsync(context, inner);
    }
}
