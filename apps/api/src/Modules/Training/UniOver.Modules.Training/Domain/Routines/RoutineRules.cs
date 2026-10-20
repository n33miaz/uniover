namespace UniOver.Modules.Training.Domain.Routines;

/// <summary>Um item como chega na escrita, já validado campo a campo (a ordem e as superséries ainda não).</summary>
public sealed record RoutineItemSpec(
    Guid Id,
    Guid ExerciseId,
    int Position,
    int TargetSets,
    int RepMin,
    int RepMax,
    int RestSeconds,
    int? SupersetGroup,
    string? Note);

/// <summary>Regras puras da rotina: ordem dos itens e superséries.</summary>
public static class RoutineRules
{
    /// <summary>
    /// Ordena pela posição que o aparelho mandou (empate: ordem em que vieram) e recompacta em 0, 1, 2... O servidor é
    /// quem decide a posição final: lacunas e repetições vindas do aparelho não chegam ao banco.
    /// </summary>
    public static IReadOnlyList<RoutineItemSpec> Arrange(IReadOnlyList<RoutineItemSpec> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        return [.. items
            .Select((item, index) => (item, index))
            .OrderBy(x => x.item.Position)
            .ThenBy(x => x.index)
            .Select((x, position) => x.item with { Position = position })];
    }

    /// <summary>
    /// Supersérie = itens <b>vizinhos</b> com o mesmo número de grupo. Recebe a lista já arrumada (<see cref="Arrange"/>):
    /// um grupo que reaparece depois de outro item no meio não é supersérie.
    /// </summary>
    public static bool SupersetsAreContiguous(IReadOnlyList<RoutineItemSpec> arranged)
    {
        ArgumentNullException.ThrowIfNull(arranged);

        var closed = new HashSet<int>();
        int? current = null;
        foreach (var item in arranged)
        {
            if (item.SupersetGroup == current)
            {
                continue;
            }

            if (current is { } previous)
            {
                closed.Add(previous);
            }

            current = item.SupersetGroup;
            if (current is { } group && closed.Contains(group))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Um grupo com um item só não junta ninguém: vira "sem supersérie". Assim o que o servidor guarda é o mesmo que o
    /// aparelho já normaliza, e nenhuma supersérie fica com um item.
    /// </summary>
    public static IReadOnlyList<RoutineItemSpec> NormalizeSupersets(IReadOnlyList<RoutineItemSpec> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var sizes = items
            .Where(i => i.SupersetGroup is not null)
            .GroupBy(i => i.SupersetGroup!.Value)
            .ToDictionary(g => g.Key, g => g.Count());
        return [.. items.Select(i => i.SupersetGroup is { } g && sizes[g] < 2 ? i with { SupersetGroup = null } : i)];
    }
}
