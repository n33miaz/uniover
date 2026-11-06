import { UnsavedWork } from './unsaved-work';

/** Quanto se espera a fila carregar antes de largar a guarda: um import que trava não pode prender a recuperação. */
export const OUTBOX_LOAD_TIMEOUT_MS = 3_000;

/**
 * Liga a fila de saída offline à guarda de recarga: um item em voo (já saiu, sem resposta) é o que uma recarga cortaria.
 * Os que esperam já estão guardados no IndexedDB e a recarga não os perde, então não seguram nada. A fila vem de um import
 * dinâmico (o banco local fica fora do pacote inicial), então, até ele terminar, a fila conta como ocupada: não há janela,
 * na abertura, em que ela não proteja nada. Se o import falhar ou passar de `OUTBOX_LOAD_TIMEOUT_MS`, a guarda se solta
 * (sem fila não há o que proteger) e, na falha, o erro volta pela promessa devolvida.
 *
 * `load` devolve a leitura de "quantos itens em voo" da conta em uso.
 */
export function guardOutbox(
  unsaved: UnsavedWork,
  load: () => Promise<() => number>,
): Promise<void> {
  let inFlight: (() => number) | null = null;
  let settled = false;
  const timer = setTimeout(() => (settled = true), OUTBOX_LOAD_TIMEOUT_MS);
  unsaved.register(() => (settled ? (inFlight?.() ?? 0) > 0 : true), 'outbox');
  return load().then(
    (read) => {
      clearTimeout(timer);
      // Se o prazo já passou, a leitura chegou tarde mas ainda vale daqui em diante.
      inFlight = read;
      settled = true;
    },
    (error: unknown) => {
      clearTimeout(timer);
      settled = true;
      // O erro segue para quem chamou (a falha da fila continua visível), mas a guarda não fica presa por causa dele.
      throw error;
    },
  );
}
