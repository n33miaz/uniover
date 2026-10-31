namespace UniOver.Modules.Tv.Ports;

/// <summary>
/// Um passo do TV Livre em andamento: o número do pedido (que o agente repete no estado) e a espera por esse estado.
/// Descartar libera a vez da TV.
/// </summary>
internal interface ITvLivreTicket : IDisposable
{
    /// <summary>O que vai no <c>requestId</c> do comando e volta no <c>tv.livre.state.v1</c>.</summary>
    Guid RequestId { get; }

    /// <summary>
    /// Espera o estado deste pedido. O agente o manda antes do resultado do comando, então normalmente já chegou;
    /// <paramref name="grace"/> só cobre uma ordem trocada. Falso se não chegou.
    /// </summary>
    Task<bool> WaitForStateAsync(TimeSpan grace, CancellationToken cancellationToken);
}

/// <summary>
/// Uma operação do TV Livre por vez em cada TV (instalar e aplicar ao mesmo tempo disputariam o ADB e a ordem segura),
/// e o encontro do estado que o agente manda por iniciativa própria com o pedido HTTP que o espera. Em memória, da
/// instância do contêiner.
/// </summary>
internal interface ITvLivreRequests
{
    /// <summary>Começa um passo na TV; nulo se ela já tem outro em andamento.</summary>
    ITvLivreTicket? TryBegin(Guid tvId);

    /// <summary>Avisa que o estado do <paramref name="requestId"/> já está guardado; ignora o que ninguém espera.</summary>
    void StateStored(Guid tvId, Guid requestId);
}
