using System.Reflection;
using AwesomeAssertions;
using Microsoft.Extensions.Logging;

namespace UniOver.ArchitectureTests;

/// <summary>
/// Regra de log do projeto: o que se registra de uma falha é só o TIPO do erro (<c>ex.GetType().Name</c>), nunca o objeto
/// da exceção. A mensagem do driver do banco (e a de uma falha de rede) pode citar o servidor e a conexão, e o log vai
/// para um painel de terceiros. Uma mensagem de log declarada com <c>[LoggerMessage]</c> que recebe uma
/// <see cref="Exception"/> quebra a regra.
/// </summary>
public class LoggingRulesTests
{
    /// <summary>
    /// Exceções DE PROPÓSITO, cada uma com o motivo. <c>GlobalExceptionHandler</c> é o último recurso de um erro que ninguém
    /// previu: sem a pilha não há como achar a causa de um 500 em produção. O Treino é de outra frente de trabalho; a
    /// exceção dele é de um cliente HTTP externo, cuja mensagem é um texto fixo do projeto.
    /// </summary>
    private static readonly string[] Allowed =
    [
        "GlobalExceptionHandler.LogUnhandled",
        "ImportWgerHandler.LogInterrupted",
    ];

    private static IEnumerable<Assembly> ProductAssemblies() =>
        Directory.GetFiles(AppContext.BaseDirectory, "UniOver.*.dll")
            .Where(f => !Path.GetFileName(f).Contains("Tests", StringComparison.Ordinal))
            .Select(f => Assembly.Load(Path.GetFileNameWithoutExtension(f)));

    private static IEnumerable<MethodInfo> LogMessages() =>
        ProductAssemblies()
            .SelectMany(a => a.GetTypes())
            .SelectMany(t => t.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Where(m => m.GetCustomAttributes<LoggerMessageAttribute>().Any());

    [Fact]
    public void TheRuleSeesTheLogMessagesOfTheModules()
    {
        // Sem isto a regra abaixo passaria sem olhar nada (o atributo não chegou aos metadados, ou os módulos não carregaram).
        var names = LogMessages().Select(m => $"{m.DeclaringType!.Name}.{m.Name}").ToList();

        names.Should().Contain(["TvAgentResolver.LogReadFailed", "AgentHub.LogSessionFailed", "GlobalExceptionHandler.LogUnhandled"]);
    }

    [Fact]
    public void NoLogMessage_TakesAnException_ExceptTheOnesListedWithAReason()
    {
        var offenders = LogMessages()
            .Where(m => m.GetParameters().Any(p => typeof(Exception).IsAssignableFrom(p.ParameterType)))
            .Select(m => $"{m.DeclaringType!.Name}.{m.Name}")
            .Where(name => !Allowed.Contains(name))
            .Order(StringComparer.Ordinal)
            .ToList();

        offenders.Should().BeEmpty(
            "registre só o tipo do erro (ex.GetType().Name) num parâmetro string: a mensagem do driver pode citar servidor e conexão");
    }
}
