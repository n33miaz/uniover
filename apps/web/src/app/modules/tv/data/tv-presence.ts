import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { TvApi } from './tv-api';
import { TV_CONFIG } from './tv-config';

/**
 * O sinal de presença ("alguém acabou de tocar na tela da TV"): o único que deixa o agente abrir uma conexão ADB nova por
 * conta própria. Um só para as telas da TV (controle e TV Livre), para o espaço mínimo entre sinais valer para todas.
 *
 * Quem o chama espera o retorno antes de pedir algo que use o ADB: se um sinal já está a caminho (o `pointerdown` que
 * antecede o clique), a segunda chamada **espera esse mesmo envio** em vez de voltar na hora. Assim o pedido nunca chega ao
 * agente antes da presença. Só com a página **visível** (não basta "não oculta"); falha não vira aviso e libera uma nova
 * tentativa no toque seguinte. A espera é limitada a `presenceMaxWaitMs`: o sinal continua a caminho, mas o pedido não
 * fica parado atrás de um gateway que segura a requisição enquanto o agente reconecta.
 */
@Injectable({ providedIn: 'root' })
export class TvPresence {
  private readonly api = inject(TvApi);
  private readonly config = inject(TV_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private lastAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  async signal(): Promise<void> {
    if (this.doc.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - this.lastAt < this.config.presenceMinIntervalMs) {
      if (this.inFlight) await this.atMost(this.inFlight);
      return;
    }
    this.lastAt = now;
    const sending = this.send();
    this.inFlight = sending;
    void sending.finally(() => {
      if (this.inFlight === sending) this.inFlight = null;
    });
    await this.atMost(sending);
  }

  /** Espera `promise` por no máximo `presenceMaxWaitMs` (o que passar disso segue por conta própria). */
  private atMost(promise: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.config.presenceMaxWaitMs);
      void promise.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async send(): Promise<void> {
    try {
      await this.api.presence();
    } catch {
      // Sem aviso: é só um sinal; o próximo toque tenta de novo.
      this.lastAt = Number.NEGATIVE_INFINITY;
    }
  }
}
