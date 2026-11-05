using System.Text.RegularExpressions;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Qual esqueleto de abertura cobre um endereço. É a mesma regra de <c>public/boot-skeleton.js</c> e do
/// <c>boot-variant.ts</c> do web: os três são testados contra <c>contracts/boot-variants.json</c>. A API grava o
/// resultado em <c>&lt;html data-boot&gt;</c> para o primeiro quadro já ter o desenho certo, sem esperar o script.
/// </summary>
internal static partial class BootVariants
{
    public const string Home = "home";

    private static readonly (Func<string, bool> Matches, string Variant)[] Rules =
    [
        (p => p is "/" or "/index.html", Home),
        (p => IsAt(p, "/tv"), "tv"),
        (p => IsAt(p, "/pc"), "pc"),
        (p => p == "/treino/sessao/exercicio", "training-session-exercise"),
        (p => p == "/treino/sessao", "training-session"),
        (p => p == "/treino/glossario", "training-glossary"),
        (p => ExerciseEdit().IsMatch(p) || p == "/treino/exercicios/novo", "training-exercise-form"),
        (p => p == "/treino/exercicios/mapa", "training-map"),
        (p => ExerciseDetail().IsMatch(p), "training-exercise-detail"),
        (p => p == "/treino/exercicios", "training-library"),
        (p => p == "/treino/rotinas", "training-routines"),
        (p => p.StartsWith("/treino/rotinas/", StringComparison.Ordinal), "training-routine-editor"),
        (p => p == "/treino/progresso", "training-progress"),
        (p => p == "/treino/alimentacao", "training-food"),
        (p => p == "/treino/corpo/avaliacoes/importar", "training-assessment-import"),
        (p => p == "/treino/corpo/avaliacoes/nova" || AssessmentEdit().IsMatch(p), "training-assessment-editor"),
        (p => AssessmentDetail().IsMatch(p), "training-assessment-detail"),
        (p => p == "/treino/corpo/avaliacoes", "training-assessments"),
        (p => p == "/treino/corpo", "training-body"),
        (p => p == "/treino", "training-today"),
        (p => p == "/ajustes", "settings"),
        (p => p == "/ajustes/perfil", "settings-profile"),
        (p => p == "/ajustes/aparencia", "settings-appearance"),
        (p => p == "/ajustes/seguranca", "settings-security"),
        (p => p == "/ajustes/seguranca/siri", "settings-siri"),
        (p => p == "/ajustes/pessoas", "settings-people"),
        (p => p == "/ajustes/tvs-por-pessoa", "settings-tv-people"),
        (p => TvHistory().IsMatch(p), "settings-tv-history"),
        (p => p == "/ajustes/auditoria", "settings-audit"),
        (p => p == "/ajustes/sistema", "settings-system"),
        (p => p is "/ajustes/dispositivos" or "/ajustes/aparelhos", "settings-devices"),
        (p => p is "/ajustes/sobre/creditos" or "/ajustes/creditos", "settings-credits"),
        (p => p == "/ajustes/sobre", "settings-about"),
        (p => p == "/entrar/qr", "auth-qr"),
        (p => p == "/entrar", "auth-login"),
        (p => p == "/recuperar-senha", "auth-recovery"),
        (p => p == "/redefinir-senha", "auth-reset"),
        (p => p == "/convite", "auth-invite"),
        (p => p == "/boas-vindas", "auth-welcome"),
        (p => p == "/conectar", "devices-connect"),
    ];

    /// <summary>O desenho de um caminho (sem query nem hash); rota desconhecida cai na Início, como no web.</summary>
    public static string For(string? path)
    {
        var trimmed = (path ?? string.Empty).TrimEnd('/');
        var pathname = trimmed.Length == 0 ? "/" : trimmed;
        foreach (var (matches, variant) in Rules)
        {
            if (matches(pathname))
            {
                return variant;
            }
        }

        return Home;
    }

    private static bool IsAt(string path, string root) =>
        path == root || path.StartsWith(root + "/", StringComparison.Ordinal);

    [GeneratedRegex(@"^/treino/exercicios/[^/]+/editar$")]
    private static partial Regex ExerciseEdit();

    [GeneratedRegex(@"^/treino/exercicios/[^/]+$")]
    private static partial Regex ExerciseDetail();

    [GeneratedRegex(@"^/treino/corpo/avaliacoes/[^/]+/editar$")]
    private static partial Regex AssessmentEdit();

    [GeneratedRegex(@"^/treino/corpo/avaliacoes/[^/]+$")]
    private static partial Regex AssessmentDetail();

    [GeneratedRegex(@"^/ajustes/tv/[^/]+/historico$")]
    private static partial Regex TvHistory();
}
