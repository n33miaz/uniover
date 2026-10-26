/**
 * Exclusão entre abas para uma decisão do Treino que **lê o banco e depois grava** (abrir o treino, escolher o programa
 * da semana). Duas abas do mesmo navegador dividem o banco local: se as duas leem "ainda não existe" antes de qualquer
 * uma gravar, as duas criam.
 *
 * O bloqueio só serializa; quem garante o resultado é a conferência feita **dentro** da transação de gravação (uma
 * transação do IndexedDB nunca roda ao mesmo tempo que outra sobre as mesmas tabelas, mesmo vinda de outra aba). Por isso
 * perder o bloqueio nunca vira treino ou ficha em dobro, só a espera de quem chega depois.
 */

/** Quanto uma aba espera outra soltar o bloqueio antes de seguir sem ele (o botão nunca fica preso). */
export const TAB_LOCK_WAIT_MS = 10_000;

/** Cauda da fila, por nome, dentro desta aba: é o que serializa quando o navegador não tem `navigator.locks`. */
const tails = new Map<string, Promise<void>>();

/**
 * Roda `task` com o bloqueio `name` (`navigator.locks`: um por vez entre todas as abas da origem, na ordem de chegada).
 * Sem a API (jsdom, Safari antigo), uma fila dentro da aba faz o mesmo para o que roda na mesma aba. Se o bloqueio
 * não chega em `TAB_LOCK_WAIT_MS`, ou o navegador recusa o pedido, a tarefa roda pela fila da aba.
 */
export function withTabLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.request === 'function'
    ? requestLock(locks, name, task)
    : inThisTab(name, task);
}

async function requestLock<T>(
  locks: LockManager,
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAB_LOCK_WAIT_MS);
  let granted = false;
  try {
    return await locks.request(name, { signal: controller.signal }, () => {
      granted = true;
      clearTimeout(timer);
      return task();
    });
  } catch (error) {
    // Um erro da própria tarefa segue adiante; o que falhou antes de ela rodar (espera longa demais, pedido recusado) não.
    if (granted) throw error;
    return inThisTab(name, task);
  } finally {
    clearTimeout(timer);
  }
}

function inThisTab<T>(name: string, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(name) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(name, tail);
  void tail.then(() => {
    // Ninguém entrou na fila depois deste: o nome sai do mapa (não acumula um por conta).
    if (tails.get(name) === tail) tails.delete(name);
  });
  return run;
}
