import {
  CLIENTS_REPLY,
  LIST_CLIENTS_MESSAGE,
  LIST_CLIENTS_TIMEOUT_MS,
  type ClientsReply,
} from './sw-clients';

// Parte da página (usa `Window`): fica fora de sw-clients.ts, que o service worker importa e não tem o DOM.

/**
 * Na página: pergunta ao `worker` quantas OUTRAS janelas do app existem. `null` quando não dá para saber (sem `MessageChannel`,
 * worker que não responde no prazo, resposta que não inclui esta janela ou malformada): quem chama trata como ocupado.
 */
export function askWorkerForOtherWindows(
  win: Window,
  worker: { postMessage(message: unknown, transfer: Transferable[]): void },
  timeoutMs: number = LIST_CLIENTS_TIMEOUT_MS,
): Promise<number | null> {
  const Channel = (win as Window & typeof globalThis).MessageChannel as
    typeof MessageChannel | undefined;
  if (typeof Channel !== 'function') return Promise.resolve(null);
  return new Promise<number | null>((resolve) => {
    let channel: MessageChannel;
    try {
      channel = new Channel();
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: number | null) => {
      win.clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close?.();
      resolve(value);
    };
    const timer = win.setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      const reply = event.data as Partial<ClientsReply> | null;
      if (
        reply?.type !== CLIENTS_REPLY ||
        typeof reply.count !== 'number' ||
        !Number.isInteger(reply.count) ||
        reply.count < 1 ||
        reply.selfListed !== true
      ) {
        finish(null);
        return;
      }
      finish(reply.count - 1);
    };
    try {
      worker.postMessage({ type: LIST_CLIENTS_MESSAGE }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}
