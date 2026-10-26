using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>IP e User-Agent da requisição, entregues aos handlers pelo endpoint (o handler não toca no HttpContext).</summary>
public sealed record ClientInfo(string? Ip, string? UserAgent);

/// <summary>Nomes estáveis dos comandos na trilha de auditoria.</summary>
public static class TvCommandNames
{
    public const string Key = "tv.key";
    public const string Text = "tv.text";
    public const string AppLaunch = "tv.app.launch";
    public const string Wake = "tv.wake";
    public const string AppsRefresh = "tv.apps.refresh";

    /// <summary>Alguém com a permissão de editar atalhos mudou a ordem deles: não vai à TV, mas é uma ação que a trilha guarda.</summary>
    public const string ShortcutsReorder = "tv.shortcuts.reorder";

    /// <summary>Alguém com a permissão de editar atalhos renomeou ou escondeu um: o detalhe leva só os códigos dos campos, nunca o nome novo.</summary>
    public const string ShortcutUpdate = "tv.shortcut.update";
    public const string PowerOff = "tv.power-off";
    public const string PowerSchedule = "tv.power-schedule";
    public const string Cleanup = "tv.cleanup";

    /// <summary>O administrador trocou o computador que controla a TV: não vai à TV, mas redireciona o controle e a trilha guarda quem fez. O detalhe é o computador novo.</summary>
    public const string ConfigBind = "tv.config.bind";

    /// <summary>
    /// Anotação, e não comando: a trilha de um usuário bateu no teto diário de linhas e parou de registrar até o dia
    /// seguinte (os comandos continuam funcionando). Há uma só por usuário e por dia; o detalhe é o teto (<c>limit=N</c>).
    /// Não entra no histórico curto de comandos da TV: só na trilha do administrador.
    /// </summary>
    public const string AuditLimit = "tv.audit.limit";
}

/// <summary>
/// Uma linha da trilha de auditoria: quem mandou, de onde, para qual agente, o quê e o resultado. Do texto digitado
/// guarda só o tamanho (nunca o conteúdo, que pode ser uma senha).
/// </summary>
public sealed class CommandAuditEntry
{
    public const int AgentMax = 40;
    public const int CommandMax = 30;
    public const int DetailMax = 255;
    public const int ErrorCodeMax = 40;
    public const int IpMax = 64;
    public const int UserAgentMax = 256;

    // Para o EF Core materializar a linha.
    private CommandAuditEntry()
    {
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    /// <summary>TV a que a ação pertence; a trilha continua sem FK porque a exclusão da TV não apaga auditoria.</summary>
    public Guid TvId { get; private set; }

    /// <summary>Nulo quando nenhum agente está configurado para controlar a TV.</summary>
    public string? AgentId { get; private set; }

    public string Command { get; private set; } = string.Empty;

    /// <summary>A tecla ou o pacote do app; do texto digitado, só <c>length=N</c>.</summary>
    public string? Detail { get; private set; }

    public bool Ok { get; private set; }

    public string? ErrorCode { get; private set; }

    public int? LatencyMs { get; private set; }

    public string? Ip { get; private set; }

    public string? UserAgent { get; private set; }

    public DateTimeOffset OccurredAt { get; private set; }

    public static CommandAuditEntry Create(
        Guid userId,
        string? agentId,
        string command,
        string? detail,
        bool ok,
        string? errorCode,
        int? latencyMs,
        ClientInfo client,
        DateTimeOffset occurredAt,
        Guid tvId = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(command);
        ArgumentNullException.ThrowIfNull(client);

        return new CommandAuditEntry
        {
            Id = IdGenerator.NewId(),
            UserId = userId,
            TvId = tvId,
            AgentId = Truncate(agentId, AgentMax),
            Command = Truncate(command, CommandMax)!,
            Detail = Truncate(detail, DetailMax),
            Ok = ok,
            ErrorCode = Truncate(errorCode, ErrorCodeMax),
            LatencyMs = latencyMs,
            Ip = Truncate(client.Ip, IpMax),
            UserAgent = Truncate(client.UserAgent, UserAgentMax),
            OccurredAt = occurredAt,
        };
    }

    // IP e User-Agent vêm do cliente e não podem inflar a tabela.
    private static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}
