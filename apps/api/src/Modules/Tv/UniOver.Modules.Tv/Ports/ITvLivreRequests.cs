namespace UniOver.Modules.Tv.Ports;

/// <summary>
/// Um passo do TV Livre em andamento: o número do pedido (que o agente repete no estado) e a vez da TV. Descartar
/// libera a vez.
/// </summary>
internal interface ITvLivreTicket : IAsyncDisposable
{
    /// <summary>O que vai no <c>requestId</c> do comando e volta no <c>tv.livre.state.v1</c>.</summary>
    Guid RequestId { get; }
}

/// <summary>
/// Uma operação do TV Livre por vez em cada TV (instalar e aplicar ao mesmo tempo disputariam o ADB e a ordem segura).
/// A vez vale entre todas as instâncias da API: com duas réplicas, dois passos simultâneos na mesma TV não passam.
/// </summary>
internal interface ITvLivreRequests
{
    /// <summary>Começa um passo na TV; nulo se ela já tem outro em andamento (em qualquer instância).</summary>
    Task<ITvLivreTicket?> TryBeginAsync(Guid tvId, CancellationToken cancellationToken);
}
