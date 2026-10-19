using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Persistence;

namespace UniOver.Modules.Training.Features.Catalog.SetExerciseStep;

internal static class SetExerciseStepValidator
{
    public const decimal StepMax = 1000m;

    public static Dictionary<string, string[]> Validate(
        Guid id, SetExerciseStepRequest? request, Guid userId, out SetExerciseStepCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe o salto de carga no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id do exercício é obrigatório."];
        }

        if (request.StepKg is { } step && (step < 0 || step > StepMax || decimal.Round(step, 2) != step))
        {
            errors["stepKg"] = [$"O salto de carga deve ficar entre 0 e {StepMax} kg, com no máximo 2 casas."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        if (errors.Count == 0)
        {
            command = new SetExerciseStepCommand(userId, id, request.StepKg, TimeStamps.ToStorage(request.ClientUpdatedAt!.Value));
        }

        return errors;
    }
}

internal static class SetExerciseStepEndpoint
{
    public static void MapSetExerciseStep(this IEndpointRouteBuilder group) =>
        group.MapPut("/exercises/{id:guid}/step", HandleAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Commands)
            .Produces<ExerciseResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .RequireIdempotency<TrainingDbContext>();

    private static async Task<IResult> HandleAsync(
        Guid id,
        SetExerciseStepRequest? request,
        ICurrentUser current,
        SetExerciseStepHandler handler,
        CancellationToken cancellationToken)
    {
        if (current.UserId is not { } userId)
        {
            return CatalogProblems.Unauthenticated();
        }

        var errors = SetExerciseStepValidator.Validate(id, request, userId, out var command);
        if (errors.Count > 0 || command is null)
        {
            return ProblemDetailsExtensions.ValidationProblem(errors);
        }

        var result = await handler.HandleAsync(command, cancellationToken);
        return result.Outcome switch
        {
            SetStepOutcome.Ok => TypedResults.Ok(result.Exercise),
            SetStepOutcome.ClockAhead => CatalogProblems.ClientClockAhead(),
            _ => CatalogProblems.NotFound(),
        };
    }
}
