using System.Text.RegularExpressions;
using AwesomeAssertions;

namespace UniOver.ArchitectureTests;

/// <summary>
/// A publicação não pode terminar "verde" sem publicar, nem falhar em silêncio. Estas regras vigiam o workflow: os
/// pré-requisitos são conferidos ANTES de migrar (sem o hook do Render o banco não avança), a falta do hook é falha, o aviso
/// de falha é uma issue escrita só por um job sem segredos nem ações de terceiros, e toda ação continua fixada por SHA.
/// </summary>
public partial class DeployWorkflowTests
{
    [GeneratedRegex(@"^  (?<name>[a-z][a-z0-9_-]*):\s*$", RegexOptions.Multiline | RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 500)]
    private static partial Regex JobHeader();

    [GeneratedRegex(@"uses:\s*(?<action>\S+)", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 500)]
    private static partial Regex UsesLine();

    /// <summary>O texto de um job (do nome dele até o começo do próximo), só dentro de <c>jobs:</c>.</summary>
    private static string Job(string name)
    {
        var text = Workflow();
        var jobs = text.IndexOf("\njobs:\n", StringComparison.Ordinal);
        jobs.Should().BeGreaterThan(0);
        var headers = JobHeader().Matches(text).Where(m => m.Index > jobs).ToList();
        var index = headers.FindIndex(m => m.Groups["name"].Value == name);
        index.Should().BeGreaterThanOrEqualTo(0, $"o workflow precisa do job {name}");
        var start = headers[index].Index;
        var end = index + 1 < headers.Count ? headers[index + 1].Index : text.Length;
        return text[start..end];
    }

    [Fact]
    public void ThePrerequisites_AreCheckedFirstInTheMigrateJob_BeforeAnythingTouchesTheDatabase()
    {
        var migrate = Job("migrate");

        var check = migrate.IndexOf("- name: Conferir os pré-requisitos da publicação", StringComparison.Ordinal);
        check.Should().BeGreaterThan(0);
        check.Should().BeLessThan(migrate.IndexOf("actions/checkout", StringComparison.Ordinal), "é o primeiro passo do job");
        check.Should().BeLessThan(migrate.IndexOf("bash scripts/migrate-all.sh", StringComparison.Ordinal));
        var step = migrate[check..migrate.IndexOf("actions/checkout", StringComparison.Ordinal)];
        step.Should().Contain("secrets.RENDER_DEPLOY_HOOK_URL").And.Contain("secrets.NEON_OWNER_CONNECTION");
        step.Should().Contain("exit \"$missing\"", "a ausência de qualquer um dos dois falha o job");
        Job("migrate").Should().Contain("environment: production", "os dois segredos são do ambiente production");
    }

    [Fact]
    public void AMissingHook_IsAFailure_NeverAWarningThatLeavesTheRunGreen()
    {
        var deploy = Job("deploy");

        deploy.Should().NotContain("deployed=false", "não existe mais o caminho \"migrou mas não publicou\"");
        deploy.Should().NotContain("::warning::o segredo RENDER_DEPLOY_HOOK_URL");
        var guard = deploy.IndexOf("if [ -z \"$HOOK_URL\" ]", StringComparison.Ordinal);
        guard.Should().BeGreaterThan(0);
        deploy[guard..deploy.IndexOf("\n          fi", guard, StringComparison.Ordinal)].Should().Contain("::error::").And.Contain("exit 1");
        Workflow().Should().Contain("deployed=true");
    }

    [Fact]
    public void TheFailureNotice_IsAnIssueWrittenByOneJobThatHasNoSecretsAndNoThirdPartyActions()
    {
        var notify = Job("notify");

        notify.Should().Contain("issues: write");
        notify.Should().NotContain("contents:", "o aviso não lê nem escreve o código");
        notify.Should().NotContain("uses:", "só o gh que já vem no runner: nenhuma ação de terceiros no job que escreve em issues");
        notify.Should().NotContain("secrets.", "o token do próprio workflow basta");
        notify.Should().NotContain("persist-credentials").And.NotContain("checkout");
        foreach (var job in new[] { "version", "migrate", "deploy", "dast", "release", "launcher" })
        {
            Regex.IsMatch(notify, @"needs: \[[^\]]*\b" + job + @"\b", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)).Should().BeTrue($"o aviso precisa esperar o job {job}");
        }

