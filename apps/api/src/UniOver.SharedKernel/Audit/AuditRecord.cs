namespace UniOver.SharedKernel.Audit;

/// <summary>Como terminou a ação registrada. O texto estável (<see cref="AuditOutcomes"/>) é o que sai pela API.</summary>
public enum AuditOutcome
{
    /// <summary>A ação foi feita (ou, para uma negativa, a negativa foi feita).</summary>
    Success,

    /// <summary>A ação não se completou: senha errada, confirmação que não conferiu, comando que a TV não executou.</summary>
    Failure,

    /// <summary>O sistema recusou por regra: conta bloqueada, token reutilizado, pareamento negado.</summary>
    Denied,
}

/// <summary>Os códigos de texto do resultado, estáveis: a tela e a exportação os leem.</summary>
public static class AuditOutcomes
{
    public const string Success = "success";
    public const string Failure = "failure";
    public const string Denied = "denied";

    public static IReadOnlyList<string> All { get; } = [Success, Failure, Denied];

    public static string ToCode(AuditOutcome outcome) => outcome switch
    {
        AuditOutcome.Success => Success,
        AuditOutcome.Failure => Failure,
        AuditOutcome.Denied => Denied,
        _ => throw new ArgumentOutOfRangeException(nameof(outcome)),
    };

    /// <summary>Comparação exata: o filtro vem de um cliente e "Success" não é um código.</summary>
    public static bool TryParse(string? code, out AuditOutcome outcome)
    {
        switch (code)
        {
            case Success:
                outcome = AuditOutcome.Success;
                return true;
            case Failure:
                outcome = AuditOutcome.Failure;
                return true;
            case Denied:
                outcome = AuditOutcome.Denied;
                return true;
            default:
                outcome = default;
                return false;
        }
    }
}

/// <summary>
/// Uma linha da trilha de auditoria de qualquer módulo, no formato comum que o administrador lê. Nunca leva segredo,
/// e-mail digitado nem o conteúdo de um texto digitado na TV: cada fonte só entrega o que o próprio módulo já grava
/// como código curto escolhido pelo servidor.
/// </summary>
/// <param name="Id">Id da linha na tabela de origem (desempate estável da paginação).</param>
/// <param name="Module">A fonte: <c>identity</c>, <c>devices</c>, <c>tv</c>.</param>
/// <param name="Action">Código estável da ação (por exemplo <c>login_failed</c>, <c>tv.key</c>).</param>
/// <param name="ActorId">
/// A conta que agiu; nula quando ninguém estava autenticado: a tela mostra isso como "alguém sem login" (tentativa de
/// login ou de refresh contra uma conta, login de e-mail desconhecido, agente). Nesses casos a conta atingida vai em
/// <paramref name="TargetUserId"/>, e nunca como autora.
/// </param>
/// <param name="Target">Sobre o quê: tecla, pacote do app, id de convite ou de passkey, nome do aparelho. Texto curto do servidor.</param>
/// <param name="TargetUserId">A conta que sofreu a ação, quando a ação é sobre outra conta (revogar convidado, mudar permissões) ou uma tentativa contra ela (senha errada, conta bloqueada).</param>
/// <param name="Detail">Código ou complemento curto (motivo da falha, o que entrou e saiu das permissões).</param>
public sealed record AuditRecord(
    Guid Id,
    DateTimeOffset OccurredAt,
    string Module,
    string Action,
    Guid? ActorId,
    string? Target,
    Guid? TargetUserId,
    AuditOutcome Outcome,
    string? Detail,
    string? Ip,
    string? UserAgent);

/// <summary>O que um módulo diz de si para o agregador: o nome, por quanto tempo guarda e quais ações pode registrar.</summary>
/// <param name="RetentionDays">O prazo de retenção em dias (a tela e o aviso de privacidade o mostram).</param>
/// <param name="Actions">Todos os códigos de ação que a fonte pode devolver, em ordem.</param>
public sealed record AuditSourceInfo(string Module, int RetentionDays, IReadOnlyList<string> Actions);

/// <summary>
/// Um filtro de leitura. Todos os campos são opcionais e se combinam com E. O intervalo é semiaberto: <c>From</c> inclui,
/// <c>To</c> não. <c>PersonId</c> casa a conta que agiu e, onde a fonte sabe, a conta que sofreu a ação.
/// </summary>
/// <param name="Limit">Quantas linhas a fonte devolve, no máximo (o agregador pede uma a mais para saber se há próxima página).</param>
public sealed record AuditQuery(
    int Limit,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null,
    Guid? PersonId = null,
    IReadOnlyList<string>? Actions = null,
    AuditOutcome? Outcome = null,
    AuditCursor? After = null);

/// <summary>
/// Porta de LEITURA da trilha de auditoria de um módulo. Cada módulo dono de uma tabela de auditoria implementa esta
/// porta no próprio interior e a registra no contêiner; o agregador de administrador consome todas as registradas, sem
/// conhecer o módulo nem a entidade. Uma fonte devolve as linhas mais novas primeiro, já depois do cursor e já
/// filtradas, sem mais que <see cref="AuditQuery.Limit"/>.
/// </summary>
public interface IAuditSource
{
    AuditSourceInfo Info { get; }

    Task<IReadOnlyList<AuditRecord>> ReadAsync(AuditQuery query, CancellationToken cancellationToken);
}
