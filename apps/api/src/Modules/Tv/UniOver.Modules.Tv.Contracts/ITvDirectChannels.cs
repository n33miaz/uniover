namespace UniOver.Modules.Tv.Contracts;

/// <summary>A TV que uma pessoa pode controlar pelo canal direto, e o agente (o computador) que a controla.</summary>
public sealed record TvDirectTarget(Guid TvId, string AgentSlug);

/// <summary>
/// O que um canal direto com o escopo da TV levou, para a trilha da TV: as teclas e os textos só como soma (nenhuma tecla
/// vai uma a uma para a trilha, e o texto digitado nunca chega aqui, nem o tamanho).
/// </summary>
public sealed record TvDirectUse(
    Guid UserId, Guid TvId, string AgentSlug, int Keys, int Texts, string Reason, string? Ip, string? UserAgent);

/// <summary>
/// A porta do módulo TV para o canal direto, que mora no Devices (ele conhece o agente, não as TVs nem as permissões delas).
/// Quem decide se uma pessoa pode mandar tecla àquela TV é o módulo TV, na hora da oferta; o canal só carrega o resultado.
/// </summary>
public interface ITvDirectChannels
{
    /// <summary>
    /// A TV <paramref name="tvId"/> (ou a única/padrão que a pessoa vê, se nulo), se ela pode controlá-la agora: tem
    /// <c>tv:control</c> e a TV está entre as dela (o administrador vê todas). Nulo quando não pode: o canal não leva TV.
    /// </summary>
    Task<TvDirectTarget?> ResolveAsync(Guid userId, bool isOwner, Guid? tvId, CancellationToken cancellationToken = default);

    /// <summary>Deixa na trilha da TV a soma do que um canal direto levou (uma linha para as teclas e outra para os textos).</summary>
    Task RecordUseAsync(TvDirectUse use, CancellationToken cancellationToken = default);
}

/// <summary>Os motivos de <see cref="TvDirectUse.Reason"/> que não são o do fechamento do canal.</summary>
public static class TvDirectUseReasons
{
    /// <summary>O canal com o escopo da TV abriu (ainda sem nada levado).</summary>
    public const string Opened = "opened";
}

/// <summary>
/// Pessoas deixaram de poder controlar a TV de um computador (filiação retirada, TV apagada ou computador trocado). Sai pela outbox
/// do módulo TV, na MESMA transação da mudança, e o Devices fecha (ou reabre só com o que sobrou) os canais diretos delas com o escopo
/// da TV: o aviso não se perde se o processo cair, e a entrega é repetida até dar certo. Imutável depois de publicado.
/// </summary>
/// <param name="AgentSlug">O computador cuja TV deixou de ser delas.</param>
/// <param name="UserIds">Quem perdeu; nulo quando é todo mundo (TV apagada ou computador trocado).</param>
public sealed record TvDirectAccessRemoved(
    Guid Id, DateTimeOffset OccurredAt, string AgentSlug, IReadOnlyList<Guid>? UserIds) : UniOver.SharedKernel.IIntegrationEvent
{
    public const string EventType = "tv.direct-access-removed.v1";

    public string Type => EventType;
}
