import { UnsavedWork } from './unsaved-work';

/**
 * Liga a fila de saída offline à guarda de recarga: itens esperando ou em voo seguram a recarga automática. A fila vem de um
 * import dinâmico (o banco local fica fora do pacote inicial), então, até ele terminar, a fila conta como ocupada: não há
 * janela, na abertura, em que ela não proteja nada. Se o import falhar, a guarda se solta (sem fila não há o que proteger) e o erro volta pela promessa devolvida.
 *
 * `load` devolve a leitura de "quantos itens pendentes" da conta em uso.
 */
export function guardOutbox(
  unsaved: UnsavedWork,
  load: () => Promise<() => number>,
): Promise<void> {
  let pending: (() => number) | null = null;
  let settled = false;
  unsaved.register(() => (settled ? (pending?.() ?? 0) > 0 : true), 'outbox');
  return load().then(
    (read) => {
      pending = read;
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      // O erro segue para quem chamou (a falha da fila continua visível), mas a guarda não fica presa por causa dele.
      throw error;
    },
  );
}
