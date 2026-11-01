import { signal } from '@angular/core';

/**
 * Acompanha UMA primeira leitura (o estado ou a lista de atalhos) que ainda não chegou. Serve a duas coisas, sempre com
 * teto, para a tela nunca ficar em espera em laço:
 * - `skeleton`: vira verdadeiro só depois de `delayMs` (uma leitura rápida não pisca) e enquanto a leitura segue pendente;
 * - `timedOut`: vira verdadeiro quando passam `timeoutMs` sem resposta; aí o esqueleto sai e a tela mostra o erro com
 *   "Tentar de Novo". O relógio não corre enquanto `paused()` (o servidor acordando de uma partida a frio): ele só
 *   recomeça a contagem, em vez de dar a leitura como perdida por culpa dele.
 * `done` (a leitura chegou) e `stop` (a tela parou ou a TV mudou) apagam tudo.
 */
export class ReadWatch {
  readonly skeleton = signal(false);
  readonly timedOut = signal(false);
  private pending = false;
  private skeletonTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly delayMs: () => number,
    private readonly timeoutMs: () => number,
    private readonly paused: () => boolean,
  ) {}

  /**
   * Uma leitura saiu e ainda não há dado: começa os dois relógios. Com uma já pendente não faz nada (várias partes da tela
   * pedem a leitura ao mesmo tempo, e cada pedido não pode empurrar o teto para frente); depois de um erro mostrado, sim,
   * recomeça: é o "Tentar de Novo".
   */
  begin(): void {
    if (this.pending) return;
    this.stop();
    this.timedOut.set(false);
    this.pending = true;
    this.skeletonTimer = setTimeout(() => {
      if (this.pending) this.skeleton.set(true);
    }, this.delayMs());
    this.armTimeout();
  }

  /** A leitura chegou: nada mais a esperar, nem esqueleto, nem erro. */
  done(): void {
    this.stop();
    this.timedOut.set(false);
  }

  /** Apaga os relógios e o esqueleto, sem mexer no erro já mostrado. */
  stop(): void {
    clearTimeout(this.skeletonTimer);
    clearTimeout(this.timeoutTimer);
    this.skeletonTimer = undefined;
    this.timeoutTimer = undefined;
    this.pending = false;
    this.skeleton.set(false);
  }

  private armTimeout(): void {
    this.timeoutTimer = setTimeout(() => {
      if (!this.pending) return;
      if (this.paused()) {
        this.armTimeout();
        return;
      }
      this.pending = false;
      this.skeleton.set(false);
      this.timedOut.set(true);
    }, this.timeoutMs());
  }
}
