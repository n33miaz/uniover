/**
 * A lista autoritativa das janelas abertas do app, dada pelo service worker. A troca automática de worker toma TODAS as páginas
 * do app (`clients.claim()`), então precisa saber quantas outras janelas existem de verdade, e não só as que seguram o bloqueio
 * compartilhado de abas: uma janela de uma versão anterior (sem esse bloqueio, sem responder à pergunta estrita) com um
 * formulário sujo ficaria invisível. O worker sabe de todas (`clients.matchAll` com `includeUncontrolled`).
 *
 * A pergunta vai ao worker que ESPERA (é ele que vai ser ativado, e uma versão que não entende a mensagem simplesmente não
 * responde): sem resposta no prazo, o chamador falha fechado (não troca sozinho, o aviso fica à vista).
 */
export const LIST_CLIENTS_MESSAGE = 'LIST_CLIENTS';
export const CLIENTS_REPLY = 'CLIENTS';

/** Quanto a troca automática espera o worker dizer quantas janelas existem. */
export const LIST_CLIENTS_TIMEOUT_MS = 1_500;

export interface ClientsReply {
  readonly type: typeof CLIENTS_REPLY;
  /** Quantas janelas do app existem (a de quem perguntou entre elas). */
  readonly count: number;
  /** A janela de quem perguntou está na lista (sem isso a conta das outras não é confiável). */
  readonly selfListed: boolean;
}

/** O que o worker usa para responder (o escopo do worker de verdade e um substituto nos testes). */
export interface ClientsScope {
  readonly clients: {
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<readonly { readonly id: string }[]>;
  };
}

/** No worker: responde pela porta recebida quantas janelas do app existem e se a de quem perguntou está entre elas. */
export async function answerClientsQuery(
  scope: ClientsScope,
  askerId: string | null,
  reply: { postMessage(message: ClientsReply): void } | undefined,
): Promise<void> {
  if (!reply) return;
  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  reply.postMessage({
    type: CLIENTS_REPLY,
    count: windows.length,
    selfListed: askerId !== null && windows.some((client) => client.id === askerId),
  });
}
