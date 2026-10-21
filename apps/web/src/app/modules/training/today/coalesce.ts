/**
 * Torna uma leitura assíncrona "uma por vez": um pedido que chega no meio de uma leitura vira uma passada extra, e quem
 * pediu só recebe a resposta quando a última passada termina. Assim, quem espera por `load()` depois de uma escrita nunca
 * enxerga o estado de antes dela, e pedidos em rajada (cada gravação avisa a tela) não se atropelam.
 */
export function coalesced(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/**
 * Leitura de fundo que nunca estoura. Sem banco local (navegador sem IndexedDB, banco fechado por outra aba) a tela segue
 * com o estado vazio, que já é um estado normal dela, em vez de deixar uma rejeição solta no navegador. `onFail` põe a tela
 * nesse estado vazio (por exemplo, marca a leitura como feita para o esqueleto sair).
 */
export function quiet(
  task: () => Promise<void>,
  onFail: () => void = () => undefined,
): () => Promise<void> {
  return async () => {
    try {
      await task();
    } catch {
      onFail();
    }
  };
}