        notify.Should().Contain("always()", "roda também quando um job anterior falhou");
        notify.Should().Contain("needs.channel.outputs.ref == github.ref_name", "só na branch de produção");
        notify.Should().Contain("Publicação falhou").And.Contain("gh issue close");
        notify.Should().Contain("body=\"@$MENTION ", "a menção é o que faz o GitHub notificar o dono, na abertura e em cada comentário");
        notify.Should().Contain("github.repository_owner");
    }

    [Fact]
    public void TheAlertDrill_NeverPublishes_NorTouchesTheRealIssue()
    {
        Job("version").Should().Contain("&& !inputs.alert_drill", "o ensaio pula version e, com ele, tudo o que publica");
        Workflow().Should().Contain("inputs.alert_drill && 'deploy-alert-drill' || 'deploy-production'", "o ensaio não toma o lugar de uma publicação na fila");
        Job("alert-drill").Should().NotContain("secrets.").And.NotContain("environment:");
        Job("notify").Should().Contain("title=\"Ensaio do alerta de publicação\"", "o ensaio usa outra issue e nunca comenta nem fecha a real");
    }

    [Fact]
    public void OnlyTheNoticeJobWritesToIssues_AndOnlyReleaseAndLauncherWriteToContents()
    {
        var text = Workflow();

        Regex.Matches(text, "issues: write", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)).Should().ContainSingle();
        foreach (var job in new[] { "channel", "version", "migrate", "deploy", "dast", "notify" })
        {
            Job(job).Should().NotContain("contents: write", $"o job {job} não escreve no repositório");
        }

        Job("release").Should().Contain("contents: write");
        Job("launcher").Should().Contain("contents: write");
        text[..text.IndexOf("\njobs:\n", StringComparison.Ordinal)].Should().Contain("contents: read").And.NotContain("write");
    }

    [Fact]
    public void EveryActionIsPinnedToACommitSha()
    {
        var uses = UsesLine().Matches(Workflow()).Select(m => m.Groups["action"].Value).ToList();

        uses.Should().NotBeEmpty();
        uses.Should().OnlyContain(action => IsPinned(action) || IsLocalWorkflow(action),
            "ação por tag ou ramo muda sem revisão; a pinagem por SHA é a regra do repositório (só um workflow reutilizável do próprio repositório dispensa o SHA)");
    }

    [Fact]
    public void OnlyWorkflowsOfThisRepositoryMayBeReferencedWithoutAnSha()
    {
        // A exceção é estreita: `./.github/workflows/<arquivo>.yml` que EXISTE neste repositório. Ação ou workflow externo (mesmo
        // com `..`, outro diretório, subpasta ou sem a extensão) continua exigindo o SHA.
        IsLocalWorkflow("./.github/workflows/web-assets.yml").Should().BeTrue();
        IsLocalWorkflow("./.github/workflows/nao-existe.yml").Should().BeFalse();
        IsLocalWorkflow("./.github/workflows/../../fora.yml").Should().BeFalse();
        IsLocalWorkflow("./.github/actions/x").Should().BeFalse();
        IsLocalWorkflow("./.github/workflows/sub/web-assets.yml").Should().BeFalse();
        IsLocalWorkflow("octo/repo/.github/workflows/web-assets.yml@main").Should().BeFalse();
        IsLocalWorkflow("actions/checkout@v4").Should().BeFalse();
        IsPinned("actions/checkout@v4").Should().BeFalse();
        IsPinned("octo/repo/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1").Should().BeTrue();
    }

    private static bool IsPinned(string action) =>
        Regex.IsMatch(action, "^[\\w.-]+/[\\w./-]+@[0-9a-f]{40}$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    /// <summary>Referência local a um workflow reutilizável do próprio repositório: <c>./.github/workflows/&lt;arquivo&gt;.yml</c>, que existe.</summary>
    private static bool IsLocalWorkflow(string action)
    {
        var match = Regex.Match(action, "^\\./\\.github/workflows/(?<file>[\\w][\\w.-]*\\.ya?ml)$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        return match.Success
            && !match.Groups["file"].Value.Contains("..", StringComparison.Ordinal)
            && File.Exists(Path.GetFullPath(Path.Combine(ModuleDiscovery.ApiRoot, "..", "..", ".github", "workflows", match.Groups["file"].Value)));
    }
}
