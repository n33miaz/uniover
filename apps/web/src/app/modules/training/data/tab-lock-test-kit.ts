/**
 * Peças de teste do bloqueio entre abas: o jsdom não tem `navigator.locks`, então o teste instala um falso (e o tira no
 * `afterEach`, porque o Vitest roda com `isolate: false` e o falso vazaria para os outros arquivos). Só os testes importam
 * este arquivo; nada daqui entra no bundle do app.
 */

type Callback = (lock: { readonly name: string; readonly mode: 'exclusive' }) => unknown;

interface RequestOptions {
  readonly signal?: AbortSignal;
}

/** O pedaço de `LockManager` que o app usa. */
export interface FakeLockManager {
  request(name: string, options: RequestOptions, callback: Callback): Promise<unknown>;
}

/** Instala o falso em `navigator.locks`. */
export function installLocks(locks: FakeLockManager): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
}

/** Tira o falso: o jsdom volta a não ter `navigator.locks`. */
export function removeLocks(): void {
  delete (navigator as { locks?: unknown }).locks;
}

/** Bloqueio que **não exclui ninguém**: concede todo pedido na hora (duas abas cuja trava não vale de nada). */
export function grantEverything(): FakeLockManager & { readonly requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    request: async (name, _options, callback) => {
      requested.push(name);
      return callback({ name, mode: 'exclusive' });
    },
  };
}

/**
 * Bloqueio exclusivo de verdade: um dono por nome, os pedidos na ordem de chegada, e o pedido que espera respeita o
 * `signal` (aborta com `AbortError`, como o navegador). `hold(name)` é uma outra aba que segura o bloqueio até o teste
 * soltá-lo.
 */
export function exclusiveLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const requested: string[] = [];

  const manager: FakeLockManager = {
    request: (name, options, callback) => {
      requested.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const turn = new Promise<void>((resolve, reject) => {
        const abort = () => reject(new DOMException('Pedido abortado.', 'AbortError'));
        if (options.signal?.aborted) return abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        void previous.then(() => {
          options.signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      const run = turn.then(() => callback({ name, mode: 'exclusive' }));
      // O próximo pedido espera o dono atual terminar, mesmo que este aqui tenha desistido (abortado).
      tails.set(name, Promise.all([previous, run.catch(() => undefined)]));
      return run;
    },
  };

  return {
    manager,
    requested,
    /** Outra aba segura o bloqueio `name` até `release()`. */
    hold(name: string): { release: () => void } {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      void manager.request(name, {}, () => held);
      return { release };
    },
  };
}
