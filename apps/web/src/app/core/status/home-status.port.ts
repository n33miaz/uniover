import { Injectable, Signal, signal } from '@angular/core';

export type AgentState = 'unknown' | 'online' | 'offline';
export type WatcherState = 'unknown' | 'ok' | 'alert';

/** O que a faixa de informações da Início precisa saber. */
export interface HomeStatus {
  /** Nome para a saudação; `null` até haver sessão. */
  readonly userName: string | null;
  readonly agent: AgentState;
  readonly watcher: WatcherState;
  readonly serviceDown: boolean;
}

/**
 * Porta de leitura do estado da casa. A Início depende só dela; o adaptador real (agente e eventos em tempo
 * real) vem com o módulo de dispositivos e substitui o provisório abaixo.
 */
@Injectable({ providedIn: 'root', useFactory: () => new NoDataHomeStatus() })
export abstract class HomeStatusPort {
  abstract readonly status: Signal<HomeStatus>;
}

/** Adaptador provisório: não inventa estado, devolve "sem dados" para a UI mostrar isso com clareza. */
export class NoDataHomeStatus extends HomeStatusPort {
  readonly status = signal<HomeStatus>({
    userName: null,
    agent: 'unknown',
    watcher: 'unknown',
    serviceDown: false,
  }).asReadonly();
}
