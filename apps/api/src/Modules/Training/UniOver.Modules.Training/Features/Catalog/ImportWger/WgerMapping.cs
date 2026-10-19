using System.Net;
using System.Text.RegularExpressions;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Features.Catalog.ImportWger;

/// <summary>
/// Tradução do vocabulário do wger (ids numéricos dele) para a taxonomia fechada do app, e limpeza do texto: a descrição
/// do wger vem em HTML e o app só mostra texto puro.
/// </summary>
internal static partial class WgerMapping
{
    /// <summary>Licença CC-BY-SA 4.0 no wger (id 2): a única que o importador aceita.</summary>
    public const int LicenseIdCcBySa4 = 2;

    public const string LicenseName = "CC-BY-SA 4";
    public const string LicenseUrl = "https://creativecommons.org/licenses/by-sa/4.0/";

    // Ids dos músculos do wger (conferidos na API deles em 19/10/2026: /api/v2/muscle/) para os ids da taxonomia do app.
    private static readonly Dictionary<int, string> Muscles = new()
    {
        [1] = Muscle.Biceps,
        [2] = Muscle.Shoulders,
        [3] = Muscle.Chest,
        [4] = Muscle.Chest,
        [5] = Muscle.Triceps,
        [6] = Muscle.Abdominals,
        [7] = Muscle.Calves,
        [8] = Muscle.Glutes,
        [9] = Muscle.Traps,
        [10] = Muscle.Quadriceps,
        [11] = Muscle.Hamstrings,
        [12] = Muscle.Lats,
        [13] = Muscle.Biceps,
        [14] = Muscle.Abdominals,
        [15] = Muscle.Calves,
    };

    // Ids dos equipamentos do wger (/api/v2/equipment/). Sem equipamento listado, é peso do corpo.
    private static readonly Dictionary<int, string> Equipments = new()
    {
        [1] = Equipment.Barbell,
        [2] = Equipment.Barbell,
        [3] = Equipment.Dumbbell,
        [12] = Equipment.Cable,
        [6] = Equipment.Bodyweight,
        [7] = Equipment.Bodyweight,
    };

    public const int InstructionsMax = Exercise.InstructionsMax;

    /// <summary>Músculos do app, sem repetição e na ordem em que o wger os lista; ids desconhecidos ficam de fora.</summary>
    public static List<string> MapMuscles(IEnumerable<int> ids) =>
        [.. ids.Select(id => Muscles.GetValueOrDefault(id)).Where(m => m is not null).Select(m => m!).Distinct(StringComparer.Ordinal)];

    /// <summary>Músculos secundários: os do wger sem repetir os principais, no máximo seis (o mesmo teto do exercício próprio).</summary>
    public static List<string> MapSecondary(IEnumerable<int> ids, IReadOnlyCollection<string> primary) =>
        [.. MapMuscles(ids).Where(m => !primary.Contains(m, StringComparer.Ordinal)).Take(6)];

    public static string MapEquipment(IReadOnlyList<int> ids)
    {
        if (ids.Count == 0)
        {
            return Equipment.Bodyweight;
        }

        foreach (var id in ids)
        {
            if (Equipments.TryGetValue(id, out var mapped) && mapped != Equipment.Bodyweight)
            {
                return mapped;
            }
        }

        // Só equipamento sem par na taxonomia (banco, bola, kettlebell...): "outro", e nunca peso do corpo por engano.
        return ids.All(id => Equipments.TryGetValue(id, out var m) && m == Equipment.Bodyweight) ? Equipment.Bodyweight : Equipment.Other;
    }

    /// <summary>Descrição em HTML para uma lista de passos em texto puro (parágrafos e itens viram um passo cada).</summary>
    public static List<string> ToInstructions(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return [];
        }

        var withBreaks = BlockEnd().Replace(html, "\n");
        var text = WebUtility.HtmlDecode(Tags().Replace(withBreaks, string.Empty));
        var steps = new List<string>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var clean = Spaces().Replace(line, " ").Trim();
            if (clean.Length == 0)
            {
                continue;
            }

            steps.Add(clean.Length <= Exercise.InstructionMax ? clean : clean[..Exercise.InstructionMax].TrimEnd());
            if (steps.Count == InstructionsMax)
            {
                break;
            }
        }

        return steps;
    }

    [GeneratedRegex(@"</p\s*>|</li\s*>|<br\s*/?>|</div\s*>|</h[1-6]\s*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex BlockEnd();

    [GeneratedRegex(@"<[^>]*>", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex Tags();

    [GeneratedRegex(@"[ \t\r\f\v]+", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex Spaces();
}
