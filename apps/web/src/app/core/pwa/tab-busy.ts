/**
 * Conversa entre abas do app, por `BroadcastChannel`, antes de um toque em "Atualizar": ativar o worker novo muda o worker de
 * todas as abas e tira o precache antigo, então a aba que toca pergunta às outras se alguma tem trabalho não salvo. Quem não
 * responde no prazo conta como limpa: uma aba congelada em segundo plano nunca trava o toque.
 */
const CHANNEL_NAME = 'uniover.tab-busy';

/** Quanto o toque espera as respostas das outras abas. */
export const OTHER_TABS_ANSWER_TIMEOUT_MS = 500;

/** Identifica esta aba (o canal entrega as mensagens também a outros objetos da mesma aba). */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface TabMessage {
  readonly type: 'ask' | 'busy';
  readonly id: string;
  readonly from: string;
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

/** Passa a responder "ocupada" quando outra aba pergunta e `isBusy()` diz que sim. Devolve a função que para de ouvir. */
export function answerTabBusyQueries(
  win: Window,
  isBusy: () => boolean,
  tabId: string = TAB_ID,
): () => void {
  const channel = channelOf(win);
  if (!channel) return () => undefined;
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as Partial<TabMessage> | null;
    if (message?.type !== 'ask' || message.from === tabId || typeof message.id !== 'string') return;
    if (isBusy()) channel.postMessage({ type: 'busy', id: message.id, from: tabId });
  };
  return () => channel.close();
}

/** Pergunta às outras abas se alguma tem trabalho não salvo. Sem canal ou sem resposta no prazo: `false`. */
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
