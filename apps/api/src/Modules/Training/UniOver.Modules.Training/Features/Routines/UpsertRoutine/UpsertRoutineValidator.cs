using UniOver.Modules.Training.Domain;
using UniOver.Modules.Training.Domain.Routines;

namespace UniOver.Modules.Training.Features.Routines.UpsertRoutine;

/// <summary>Validação da borda da rotina: nada chega ao handler sem passar por aqui.</summary>
internal static class UpsertRoutineValidator
{
    public static Dictionary<string, string[]> Validate(
        Guid id, UpsertRoutineRequest? request, Guid userId, out UpsertRoutineCommand? command)
    {
        command = null;
        var errors = new Dictionary<string, string[]>();

        if (request is null)
        {
            errors["body"] = ["Informe a rotina no corpo da requisição."];
            return errors;
        }

        if (id == Guid.Empty)
        {
            errors["id"] = ["O id da rotina é obrigatório."];
        }

        var name = request.Name?.Trim() ?? string.Empty;
        if (name.Length is 0 or > RoutineLimits.NameMax)
        {
            errors["name"] = [$"O nome deve ter de 1 a {RoutineLimits.NameMax} caracteres."];
        }

        if (request.Position is null or < 0 or > RoutineLimits.PositionMax)
        {
            errors["position"] = [$"A posição deve ficar entre 0 e {RoutineLimits.PositionMax}."];
        }

        if (request.Active is null)
        {
            errors["active"] = ["Informe se a rotina está ativa."];
        }

        var note = request.Note?.Trim();
        if (note is { Length: > RoutineLimits.NoteMax })
        {
            errors["note"] = [$"A anotação aceita até {RoutineLimits.NoteMax} caracteres."];
        }

        if (request.ClientUpdatedAt is null || request.ClientUpdatedAt == default(DateTimeOffset))
        {
            errors["clientUpdatedAt"] = ["Informe o instante da escrita no aparelho."];
        }

        // Na lápide os itens são ignorados (ficam como estavam): o aparelho manda a rotina inteira, mas só o apagamento vale.
        var items = new List<RoutineItemSpec>();
        if (!request.Deleted)
        {
            ValidateItems(request.Items, errors, items);
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        command = new UpsertRoutineCommand(
            userId,
            id,
            name,
            request.Position!.Value,
            request.Active!.Value,
            string.IsNullOrEmpty(note) ? null : note,
            items,
            TimeStamps.ToStorage(request.ClientUpdatedAt!.Value),
            request.Deleted);
        return errors;
    }

    private static void ValidateItems(
        IReadOnlyList<UpsertRoutineItemRequest>? requested, Dictionary<string, string[]> errors, List<RoutineItemSpec> items)
    {
        if (requested is null)
        {
            errors["items"] = ["Informe os itens da rotina."];
            return;
        }

        if (requested.Count > RoutineLimits.MaxItems)
        {
            errors["items"] = [$"A rotina aceita até {RoutineLimits.MaxItems} itens."];
            return;
        }

        var seen = new HashSet<Guid>();
        for (var index = 0; index < requested.Count; index++)
        {
            var field = $"items[{index}]";
            var item = requested[index];
            if (item is null)
            {
                errors[field] = ["O item não pode ser nulo."];
                continue;
            }

            var itemErrors = ItemErrors(item);
            if (item.Id is { } itemId && itemId != Guid.Empty && !seen.Add(itemId))
            {
                itemErrors.Add("O id do item está repetido.");
            }

            if (itemErrors.Count > 0)
            {
                errors[field] = [.. itemErrors];
                continue;
            }

            items.Add(new RoutineItemSpec(
                item.Id!.Value,
                item.ExerciseId!.Value,
                item.Position!.Value,
                item.TargetSets!.Value,
                item.RepMin!.Value,
                item.RepMax!.Value,
                item.RestSeconds!.Value,
                item.SupersetGroup,
                string.IsNullOrWhiteSpace(item.Note) ? null : item.Note.Trim()));
        }
    }

    private static List<string> ItemErrors(UpsertRoutineItemRequest item)
    {
        var problems = new List<string>();

        if (item.Id is null || item.Id == Guid.Empty)
        {
            problems.Add("O id do item é obrigatório.");
        }

        if (item.ExerciseId is null || item.ExerciseId == Guid.Empty)
        {
            problems.Add("O exercício do item é obrigatório.");
        }

        if (item.Position is null or < 0 or > RoutineLimits.PositionMax)
        {
            problems.Add($"A posição do item deve ficar entre 0 e {RoutineLimits.PositionMax}.");
        }

        if (item.TargetSets is null or < RoutineLimits.SetsMin or > RoutineLimits.SetsMax)
        {
            problems.Add($"As séries devem ficar entre {RoutineLimits.SetsMin} e {RoutineLimits.SetsMax}.");
        }

        var repsInRange = item.RepMin is { } min && item.RepMax is { } max
            && min >= RoutineLimits.RepsMin && max <= RoutineLimits.RepsMax && min <= max;
        if (!repsInRange)
        {
            problems.Add($"A faixa de repetições deve ficar entre {RoutineLimits.RepsMin} e {RoutineLimits.RepsMax}, com o mínimo não maior que o máximo.");
        }

        if (item.RestSeconds is null or < 0 or > RoutineLimits.RestMax)
        {
            problems.Add($"O descanso deve ficar entre 0 e {RoutineLimits.RestMax} segundos.");
        }

        if (item.SupersetGroup is { } group && (group < RoutineLimits.SupersetGroupMin || group > RoutineLimits.SupersetGroupMax))
        {
            problems.Add($"O grupo de supersérie deve ficar entre {RoutineLimits.SupersetGroupMin} e {RoutineLimits.SupersetGroupMax}.");
        }

        if (item.Note?.Trim() is { Length: > RoutineLimits.ItemNoteMax })
        {
            problems.Add($"A anotação do item aceita até {RoutineLimits.ItemNoteMax} caracteres.");
        }

        return problems;
    }
}
