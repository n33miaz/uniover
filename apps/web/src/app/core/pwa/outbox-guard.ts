import { UnsavedWork } from './unsaved-work';

/** Quanto se espera a fila carregar antes de largar a guarda: um import que trava não pode prender a recuperação. */
export const OUTBOX_LOAD_TIMEOUT_MS = 3_000;

/** O que a guarda precisa da fila: quantos itens estão em voo e como reler o número do banco compartilhado entre abas. */
export interface OutboxProbe {
  inFlight(): number;
  refresh(): Promise<unknown>;
}

/**
 * Liga a fila de saída offline à guarda de recarga: um item em voo (já saiu, sem resposta) é o que uma recarga cortaria.
 * Os que esperam já estão guardados no IndexedDB e a recarga não os perde, então não seguram nada. A fila vem de um import
 * dinâmico (o banco local fica fora do pacote inicial), então, até ele terminar, a fila conta como ocupada: não há janela,
 * na abertura, em que ela não proteja nada. Se o import falhar ou passar de `OUTBOX_LOAD_TIMEOUT_MS`, a guarda se solta
 * (sem fila não há o que proteger) e, na falha, o erro volta pela promessa devolvida. O número vem de um banco que outras
 * abas também mexem, então quem decide chama `UnsavedWork.settle()` antes, que relê (`refresh`).
 */
export function guardOutbox(unsaved: UnsavedWork, load: () => Promise<OutboxProbe>): Promise<void> {
  let probe: OutboxProbe | null = null;
  let settled = false;
  const timer = setTimeout(() => (settled = true), OUTBOX_LOAD_TIMEOUT_MS);
  unsaved.register(() => (settled ? (probe?.inFlight() ?? 0) > 0 : true), 'outbox');
  unsaved.registerRefresh(() => probe?.refresh() ?? Promise.resolve());
  return load().then(
    (loaded) => {
      clearTimeout(timer);
      // Se o prazo já passou, a leitura chegou tarde mas ainda vale daqui em diante.
      probe = loaded;
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

/** O mínimo que a ligação com as filas por conta precisa (`QueueScopes`, importado sob demanda). */
export interface QueueScopesLike {
  follow(): void;
  active(): { store: { sendingCount(): number; refresh(): Promise<unknown> } } | null;
}

/**
 * Liga a fila da conta em uso à guarda de recarga: só `sendingCount` (itens em voo) conta, nunca `pendingCount`.
 */
export function guardQueueScopes(
  unsaved: UnsavedWork,
  load: () => Promise<QueueScopesLike>,
): Promise<void> {
  return guardOutbox(unsaved, async () => {
    const scopes = await load();
    scopes.follow();
    return {
      inFlight: () => scopes.active()?.store.sendingCount() ?? 0,
      refresh: () => scopes.active()?.store.refresh() ?? Promise.resolve(),
    };
  });
}
