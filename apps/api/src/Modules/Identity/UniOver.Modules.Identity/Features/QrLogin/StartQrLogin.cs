using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.QrLogin;

internal static class StartQrLoginEndpoint
{
    /// <summary>
    /// Rota anônima: o computador que quer entrar ainda não tem conta nem sessão. O que sai daqui são dois textos: o
    /// <c>code</c>, que vai para o QR (e para o celular), e o <c>pollSecret</c>, que só este navegador guarda e é a ÚNICA
    /// credencial da consulta. O limite por IP é próprio e baixo, porque cada chamada grava uma linha.
    /// </summary>
    public static void MapStartQrLogin(this IEndpointRouteBuilder group) =>
        group.MapPost("/auth/qr/start", HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.QrStart)
            .Produces<StartQrLoginResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

    private static async Task<IResult> HandleAsync(
        HttpContext http,
        StartQrLoginHandler handler,
        CancellationToken cancellationToken)
    {
        if (!IdentityProblems.HasClientHeader(http.Request))
        {
            return IdentityProblems.MissingClientHeader();
        }

        var started = await handler.HandleAsync(ClientInfo.From(http), cancellationToken);

        // O segredo de consulta está na resposta: nada de cache.
        http.Response.Headers.CacheControl = "no-store";
        return started is null
            ? Results.Problem(
                statusCode: StatusCodes.Status429TooManyRequests,
                title: "Muitas requisições. Tente de novo em instantes.",
                type: ProblemDetailsExtensions.TypeBase + ProblemDetailsExtensions.RateLimited)
            : TypedResults.Ok(started);
    }
}

internal sealed class StartQrLoginHandler(
    IdentityDbContext db,
    TimeProvider time,
    IOptions<IdentityModuleOptions> options)
{
    /// <summary>Nulo quando já há pedidos abertos demais (o teto global); a borda responde 429.</summary>
    public async Task<StartQrLoginResponse?> HandleAsync(ClientInfo client, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        var settings = options.Value;
        var now = time.GetUtcNow();

        // Limpeza oportunista (sem tarefa de fundo, para o banco poder dormir): o que venceu já não serve a ninguém.
        await db.QrLoginRequests.Where(r => r.ExpiresAt <= now).ExecuteDeleteAsync(cancellationToken);

        var open = await db.QrLoginRequests.CountAsync(
            r => r.ExpiresAt > now && r.ApprovedAt == null && r.DeniedAt == null && r.ConsumedAt == null, cancellationToken);
        if (open >= settings.QrMaxPending)
        {
            return null;
        }

        var (code, codeHash) = QrLoginCodes.NewCode();
        var (secret, secretHash) = SecretTokens.Generate();
        var request = QrLoginRequest.Create(codeHash, secretHash, client.Ip, client.UserAgent, now, settings.QrLoginLifetime);
        db.QrLoginRequests.Add(request);
        await db.SaveChangesAsync(cancellationToken);

        return new StartQrLoginResponse(code, secret, request.ExpiresAt, (int)settings.QrLoginLifetime.TotalSeconds);
    }
}
