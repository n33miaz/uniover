namespace UniOver.Modules.Tv.Contracts;

/// <summary>
/// API pública em processo do módulo Tv. Se o Tv virar um deploy separado, quem usa esta interface
/// passa a receber um cliente HTTP com o mesmo contrato.
/// </summary>
public interface ITvModule
{
    Task<ModuleInfo> GetInfoAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// A criação feita junto do pareamento. A ação HTTP que a chama exige a mesma confirmação forte de criar uma TV.
/// <paramref name="CanBeDefault"/> falso (o convidado que pareia a própria TV) impede que a TV vire a padrão, mesmo quando
/// ainda não existe nenhuma: a padrão é do administrador.
/// </summary>
public sealed record PairedTvRegistration(
    string AgentSlug,
    string AgentName,
    string? Name,
    Guid OwnerId,
    IReadOnlyList<Guid> MemberIds,
    bool CanBeDefault = true);

/// <summary>
/// Porta do módulo TV para concluir um pareamento. A implementação entra na conexão e na transação já abertas pelo
/// Devices: agente, pareamento e TV são gravados ou desfeitos juntos, cada módulo no seu schema.
/// O retorno, se houver, é uma ação que o chamador deve executar DEPOIS do commit (acorda a entrega dos avisos gravados na outbox do TV).
/// </summary>
public interface IPairedTvRegistrar
{
    Task<Action?> RegisterAsync(
        PairedTvRegistration registration,
        System.Data.Common.DbConnection connection,
        System.Data.Common.DbTransaction transaction,
        CancellationToken cancellationToken = default);
}

/// <summary>Nome da ação protegida por passkey para qualquer mudança de computador ligado a uma TV.</summary>
public static class TvPairingActions
{
    public const string BindAgent = "tv.bind-agent";
}
