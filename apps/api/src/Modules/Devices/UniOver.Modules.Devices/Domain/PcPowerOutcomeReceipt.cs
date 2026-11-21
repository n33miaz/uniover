namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// O recibo de um desfecho de contagem de energia do PC (<c>pc.power.outcome.v1</c>) já gravado na auditoria: o agente reenvia o
/// desfecho até receber a confirmação, e é esta linha (e não a memória da instância) que impede o reenvio de virar outra linha de
/// auditoria ou outro aviso no app, mesmo depois de a API reiniciar. A chave é o agente, a contagem e o desfecho. Não é trilha de
/// auditoria: some depois de <see cref="Retention"/>.
/// </summary>
public sealed class PcPowerOutcomeReceipt
{
    public const int OutcomeMax = 16;

    /// <summary>
    /// Por quanto tempo o recibo vale: um pouco mais que o dia em que o agente segue reenviando o que não teve confirmação. A limpeza
    /// diária apaga só o que passou disso.
    /// </summary>
    public static readonly TimeSpan Retention = TimeSpan.FromHours(25);

    // Para o EF Core materializar a linha.
    private PcPowerOutcomeReceipt()
    {
    }

    public Guid AgentId { get; private set; }

    /// <summary>O identificador opaco da contagem (o <c>id</c> do comando <c>pc.power</c> que a agendou).</summary>
    public Guid CountdownId { get; private set; }

    /// <summary><c>refused</c>, <c>lost</c> ou <c>cancelled</c> (o contrato já limitou).</summary>
    public string Outcome { get; private set; } = string.Empty;

    /// <summary>Quando a API gravou o desfecho (relógio do servidor).</summary>
    public DateTimeOffset RecordedAt { get; private set; }
}
