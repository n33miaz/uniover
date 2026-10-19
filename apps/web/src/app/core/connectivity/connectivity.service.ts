import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';

/** `ok`: tudo certo · `waking`: há rede mas o servidor não responde (cold start) · `offline`: sem rede. */
export type ServerState = 'ok' | 'waking' | 'offline';

export interface ConnectivityConfig {
  /** Intervalo entre consultas ao `/health/live` enquanto o servidor acorda. */
  readonly pollMs: number;
  /**
   * Quanto esperar antes de desistir. O Render grátis acorda em cerca de 1 min pela documentação, mas já se
   * mediu mais de 240 s: 300 s cobre o pior caso conhecido (a medição própria vem na esteira de medições).
   */
  readonly windowMs: number;
  readonly healthUrl: string;
}

export const CONNECTIVITY_CONFIG = new InjectionToken<ConnectivityConfig>('CONNECTIVITY_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    pollMs: 3_000,
    windowMs: 300_000,
    healthUrl: `${APP_CONFIG.healthPath}/live`,
  }),
});

/**
 * Estado de conexão do app. Regra aprendida no Economize: sem rede não é "servidor acordando". A cortina só
 * aparece quando o navegador diz que está online e a requisição mesmo assim falha.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly config = inject(CONNECTIVITY_CONFIG);
  private readonly win = inject(DOCUMENT).defaultView;

  readonly online = signal(this.win?.navigator.onLine ?? true);
  readonly serverState = signal<ServerState>(this.online() ? 'ok' : 'offline');
  readonly waitedSeconds = signal(0);
  /** Verdadeiro quando a janela de espera acabou sem resposta do servidor. */
  readonly windowExpired = signal(false);

  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private lastPollAt = 0;
  private polling = false;

  constructor() {
    const goOnline = () => {
      this.online.set(true);
      if (this.serverState() === 'offline') this.serverState.set('ok');
    };
    const goOffline = () => {
      this.online.set(false);
      this.stopWaking();
      this.serverState.set('offline');
    };
    this.win?.addEventListener('online', goOnline);
    this.win?.addEventListener('offline', goOffline);
    inject(DestroyRef).onDestroy(() => {
      this.win?.removeEventListener('online', goOnline);
      this.win?.removeEventListener('offline', goOffline);
      this.stopWaking();
    });
  }

  /** Chamado pelo interceptador quando uma requisição falha sem resposta (status 0). */
  reportRequestFailure(): void {
    if (!this.online()) {
      this.serverState.set('offline');
      return;
    }
    if (this.serverState() === 'waking') return;
    this.startWaking();
  }

  /** Chamado quando uma requisição obtém resposta: o servidor está de pé. */
  reportRequestSuccess(): void {
    if (this.serverState() === 'waking') this.stopWaking();
    if (this.online()) this.serverState.set('ok');
  }

  private startWaking(): void {
    this.stopWaking();
    this.windowExpired.set(false);
    this.waitedSeconds.set(0);
    this.startedAt = Date.now();
    this.lastPollAt = this.startedAt;
    this.serverState.set('waking');
    this.timer = setInterval(() => this.tick(), 1_000);
  }

  private stopWaking(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const now = Date.now();
    const waited = now - this.startedAt;
    this.waitedSeconds.set(Math.floor(waited / 1_000));
    if (waited >= this.config.windowMs) {
      this.stopWaking();
      this.windowExpired.set(true);
      this.serverState.set('offline');
      return;
    }
    if (now - this.lastPollAt >= this.config.pollMs) {
      this.lastPollAt = now;
      void this.poll();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.win) return;
    this.polling = true;
    try {
      const response = await this.win.fetch(this.config.healthUrl, { cache: 'no-store' });
      if (response.ok && this.serverState() === 'waking') {
        this.stopWaking();
        this.serverState.set('ok');
      }
    } catch {
      // ainda fora do ar: a próxima rodada tenta de novo até a janela acabar
    } finally {
      this.polling = false;
    }
  }
}
