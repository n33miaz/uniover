import type { TvStatus } from './tv-store';

/**
 * Texto do chip de estado. `hibernating` é "controle dormindo": quem dorme é a sessão com a TV, a TV segue como
 * está, então nunca se diz "TV desligada". Sem agente, o que está desligado é o agente (e não a TV).
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

export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

/** Cor da bolinha do cabeçalho; o sentido sempre vem junto, em texto, no chip (cor sozinha não informa). */
export function statusTone(status: TvStatus): StatusTone {
  switch (status) {
    case 'hot':
      return 'ok';
    case 'hibernating':
    case 'waking':
      return 'warn';
    case 'agent-off':
    case 'unconfigured':
    case 'offline':
      return 'bad';
    default:
      return 'idle';
  }
}
