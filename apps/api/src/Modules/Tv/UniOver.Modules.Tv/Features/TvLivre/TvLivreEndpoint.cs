using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Net.Http.Headers;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Tv.Features.Commands;

namespace UniOver.Modules.Tv.Features.TvLivre;

/// <summary>
/// As rotas do TV Livre da TV escolhida. São só do dono: política nomeada de administrador, sem permissão no catálogo do
/// convidado (a concessão ao convidado exigiria mudar o Identity e fica para depois), e todas as que escrevem ou falam
/// com a TV levam o limite de comandos.
/// </summary>
internal static class TvLivreEndpoint
{
    public static void MapTvLivre(this IEndpointRouteBuilder group)
    {
        group.MapGet("/livre", ReadAsync).Owner().Produces<TvLivreView>();
        group.MapPost("/livre/refresh", RefreshAsync).Owner().RateLimited().Produces<TvLivreView>();
        group.MapPut("/livre/config", SaveConfigAsync).Owner().RateLimited().Produces<TvLivreView>()
            .ProducesProblem(StatusCodes.Status400BadRequest);
        group.MapPut("/livre/photo", SavePhotoAsync).Owner().RateLimited()
            .Accepts<byte[]>(LivrePhoto.ContentType).Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge).ProducesProblem(StatusCodes.Status415UnsupportedMediaType);
        group.MapGet("/livre/photo", ReadPhotoAsync).Owner().Produces<byte[]>(StatusCodes.Status200OK, LivrePhoto.ContentType)
            .Produces(StatusCodes.Status304NotModified).ProducesProblem(StatusCodes.Status404NotFound);
        group.MapDelete("/livre/photo", RemovePhotoAsync).Owner().RateLimited().Produces(StatusCodes.Status204NoContent);
        group.MapPost("/livre/apply", ApplyAsync).Owner().RateLimited().Produces<TvLivreView>().Steps();
        group.MapPost("/livre/install", InstallAsync).Owner().RateLimited().Produces<TvLivreView>().Steps();
        group.MapPost("/livre/set-home", SetHomeAsync).Owner().RateLimited().Produces<TvLivreView>().Steps();
        group.MapPost("/livre/restore", RestoreAsync).Owner().RateLimited().Produces<TvLivreView>().Steps();
        group.MapPost("/livre/sleep", SleepAsync).Owner().RateLimited().Produces(StatusCodes.Status204NoContent).Steps();
        group.MapPost("/livre/apps/visibility", VisibilityAsync).Owner().RateLimited().Produces<TvLivreView>()
            .ProducesProblem(StatusCodes.Status400BadRequest).Steps();
    }

    private static RouteHandlerBuilder Owner(this RouteHandlerBuilder builder) =>
        builder.RequireAuthorization(UniOverAuth.OwnerPolicy)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

    private static RouteHandlerBuilder RateLimited(this RouteHandlerBuilder builder) =>
        builder.RequireRateLimiting(RateLimitPolicies.Commands).ProducesProblem(StatusCodes.Status429TooManyRequests);

    /// <summary>As respostas de um passo no aparelho: o módulo não existe na TV, a vez ocupada, ou a falha do agente.</summary>
    private static RouteHandlerBuilder Steps(this RouteHandlerBuilder builder) =>
        builder.ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status502BadGateway)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .ProducesProblem(StatusCodes.Status504GatewayTimeout);

    private static async Task<IResult> ReadAsync(TvLivreHandler handler, CancellationToken cancellationToken) =>
        TypedResults.Ok(await handler.ViewAsync(cancellationToken));

    private static async Task<IResult> RefreshAsync(
        ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken) =>
        TvHttp.OriginOf(current, http) is not { } origin
            ? TvProblems.Unauthenticated()
            : await ViewOrProblemAsync(handler, await handler.RefreshAsync(origin, cancellationToken), cancellationToken);

    private static async Task<IResult> SaveConfigAsync(LivreConfig? config, TvLivreHandler handler, CancellationToken cancellationToken)
    {
        var errors = LivreConfigValidator.Validate(config);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        await handler.SaveConfigAsync(config!, cancellationToken);
        return TypedResults.Ok(await handler.ViewAsync(cancellationToken));
    }

    /// <summary>
    /// Recebe a foto crua (<c>image/jpeg</c>). O teto é conferido antes de ler (pelo tamanho anunciado) e durante a leitura
    /// (que para um byte depois dele), para que um corpo sem tamanho ou mentiroso não encha a memória.
    /// </summary>
    private static async Task<IResult> SavePhotoAsync(HttpRequest request, TvLivreHandler handler, CancellationToken cancellationToken)
    {
        if (request.ContentLength > LivrePhoto.MaxBytes)
        {
            return LivreProblems.PhotoTooLarge();
        }

        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var mediaType)
            || !string.Equals(mediaType.MediaType.Value, LivrePhoto.ContentType, StringComparison.OrdinalIgnoreCase))
        {
            return LivreProblems.NotJpeg();
        }

        var buffer = new byte[LivrePhoto.MaxBytes + 1];
        var read = 0;
        while (read < buffer.Length)
        {
            var count = await request.Body.ReadAsync(buffer.AsMemory(read), cancellationToken);
            if (count == 0)
            {
                break;
            }

            read += count;
        }

        if (read > LivrePhoto.MaxBytes)
        {
            return LivreProblems.PhotoTooLarge();
        }

        if (!LivrePhoto.LooksLikeJpeg(buffer.AsSpan(0, read)))
        {
            return LivreProblems.NotJpeg();
        }

        await handler.SavePhotoAsync(buffer.AsSpan(0, read).ToArray(), cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ReadPhotoAsync(TvLivreHandler handler, CancellationToken cancellationToken)
    {
        if (await handler.ReadPhotoAsync(cancellationToken) is not { } photo)
        {
            return TypedResults.NotFound();
        }

        // A foto é do dono: o sha256 serve de ETag para a tela conferir se mudou. O Cache-Control: no-store já sai em toda
        // resposta da API (SecurityHeaders), então nenhum cache intermediário guarda a imagem.
        return TypedResults.File(photo.Data, LivrePhoto.ContentType, entityTag: new EntityTagHeaderValue($"\"{photo.Sha256}\""));
    }

    private static async Task<IResult> RemovePhotoAsync(TvLivreHandler handler, CancellationToken cancellationToken)
    {
        await handler.RemovePhotoAsync(cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ApplyAsync(
        ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken) =>
        TvHttp.OriginOf(current, http) is not { } origin
            ? TvProblems.Unauthenticated()
            : await ViewOrProblemAsync(handler, await handler.ApplyAsync(origin, cancellationToken), cancellationToken);

    private static async Task<IResult> InstallAsync(
        ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken) =>
        TvHttp.OriginOf(current, http) is not { } origin
            ? TvProblems.Unauthenticated()
            : await ViewOrProblemAsync(handler, await handler.InstallAsync(origin, cancellationToken), cancellationToken);

    private static async Task<IResult> SetHomeAsync(
        SetHomeRequest? request, ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken) =>
        TvHttp.OriginOf(current, http) is not { } origin
            ? TvProblems.Unauthenticated()
            : await ViewOrProblemAsync(
                handler, await handler.SetHomeAsync(origin, request?.DisableFactory ?? false, cancellationToken), cancellationToken);

    private static async Task<IResult> RestoreAsync(
        RestoreRequest? request, ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken) =>
        TvHttp.OriginOf(current, http) is not { } origin
            ? TvProblems.Unauthenticated()
            : await ViewOrProblemAsync(
                handler, await handler.RestoreAsync(origin, request?.Uninstall ?? true, cancellationToken), cancellationToken);

    private static async Task<IResult> SleepAsync(
        ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken)
    {
        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        return ToProblem(await handler.SleepAsync(origin, cancellationToken)) ?? TypedResults.NoContent();
    }

    private static async Task<IResult> VisibilityAsync(
        AppsVisibilityRequest? request, ICurrentUser current, HttpContext http, TvLivreHandler handler, CancellationToken cancellationToken)
    {
        var errors = LivreConfigValidator.ValidateVisibility(request);
        if (errors.Count > 0)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        if (TvHttp.OriginOf(current, http) is not { } origin)
        {
            return TvProblems.Unauthenticated();
        }

        var step = await handler.SetAppsAsync(origin, request!.Disable ?? [], request.Enable ?? [], cancellationToken);
        return await ViewOrProblemAsync(handler, step, cancellationToken);
    }

    private static async Task<IResult> ViewOrProblemAsync(TvLivreHandler handler, LivreStep step, CancellationToken cancellationToken) =>
        ToProblem(step) ?? TypedResults.Ok(await handler.ViewAsync(cancellationToken));

    /// <summary>Separado do HTTP para ser testado sem subir o servidor: o problema de um passo que não deu certo, ou nulo.</summary>
    internal static IResult? ToProblem(LivreStep step)
    {
        ArgumentNullException.ThrowIfNull(step);

        return step.Kind switch
        {
            LivreStepKind.Done => null,
            LivreStepKind.Unsupported => LivreProblems.Unsupported(),
            LivreStepKind.Busy => LivreProblems.Busy(),
            _ => LivreProblems.Fail(step.Outcome!),
        };
    }
}
