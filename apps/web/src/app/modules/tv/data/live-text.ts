import { signal } from '@angular/core';
import { TvFailure } from './tv-errors';

/** `sent` só vale enquanto o campo é igual ao que a TV recebeu; ao digitar de novo volta a `idle`. */
export type LiveTextStatus = 'idle' | 'sending' | 'sent' | 'error';

export interface LiveTextOptions {
  /** Pausa de digitação que dispara o envio. */
  readonly debounceMs: number;
  /** Manda o texto completo; devolve a falha ou `null` se a TV confirmou. Nunca deve lançar. */
  readonly send: (text: string) => Promise<TvFailure | null>;
  /** Texto que pode ir para a TV (o vazio e o que passa do limite nunca são enviados). */
  readonly isValid: (text: string) => boolean;
}

/**
 * Espelha o campo do celular no campo da TV enquanto se digita. Cada envio leva o **texto completo** (a TV passa a
 * ter exatamente aquele texto, nunca se acrescenta). Regras:
 * - só depois de uma pausa (`debounceMs`) sem digitar;
 * - **uma** requisição em voo por vez; se o texto mudar enquanto envia, só o mais recente vai depois (coalescência);
 * - o que a TV já recebeu não é reenviado;
 * - falha não apaga nada e não gera laço: a próxima mudança tenta de novo (e, se o servidor pediu espera por excesso
 *   de comandos, essa tentativa aguarda o prazo);
 * - texto vazio ou inválido nunca é enviado (o controle remoto não consegue esvaziar o campo da TV).
 * O campo do celular não é limpo por aqui: ele é o espelho do da TV.
 */
export class LiveTextSync {
  readonly status = signal<LiveTextStatus>('idle');
  readonly failure = signal<TvFailure | null>(null);

  private latest = '';
  private lastSent: string | null = null;
  private inFlight = false;
  private queued = false;
  private blockedUntil = 0;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LiveTextOptions) {}

  /** O campo mudou: agenda o envio do texto atual depois da pausa. */
  change(text: string): void {
    this.latest = text;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.status() === 'sent') this.status.set('idle');
    if (!this.options.isValid(text)) {
      this.queued = false;
      return;
    }
    this.arm(this.options.debounceMs);
  }

  /** Envia já o que estiver pendente (Enter, ou ao sair da aba). Respeita a uma-em-voo e a espera do servidor. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.fire();
  }

  /** "Limpar": esquece o que estava pendente e o que foi enviado, para o mesmo texto poder ser enviado de novo. */
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = '';
    this.lastSent = null;
    this.queued = false;
    this.epoch++;
    this.status.set('idle');
    this.failure.set(null);
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, ms);
  }

  private fire(): void {
    if (!this.options.isValid(this.latest) || this.latest === this.lastSent) return;
    const wait = this.blockedUntil - Date.now();
    if (wait > 0) {
      this.arm(wait);
      return;
    }
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    void this.dispatch();
  }

  private async dispatch(): Promise<void> {
    const text = this.latest;
    const epoch = this.epoch;
    this.inFlight = true;
    this.status.set('sending');
    let failure: TvFailure | null;
    try {
      failure = await this.options.send(text);
    } catch {
      failure = { kind: 'unknown', message: '', retryAfterSeconds: null };
    }
    this.inFlight = false;
    if (epoch !== this.epoch) return;
    if (failure === null) {
      this.lastSent = text;
      this.failure.set(null);
      // Se o campo mudou durante o envio, um envio agendado (ou fila) volta a marcar `sending` sozinho; se ele
      // virou vazio ou passou do limite, nada mais será enviado e o estado não pode ficar preso em "enviando".
      this.status.set(this.latest === text ? 'sent' : 'idle');
    } else {
      this.failure.set(failure);
      this.status.set('error');
      if (failure.retryAfterSeconds !== null) {
        this.blockedUntil = Date.now() + failure.retryAfterSeconds * 1000;
      }
    }
    if (this.queued) {
      this.queued = false;
      this.fire();
    }
  }
}
