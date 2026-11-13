import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

/** De quanto em quanto tempo o app conta à API os segundos de uso do canal direto. */
export const DIRECT_USAGE_FLUSH_MS = 60_000;

/** O teto da API para o total de uma sessão (`PcRtcSessions.MaxUsageTotalSeconds`). */
export const DIRECT_USAGE_MAX_SECONDS = 3_600;

const BASE = `${APP_CONFIG.apiBase}/v1/pc/rtc`;

/**
 * Quanto do uso passou pelo canal direto (a "paridade" que a Saúde do Sistema mostra). A API vê cada comando da nuvem, mas o canal
 * direto não passa por ela: o app conta os SEGUNDOS em que mandou tecla ou mouse pelo canal (segundos, não mensagens, para valer
 * igual à conta da nuvem) e manda o TOTAL da sessão, a cada minuto com novidade e quando o canal fecha. Mandar o total (e não a
 * diferença) faz a repetição não somar duas vezes. Nada do que foi digitado sai daqui. É medida, nunca controle: qualquer falha é
 * ignorada e nunca chega à tela.
 */
@Injectable({ providedIn: 'root' })
export class DirectUsage {
  private readonly injector = inject(Injector);
  /** O total de segundos contados em cada sessão do canal. */
  private readonly totals = new Map<string, number>();
  /** As sessões com contagem nova desde o último envio. */
  private readonly changed = new Set<string>();
  /** O último segundo já contado de cada sessão (o mesmo segundo conta uma vez só). */
  private readonly lastSecond = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Saiu tecla ou mouse pelo canal da sessão `sessionId` agora. */
  note(sessionId: string | null, now: number = Date.now()): void {
    if (!sessionId) return;
    const second = Math.floor(now / 1000);
    if (this.lastSecond.get(sessionId) === second) return;
    this.lastSecond.set(sessionId, second);
    this.totals.set(sessionId, (this.totals.get(sessionId) ?? 0) + 1);
    this.changed.add(sessionId);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DIRECT_USAGE_FLUSH_MS);
  }

  /**
   * Manda o total das sessões com novidade. `ended` é a sessão que acabou de fechar (a memória dela some depois do envio);
   * `keepalive` deixa o navegador terminar o pedido com a página fechando.
   */
  flush(options: { readonly ended?: string | null; readonly keepalive?: boolean } = {}): void {
    // Tudo o que mudou sai agora: o temporizador recomeça com a próxima contagem.
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = [...this.changed];
    this.changed.clear();
    for (const sessionId of batch) {
      const total = this.totals.get(sessionId) ?? 0;
      if (total > 0) {
        this.send(sessionId, Math.min(total, DIRECT_USAGE_MAX_SECONDS), options.keepalive === true);
      }
    }
    if (options.ended) {
      this.totals.delete(options.ended);
      this.lastSecond.delete(options.ended);
    }
  }

  private send(sessionId: string, totalSeconds: number, keepalive: boolean): void {
    try {
      const http = this.injector.get(HttpClient);
      firstValueFrom(
        http.post(
          `${BASE}/${encodeURIComponent(sessionId)}/usage`,
          { totalSeconds },
          keepalive ? { keepalive: true } : {},
        ),
      ).catch(() => undefined);
    } catch {
      // Sem cliente HTTP (ou falha ao montar o pedido): a medida se perde, o controle segue igual.
    }
  }
}
