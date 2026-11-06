namespace UniOver.Modules.Devices.Domain;

/// <summary>
/// O último sinal que o próprio PC mandou antes de estar conectado (a baliza de partida) e o último handshake que a API
/// recusou para ele. Uma linha por agente, sempre sobrescrita: nunca cresce e nunca anexa. Não é prova de nada: a rota que
/// recebe a baliza é anônima, então <see cref="Verified"/> fica falso e a tela só a usa como pista de por que o PC está fora.
/// </summary>
public sealed class AgentBeacon
{
    public const int StageMax = 32;
    public const int CodeMax = 32;
    public const int VersionMax = 40;
    public const int OsMax = 24;
    public const int ReasonMax = 32;

    /// <summary>O código que quer dizer "deu certo": qualquer outro marca uma falha.</summary>
    public const string OkCode = "ok";

    // Para o EF Core materializar a linha.
    private AgentBeacon()
    {
    }

    public Guid AgentId { get; private set; }

    public string? LastStage { get; private set; }

    public string? LastCode { get; private set; }

    /// <summary>Quando a API recebeu a baliza (relógio do servidor; o do PC não vale).</summary>
    public DateTimeOffset? LastAt { get; private set; }

    /// <summary>Quando a falha atual começou: a primeira baliza que não é <c>ok</c> depois de um <c>ok</c> (ou da primeira). Nulo se a última foi <c>ok</c>.</summary>
    public DateTimeOffset? FirstFailAt { get; private set; }

    /// <summary>Quantas balizas a API aceitou deste agente (satura; é só um contador de curiosidade).</summary>
    public int Count { get; private set; }

    public bool Verified { get; private set; }

    public string? Version { get; private set; }

    public string? Os { get; private set; }

    /// <summary>Por que a API recusou o último handshake (um código curto, nunca texto do cliente).</summary>
    public string? LastRejectReason { get; private set; }

    public DateTimeOffset? LastRejectedAt { get; private set; }

    public static AgentBeacon Create(Guid agentId) => new() { AgentId = agentId };

    /// <summary>A mesma etapa e o mesmo código dentro da janela não mudam nada (a API descarta a repetição).</summary>
    public bool IsRepeat(string stage, string code, DateTimeOffset now, TimeSpan window) =>
        LastAt is { } at
        && string.Equals(LastStage, stage, StringComparison.Ordinal)
        && string.Equals(LastCode, code, StringComparison.Ordinal)
        && now - at < window;

    public void ApplyBeacon(string stage, string code, string? version, string? os, DateTimeOffset now)
    {
        var failed = !string.Equals(code, OkCode, StringComparison.Ordinal);
        FirstFailAt = failed ? FirstFailAt ?? now : null;
        LastStage = stage;
        LastCode = code;
        LastAt = now;
        Version = version;
        Os = os;
        Count = Count == int.MaxValue ? Count : Count + 1;
    }

    public void ApplyRejection(string reason, DateTimeOffset now)
    {
        LastRejectReason = reason;
        LastRejectedAt = now;
    }
}
