import { Injectable, signal } from '@angular/core';

/**
 * O estado do cronômetro da apresentação. Mora num serviço, e não na tela, para sobreviver à troca de modo da Mídia e de aba
 * do módulo: quem confere o relógio no meio de uma apresentação não pode perder a contagem. Vive só neste aparelho e na
 * memória: não lê nada do PC, não manda nada a ele e some ao recarregar a página. Conta pelo relógio (`Date.now`), então a
 * tela apagada ou a aba em segundo plano não o atrasa.
 */
@Injectable({ providedIn: 'root' })
export class PcSlideTimerState {
  readonly running = signal(false);
  /** O que passou antes da última retomada, em ms, e quando ela foi. */
  private before = 0;
  private resumedAt = 0;

  /** Quanto já foi contado, em ms, até `now`. */
  elapsedMs(now = Date.now()): number {
    return this.before + (this.running() ? Math.max(0, now - this.resumedAt) : 0);
  }

  toggle(): void {
    if (this.running()) {
      this.before = this.elapsedMs();
      this.running.set(false);
      return;
    }
    this.resumedAt = Date.now();
    this.running.set(true);
  }

  reset(): void {
    this.before = 0;
    this.running.set(false);
  }
}
