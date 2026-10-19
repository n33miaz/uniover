import { Injectable, Signal, computed, inject } from '@angular/core';
import { SessionState } from '../session/session-state';

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

/**
 * Adaptador provisório: o nome vem da sessão; o resto não é inventado e fica "sem dados" para a UI mostrar isso
 * com clareza.
 */
export class NoDataHomeStatus extends HomeStatusPort {
  private readonly session = inject(SessionState);

  readonly status = computed<HomeStatus>(() => ({
    userName: this.session.user()?.displayName ?? null,
    agent: 'unknown',
    watcher: 'unknown',
    serviceDown: false,
  }));
}
