using System.Collections.Frozen;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>
/// As tabelas de auditoria de cada schema: o papel da aplicação só pode ler e incluir nelas (sem <c>UPDATE</c>,
/// <c>DELETE</c> nem <c>TRUNCATE</c>); quem apaga o que passou do prazo é a função de retenção do próprio schema, que
/// roda com os direitos do dono. <see cref="RuntimeRoleGrants.Sql(string, IEnumerable{string}?)"/> consulta esta lista a
/// cada migration, então uma migration nova nunca devolve o <c>DELETE</c> em silêncio.
/// <para>
/// Tabela de auditoria nova entra AQUI (e ganha a sua fonte de leitura e a sua função de retenção). Um teste de
/// integração falha se existir, num schema de módulo, uma tabela com "audit" no nome que não esteja nesta lista.
/// </para>
/// <para>
/// <c>tv.watchdog_events</c> fica de FORA de propósito: é a linha do tempo de reparos que o agente relata (um buffer
/// rotativo das últimas 500 linhas, que o próprio módulo apara), não o registro de uma ação de alguém.
/// </para>
/// </summary>
public static class AppendOnlyTables
{
    private static readonly FrozenDictionary<string, IReadOnlyList<string>> BySchema =
        new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["identity"] = ["login_audit"],
            ["devices"] = ["pairing_audit"],
            ["tv"] = ["command_audit"],
        }.ToFrozenDictionary(StringComparer.Ordinal);

    /// <summary>Todas as tabelas só-inclusão, por schema.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> All => BySchema;

    /// <summary>As tabelas só-inclusão do schema; vazio para o schema que não tem nenhuma.</summary>
    public static IReadOnlyList<string> Of(string schema)
    {
        ArgumentNullException.ThrowIfNull(schema);
        return BySchema.TryGetValue(schema, out var tables) ? tables : [];
    }
}

/// <summary>
/// Quanto tempo cada trilha é guardada. São constantes nomeadas (e testadas) de propósito: o prazo é uma promessa de
/// privacidade feita às pessoas cujo IP e aparelho ficam registrados, não um botão de configuração. O mesmo número
/// está escrito como PISO dentro de cada função de retenção do banco, então a aplicação só consegue guardar por MAIS
/// tempo que isto, nunca por menos; encurtar o prazo é uma migration nova.
/// </summary>
public static class AuditRetentionPolicy
{
    /// <summary>Trilhas de segurança (entrada, sessão, passkey, convite, permissão, pareamento de aparelho).</summary>
    public const int SecurityDays = 180;

    /// <summary>Comandos enviados à TV.</summary>
    public const int CommandDays = 30;
}
