import type { TvStatus } from './tv-store';

/**
 * Texto curto de cada estado do controle. `hibernating` é "controle dormindo": quem dorme é a sessão com a TV, a TV
 * segue como está, então nunca se diz "TV desligada". Sem agente, o que está desligado é o agente (e não a TV).
 */
export function statusLabel(status: TvStatus): string {
  switch (status) {
    case 'hot':
      return $localize`:@@tv.status.hot:conectada`;
    case 'hibernating':
      return $localize`:@@tv.status.hibernating:controle dormindo`;
    case 'agent-off':
      return $localize`:@@tv.status.agent-off:agente desligado`;
    case 'unconfigured':
      return $localize`:@@tv.status.unconfigured:sem agente configurado`;
    case 'offline':
      return $localize`:@@tv.status.offline:sem rede`;
    case 'waking':
      return $localize`:@@tv.status.waking:servidor acordando`;
    default:
      return $localize`:@@tv.status.loading:conectando…`;
  }
}

/**
 * O que o indicador do cabeçalho conta, com mais detalhe do que o `TvStatus` do store:
 * - `connected` · `sleeping` · `connecting` (buscando o estado) · `server-waking` (o servidor, e não a TV, está
 *   acordando) · `agent-off` · `offline` (o aparelho está sem rede);
 * - `not-configured` e `repair-failed` são os casos de **atenção**: pedem uma providência de quem cuida da casa.
 *   O store não tem uma fase de erro própria, então ela é derivada destes dois fatos concretos: nenhum agente foi
 *   configurado, ou o último aviso do vigia diz que o reparo do controle falhou.
 */
export type TvIndicator =
  | 'connected'
  | 'sleeping'
  | 'connecting'
  | 'server-waking'
  | 'agent-off'
  | 'not-configured'
  | 'offline'
  | 'repair-failed';

/** Fase visual do ponto: cor e forma. Cada fase tem uma forma própria, para a cor não ser a única pista. */
export type TvPhase =
  'connected' | 'sleeping' | 'connecting' | 'agent-off' | 'offline' | 'attention';

/** Aviso do vigia que marca atenção: o reparo automático do controle não deu certo. */
export const WATCHDOG_REPAIR_FAILED = 'repair_failed';

/**
 * Mapeia o estado do store (e o último aviso do vigia, se houver) para o indicador. A falha de reparo só pesa
 * enquanto o controle parece de pé (conectado ou dormindo): com o agente fora do ar ou sem rede, o problema que
 * interessa a quem olha já é outro.
 */
export function deriveIndicator(status: TvStatus, watchdogKind: string | null): TvIndicator {
  switch (status) {
    case 'offline':
      return 'offline';
    case 'waking':
      return 'server-waking';
    case 'unconfigured':
      return 'not-configured';
    case 'agent-off':
      return 'agent-off';
    case 'hibernating':
      return watchdogKind === WATCHDOG_REPAIR_FAILED ? 'repair-failed' : 'sleeping';
    case 'hot':
      return watchdogKind === WATCHDOG_REPAIR_FAILED ? 'repair-failed' : 'connected';
    default:
      return 'connecting';
  }
}

export function indicatorPhase(indicator: TvIndicator): TvPhase {
  switch (indicator) {
    case 'connected':
      return 'connected';
    case 'sleeping':
      return 'sleeping';
    case 'connecting':
    case 'server-waking':
      return 'connecting';
    case 'agent-off':
      return 'agent-off';
    case 'offline':
      return 'offline';
    default:
      return 'attention';
  }
}

/** Ação do painelzinho: `wake` acorda o controle; `retry` lê o estado de novo e tenta acordar. */
export type TvIndicatorAction = 'wake' | 'retry';

export interface TvIndicatorText {
  readonly title: string;
  readonly meaning: string;
  readonly action: TvIndicatorAction | null;
  readonly actionLabel: string;
}

const NO_ACTION = '';

/** Nome do estado em linguagem simples, uma frase do que ele significa e a ação possível (se houver). */
export function indicatorText(indicator: TvIndicator, hibernateMinutes: number): TvIndicatorText {
  const retry = $localize`:@@tv.indicator.retry:Tentar de novo`;
  switch (indicator) {
    case 'connected':
      return {
        title: $localize`:@@tv.indicator.connected.title:Conectada`,
        meaning: $localize`:@@tv.indicator.connected.meaning:O controle está falando com a TV. Depois de ${hibernateMinutes}:minutes: min sem uso ele dorme sozinho e acorda no primeiro toque.`,
        action: null,
        actionLabel: NO_ACTION,
      };
    case 'sleeping':
      return {
        title: $localize`:@@tv.indicator.sleeping.title:Dormindo`,
        meaning: $localize`:@@tv.indicator.sleeping.meaning:Só o controle está dormindo para poupar a TV; ela continua como estava. O primeiro toque acorda.`,
        action: 'wake',
        actionLabel: $localize`:@@tv.indicator.wake:Acordar o controle`,
      };
    case 'connecting':
      return {
        title: $localize`:@@tv.indicator.connecting.title:Conectando`,
        meaning: $localize`:@@tv.indicator.connecting.meaning:Buscando o estado da TV. Se demorar, tente de novo.`,
        action: 'retry',
        actionLabel: retry,
      };
    case 'server-waking':
      return {
        title: $localize`:@@tv.indicator.server-waking.title:Servidor acordando`,
        meaning: $localize`:@@tv.indicator.server-waking.meaning:O servidor estava descansando e está voltando. Os botões voltam em instantes.`,
        action: null,
        actionLabel: NO_ACTION,
      };
    case 'agent-off':
      return {
        title: $localize`:@@tv.indicator.agent-off.title:Agente desligado`,
        meaning: $localize`:@@tv.indicator.agent-off.meaning:O computador que fala com a TV não está conectado. Ligue-o e o controle volta.`,
        action: 'retry',
        actionLabel: retry,
      };
    case 'not-configured':
      return {
        title: $localize`:@@tv.indicator.not-configured.title:Sem agente configurado`,
        meaning: $localize`:@@tv.indicator.not-configured.meaning:Nenhum agente foi configurado para controlar a TV. Pareie o agente para usar o controle.`,
        action: 'retry',
        actionLabel: retry,
      };
    case 'offline':
      return {
        title: $localize`:@@tv.indicator.offline.title:Sem rede`,
        meaning: $localize`:@@tv.indicator.offline.meaning:Este aparelho está sem internet. O controle volta sozinho quando a conexão voltar.`,
        action: null,
        actionLabel: NO_ACTION,
      };
    default:
      return {
        title: $localize`:@@tv.indicator.repair-failed.title:Atenção`,
        meaning: $localize`:@@tv.indicator.repair-failed.meaning:O reparo automático do controle não deu certo. Os botões podem não funcionar.`,
        action: 'retry',
        actionLabel: retry,
      };
  }
}
