using System.Text.RegularExpressions;
using AwesomeAssertions;
using UniOver.BuildingBlocks.Persistence;
using static UniOver.ArchitectureTests.ModuleDiscovery;

namespace UniOver.ArchitectureTests;

/// <summary>
/// A retenção da auditoria também roda na esteira de publicação: o plano gratuito do Render dorme, e o serviço só limpa 10
/// minutos depois da partida, então a limpeza poderia nunca acontecer. Estas regras vigiam o passo do workflow: que ele
/// existe depois das migrations, que chama a função de cada schema com o prazo da política (e não um número solto) e que
/// não vaza a conexão.
/// </summary>
public partial class DeployWorkflowTests
{
    [GeneratedRegex("""\("(?<schema>[a-z_]+)",\s*(?<days>\d+)\)""", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 500)]
    private static partial Regex PurgePair();

    private static string Workflow() => File.ReadAllText(Path.GetFullPath(Path.Combine(ApiRoot, "..", "..", ".github", "workflows", "deploy.yml")));

    /// <summary>O texto do passo de retenção (do nome dele até o fim do job <c>migrate</c>).</summary>
    private static string PurgeStep()
    {
        var text = Workflow();
        var start = text.IndexOf("- name: Limpar a auditoria vencida", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "o job migrate precisa do passo de retenção");
        var end = text.IndexOf("\n  deploy:", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "o passo fica dentro do job migrate, antes do job deploy");
        return text[start..end];
    }

    [Fact]
    public void ThePurgeStep_RunsAfterTheMigrations_InTheMigrateJob()
    {
        var text = Workflow();

        var migrate = text.IndexOf("bash scripts/migrate-all.sh", StringComparison.Ordinal);
        var purge = text.IndexOf("- name: Limpar a auditoria vencida", StringComparison.Ordinal);

        migrate.Should().BeGreaterThan(0);
        purge.Should().BeGreaterThan(migrate, "as funções de retenção são criadas por migration: o passo vem depois delas");
        purge.Should().BeLessThan(text.IndexOf("\n  deploy:", StringComparison.Ordinal), "e ainda dentro do job migrate (que tem o papel dono)");
    }

    [Fact]
    public void ThePurgeStep_CallsOneFunctionPerAuditSchema_WithTheDaysOfThePolicy()
    {
        var pairs = PurgePair().Matches(PurgeStep())
            .ToDictionary(m => m.Groups["schema"].Value, m => int.Parse(m.Groups["days"].Value, System.Globalization.CultureInfo.InvariantCulture));

        pairs.Keys.Should().BeEquivalentTo(AppendOnlyTables.All.Keys, "todo schema com tabela de auditoria precisa ser limpo aqui");
        pairs["identity"].Should().Be(AuditRetentionPolicy.SecurityDays);
        pairs["devices"].Should().Be(AuditRetentionPolicy.SecurityDays);
        pairs["tv"].Should().Be(AuditRetentionPolicy.CommandDays);
        PurgeStep().Should().Contain("purge_audit", "é o nome da função criada pelas migrations");
    }

    [Fact]
    public void ThePurgeStep_NeverPrintsTheConnection_AndMasksEachPartBeforeUsingIt()
    {
        var step = PurgeStep();

        step.Should().NotContain("set -x").And.NotContain("set -o xtrace").And.NotContain("printenv").And.NotContain("env |");
        step.Split('\n').Where(line => line.Contains("echo", StringComparison.Ordinal) && line.Contains("DB_OWNER_CONNECTION", StringComparison.Ordinal))
            .Should().OnlyContain(line => line.Contains("::add-mask::", StringComparison.Ordinal), "só o ::add-mask:: pode citar a conexão num echo");
        step.Should().Contain("DB_OWNER_CONNECTION: ${{ secrets.NEON_OWNER_CONNECTION }}", "o segredo é remapeado no passo: variável de passo não passa para o seguinte");
        step.IndexOf("::add-mask::", StringComparison.Ordinal).Should().BeGreaterThan(0);
        step.IndexOf("::add-mask::", StringComparison.Ordinal).Should().BeLessThan(step.IndexOf("subprocess.run", StringComparison.Ordinal));
        step.Should().Contain("\"PGPASSWORD\"", "a senha vai por variável de ambiente do processo, nunca pela linha de comando");
        step.Should().NotContain("--password").And.NotContain("postgresql://");
    }

    [Fact]
    public void ThePurgeStep_NeverBlocksThePublication()
    {
        PurgeStep().Should().Contain("continue-on-error: true",
            "limpar é manutenção: uma falha aqui não pode impedir o deploy (o serviço tenta de novo no intervalo seguinte)");
    }
}
