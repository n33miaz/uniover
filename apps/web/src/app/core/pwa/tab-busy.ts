/**
 * Conversa entre abas do app, por `BroadcastChannel`, antes de um toque em "Atualizar": ativar o worker novo muda o worker de
 * todas as abas e tira o precache antigo, então a aba que toca pergunta às outras se alguma tem trabalho não salvo. Quem não
 * responde no prazo conta como limpa: uma aba congelada em segundo plano nunca trava o toque. A troca automática (sem toque) é
 * o contrário: só vale com o aceno de "livre" de cada outra aba (`askOtherTabsStrict`).
 */
const CHANNEL_NAME = 'uniover.tab-busy';

/** Quanto o toque espera as respostas das outras abas. */
export const OTHER_TABS_ANSWER_TIMEOUT_MS = 500;

/** Identifica esta aba (o canal entrega as mensagens também a outros objetos da mesma aba). */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface TabMessage {
  readonly type: 'ask' | 'busy' | 'idle';
  readonly id: string;
  readonly from: string;
  /** Pergunta de uma troca automática: a aba conta qualquer trabalho em curso, não só o que pede confirmação. */
  readonly strict?: boolean;
}

function channelOf(win: Window): BroadcastChannel | undefined {
  const Channel = (win as Window & typeof globalThis).BroadcastChannel as
    typeof BroadcastChannel | undefined;
  if (typeof Channel !== 'function') return undefined;
  try {
    return new Channel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
}

/**
 * Passa a responder "ocupada" quando outra aba pergunta e `isBusy(strict)` diz que sim (`strict`: a pergunta vem de uma troca
 * automática, que também espera o treino aberto e os envios em curso). Devolve a função que para de ouvir.
 */
export function answerTabBusyQueries(
  win: Window,
  isBusy: (strict: boolean) => boolean,
  tabId: string = TAB_ID,
): () => void {
  const channel = channelOf(win);
  if (!channel) return () => undefined;
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as Partial<TabMessage> | null;
    if (message?.type !== 'ask' || message.from === tabId || typeof message.id !== 'string') return;
    const strict = message.strict === true;
    if (isBusy(strict)) channel.postMessage({ type: 'busy', id: message.id, from: tabId });
    // Na pergunta estrita (troca automática) a aba livre também responde: o silêncio não vale como "livre".
    else if (strict) channel.postMessage({ type: 'idle', id: message.id, from: tabId });
  };
  return () => channel.close();
}

/**
 * Pergunta às outras abas se alguma tem trabalho não salvo (o toque no aviso: quem não responde conta como livre, para uma aba
 * congelada nunca travar o toque). Sem canal ou sem resposta no prazo: `false`.
 */
export function askOtherTabs(
  win: Window,
  timeoutMs: number = OTHER_TABS_ANSWER_TIMEOUT_MS,
  tabId: string = TAB_ID,
): Promise<boolean> {
  const channel = channelOf(win);
  if (!channel) return Promise.resolve(false);
  const id = `${tabId}:${Math.random().toString(36).slice(2)}`;
  return new Promise<boolean>((resolve) => {
    const finish = (busy: boolean) => {
      win.clearTimeout(timer);
      channel.close();
      resolve(busy);
    };
    const timer = win.setTimeout(() => finish(false), timeoutMs);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as Partial<TabMessage> | null;
      if (message?.type === 'busy' && message.id === id && message.from !== tabId) finish(true);
    };
    try {
      channel.postMessage({ type: 'ask', id, from: tabId });
    } catch {
      finish(false);
    }
  });
}

/** Quanto a troca automática espera o aceno de cada uma das outras abas. */
export const OTHER_TABS_STRICT_TIMEOUT_MS = 1_000;

/**
 * A pergunta da troca AUTOMÁTICA: todas as `expected` outras abas abertas precisam responder "livre" (cada uma por si, pelo
 * canal). Qualquer "ocupada", o silêncio de alguma até o prazo, a falta de `BroadcastChannel` ou um erro ao perguntar contam
 * como ocupado: uma aba congelada em segundo plano, ou de uma versão que não responde assim, pode ter um treino aberto, e a
 * troca só acontece com certeza. Devolve `true` se NÃO é seguro trocar. Sem outras abas (`expected <= 0`): `false`.
 */
export function askOtherTabsStrict(
  win: Window,
  expected: number,
  timeoutMs: number = OTHER_TABS_STRICT_TIMEOUT_MS,
  tabId: string = TAB_ID,
): Promise<boolean> {
  if (expected <= 0) return Promise.resolve(false);
  const channel = channelOf(win);
  if (!channel) return Promise.resolve(true);
  const id = `${tabId}:${Math.random().toString(36).slice(2)}`;
  return new Promise<boolean>((resolve) => {
    const idle = new Set<string>();
    const finish = (busy: boolean) => {
      win.clearTimeout(timer);
      channel.close();
      resolve(busy);
    };
    const timer = win.setTimeout(() => finish(true), timeoutMs);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as Partial<TabMessage> | null;
      if (message?.id !== id || typeof message.from !== 'string' || message.from === tabId) return;
      if (message.type === 'busy') finish(true);
      else if (message.type === 'idle') {
        idle.add(message.from);
        if (idle.size >= expected) finish(false);
      }
    };
    try {
      channel.postMessage({ type: 'ask', id, from: tabId, strict: true });
    } catch {
      finish(true);
    }
  });
}
