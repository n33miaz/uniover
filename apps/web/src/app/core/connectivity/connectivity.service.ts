import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { ResumeGrace } from './resume-grace';

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
  /**
   * Quanto a checagem de `/health/live` espera antes de valer como falha. Menor que `pollMs`: no Render dormindo o proxy
   * segura a requisição aberta (nem responde, nem recusa), e sem este corte a checagem nunca concluiria nada.
   */
  readonly probeTimeoutMs: number;
  /**
   * Quantas requisições seguidas sem resposta, fora da carência, bastam para mostrar "acordando" sem esperar a checagem.
   * Com menos que isso, a primeira falha só dispara a checagem: uma requisição solta que caiu não acende faixa nenhuma.
   */
  readonly failuresToWake: number;
}

export const CONNECTIVITY_CONFIG = new InjectionToken<ConnectivityConfig>('CONNECTIVITY_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    pollMs: 3_000,
    windowMs: 300_000,
    healthUrl: `${APP_CONFIG.healthPath}/live`,
    probeTimeoutMs: 2_500,
    failuresToWake: 2,
  }),
});

/**
 * Estado de conexão do app. Regra aprendida no Economize: sem rede não é "servidor acordando". A cortina só
 * aparece quando o navegador diz que está online e a requisição mesmo assim falha.
 *
 * O app deve parecer sempre disponível, então nenhum aviso sai por uma falha isolada:
 * - ao voltar ao app há uma carência (`ResumeGrace`): falha de rede e "offline" do navegador não mudam nada; no fim dela, se
 *   ainda houve falha, uma única checagem de `/health/live` decide;
 * - fora da carência, a primeira falha só dispara a checagem; "acordando" aparece quando ela falha ou quando
 *   `failuresToWake` requisições seguidas falham;
 * - qualquer resposta do servidor zera a conta.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly config = inject(CONNECTIVITY_CONFIG);
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly grace = inject(ResumeGrace);

  readonly online = signal(this.win?.navigator.onLine ?? true);
  readonly serverState = signal<ServerState>(this.online() ? 'ok' : 'offline');
  readonly waitedSeconds = signal(0);
  /** Verdadeiro quando a janela de espera acabou sem resposta do servidor. */
  readonly windowExpired = signal(false);
  private readonly probing = signal(false);
  /**
   * Silêncio: ainda não é hora de avisar nada. Vale durante a carência da volta ao app e enquanto a checagem decisiva está
   * em voo. Quem refaz pedidos em silêncio, ou segura um aviso seu, pergunta isto.
   */
  readonly quiet = computed(() => this.grace.active() || this.probing());

  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private lastPollAt = 0;
  private polling = false;
  /** Falhas sem resposta desde a última resposta do servidor (ou desde a volta ao app). */
  private failures = 0;
  /** Cresce a cada resposta do servidor: uma checagem que termina depois de uma resposta não vale mais. */
  private answers = 0;
  private checking = false;
  /** Muda a cada começo e fim da espera: a resposta de uma rodada de antes não vale para a de agora. */
  private wakeEpoch = 0;
  /** O navegador avisou "offline" durante a carência: o aviso só vale se ele ainda disser isso quando ela acabar. */
  private offlineDeferred = false;

  constructor() {
    const goOnline = () => {
      this.offlineDeferred = false;
      this.online.set(true);
      if (this.serverState() === 'offline') this.serverState.set('ok');
    };
    const goOffline = () => {
      // Logo ao voltar o navegador costuma dizer "offline" por um instante; só vale se continuar assim depois da carência.
      if (this.grace.active()) {
        this.offlineDeferred = true;
        return;
      }
      this.applyOffline();
    };
    this.win?.addEventListener('online', goOnline);
    this.win?.addEventListener('offline', goOffline);
    const offGrace = this.grace.subscribe((event) => {
      if (event === 'begin') this.onResume(goOnline);
      else this.onGraceEnd();
    });
    inject(DestroyRef).onDestroy(() => {
      offGrace();
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
    this.failures++;
    // Na carência a falha só é contada: o fim dela decide, com uma checagem, se há o que mostrar.
    if (this.grace.active()) return;
    if (this.failures >= this.config.failuresToWake) {
      this.startWaking();
      return;
    }
    void this.confirmFailure();
  }

  /** Chamado quando uma requisição obtém resposta: o servidor está de pé. */
  reportRequestSuccess(): void {
    this.failures = 0;
    this.answers++;
    if (this.serverState() === 'waking') this.stopWaking();
    if (this.online()) this.serverState.set('ok');
  }

  /** Volta ao app: a conta de falhas recomeça, o "offline" que o navegador já desmentiu cai e, se o servidor estava acordando, olha já. */
  private onResume(goOnline: () => void): void {
    this.failures = 0;
    this.offlineDeferred = false;
    if (!this.online() && this.win?.navigator.onLine) goOnline();
    if (this.serverState() === 'waking') void this.poll();
  }

  /** O fim da carência: o que o navegador disse sobre estar offline e as falhas contadas nela passam a valer, se ainda valem. */
  private onGraceEnd(): void {
    if (this.offlineDeferred) {
      this.offlineDeferred = false;
      if (this.win && !this.win.navigator.onLine) {
        this.applyOffline();
        return;
      }
    }
    if (this.failures > 0 && this.online() && this.serverState() === 'ok')
      void this.confirmFailure();
  }

  private applyOffline(): void {
    this.online.set(false);
    this.stopWaking();
    this.serverState.set('offline');
  }

  /**
   * A checagem decisiva: uma consulta ao `/health/live`. Se o servidor responde, a falha foi das requisições e nada é mostrado;
   * se não responde, "acordando" começa. Uma checagem por vez, e ela se descarta se uma resposta chegou no meio.
   */
  private async confirmFailure(): Promise<void> {
    if (this.checking || !this.win) return;
    this.checking = true;
    this.probing.set(true);
    const answersBefore = this.answers;
    const alive = await this.probe().finally(() => {
      this.checking = false;
      this.probing.set(false);
    });
    if (alive) {
      this.reportRequestSuccess();
      return;
    }
    if (answersBefore !== this.answers) return;
    if (this.online() && this.serverState() === 'ok') this.startWaking();
  }

  /** Uma consulta ao `/health/live` com prazo; qualquer coisa que não seja uma resposta de sucesso vale como "sem resposta". */
  private async probe(): Promise<boolean> {
    const win = this.win;
    if (!win) return false;
    const controller = new AbortController();
    const cut = setTimeout(() => controller.abort(), this.config.probeTimeoutMs);
    try {
      const response = await win.fetch(this.config.healthUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(cut);
    }
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
    this.wakeEpoch++;
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

  /**
   * Uma rodada da espera: a mesma consulta com prazo da checagem (um servidor que segura a requisição aberta não trava as
   * rodadas seguintes). Uma resposta que chega depois de a espera ter acabado ou recomeçado é de outra época e não vale: nunca
   * sobrescreve um estado mais novo.
   */
  private async poll(): Promise<void> {
    if (this.polling || !this.win) return;
    this.polling = true;
    const epoch = this.wakeEpoch;
    try {
      const alive = await this.probe();
      if (alive && epoch === this.wakeEpoch && this.serverState() === 'waking') {
        this.stopWaking();
        this.serverState.set('ok');
        this.failures = 0;
        this.answers++;
      }
      // sem resposta: a próxima rodada tenta de novo até a janela acabar
    } finally {
      this.polling = false;
    }
  }
}
