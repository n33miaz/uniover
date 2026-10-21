import { signal } from '@angular/core';
import { TvFailure } from './tv-errors';

/** `sent` só vale enquanto o campo é igual ao que a TV recebeu; ao digitar de novo volta a `idle`. */
export type LiveTextStatus = 'idle' | 'sending' | 'sent' | 'error';

/**
 * A parte que fala com a TV, isolada atrás desta interface: o que muda quando a forma de enviar o texto muda (texto
 * completo, só o acréscimo, apagar). O resto (ritmo, uma requisição por vez, coalescência) não depende dela.
 */
export interface LiveTextSender {
  /** Manda o texto; devolve a falha ou `null` se a TV confirmou. Nunca deve lançar. */
  send(text: string): Promise<TvFailure | null>;
  /**
   * Texto que pode ir para a TV: de 0 a 200 caracteres, sem caractere de controle. O **vazio é válido** (apaga o
   * que o agente digitou na TV); só o que passa do limite ou tem caractere de controle nunca é enviado.
   */
  isValid(text: string): boolean;
}

export interface LiveTextOptions {
  /**
   * Cauda: o intervalo mínimo entre o **início** de dois envios. A primeira mudança depois de uma pausa vai na hora
   * (sem esperar); o que se digita durante a cauda se junta num envio só, que sai quando ela termina.
   */
  readonly tailMs: number;
  /**
   * Freio do ritmo: no máximo `maxRequests` envios em qualquer janela deslizante de `windowMs`. Existe porque o
   * servidor aceita 300 comandos por minuto por pessoa (teclas, aquecer e abrir app contam no mesmo balde) e quem
   * digita rápido, com a TV respondendo rápido, passaria disso só com a cauda.
   */
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly sender: LiveTextSender;
}

/**
 * Espelha o campo do celular no campo da TV enquanto se digita. Cada envio leva o **texto completo** (a TV passa a
 * ter exatamente aquele texto, nunca se acrescenta). Regras:
 * - **primeira mudança vai na hora** (borda de subida); as seguintes, enquanto a cauda (`tailMs`) não terminou ou um
 *   envio está em voo, se juntam e só o texto mais recente vai depois (coalescência);
 * - **uma** requisição em voo por vez; o intervalo entre dois envios nunca é menor que a cauda, e nunca passa de
 *   `maxRequests` por `windowMs`;
 * - o que a TV já recebeu não é reenviado;
 * - falha não apaga nada e não gera laço: a próxima mudança tenta de novo (e, se o servidor pediu espera por excesso
 *   de comandos, qualquer envio, inclusive o imediato, aguarda o prazo);
 * - **texto vazio é válido**: apagar o campo até esvaziar manda o vazio, e o agente apaga tudo o que digitou. Só o que
 *   passa do limite ou tem caractere de controle nunca é enviado.
 * O campo do celular não é limpo por aqui: ele é o espelho do da TV.
 */
export class LiveTextSync {
  readonly status = signal<LiveTextStatus>('idle');
  readonly failure = signal<TvFailure | null>(null);

  private latest = '';
  /**
   * O que a TV tem (o último envio confirmado). Começa vazio: abrir e fechar o painel sem digitar nada não manda
   * nada, e apagar de volta ao vazio só manda se a TV tinha algo.
   */
  private lastSent = '';
  private inFlight = false;
  private queued = false;
  /** O que ficou na fila veio de um `flush` (Enter, "Limpar"): quando o envio em voo voltar, sai sem esperar a cauda. */
  private queuedUrgent = false;
  private blockedUntil = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  /** Início dos envios dentro da janela do freio, do mais antigo para o mais novo. */
  private starts: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LiveTextOptions) {}

  /** O campo mudou: envia na hora se der (primeira mudança) ou agenda o texto atual para o fim da cauda. */
  change(text: string): void {
    this.latest = text;
    if (this.status() === 'sent') this.status.set('idle');
    if (!this.options.sender.isValid(text)) {
      // Não vai para a TV: o que estava agendado ou na fila perdeu o sentido.
      this.queued = false;
      this.queuedUrgent = false;
      this.cancelTimer();
      return;
    }
    this.schedule(false);
  }

  /**
   * Envia já o que estiver pendente (Enter, "Limpar" ou ao sair da aba), sem esperar a cauda. Respeita a
   * uma-em-voo, o freio de ritmo e a espera pedida pelo servidor.
   */
  flush(): void {
    this.cancelTimer();
    this.schedule(true);
  }

  private schedule(urgent: boolean): void {
    if (!this.options.sender.isValid(this.latest)) return;
    if (this.inFlight) {
      // O fim do envio em voo reavalia: o mais recente vai então. Não se compara com `lastSent` aqui, porque a TV
      // ainda não confirmou o texto em voo (o vazio digitado logo depois de "abc" não é "o que a TV já tem").
      this.queued = true;
      this.queuedUrgent ||= urgent;
      return;
    }
    if (this.latest === this.lastSent) return;
    const wait = this.waitMs(urgent);
    if (wait <= 0) {
      this.cancelTimer();
      void this.dispatch();
      return;
    }
    // Um só relógio armado: mudanças novas não o adiam (senão digitar sem parar nunca enviaria).
    if (this.timer === undefined) this.arm(wait);
  }

  /** Quanto falta para poder iniciar um envio: o maior entre a espera do servidor, o freio de ritmo e a cauda. */
  private waitMs(urgent: boolean): number {
    const now = Date.now();
    const tail = urgent ? 0 : this.lastStart + this.options.tailMs - now;
    return Math.max(this.blockedUntil - now, this.budgetWait(now), tail);
  }

  /** Quanto falta para caber mais um envio na janela deslizante do freio. */
  private budgetWait(now: number): number {
    const { maxRequests, windowMs } = this.options;
    this.starts = this.starts.filter((at) => at > now - windowMs);
    if (this.starts.length < maxRequests) return 0;
    return this.starts[this.starts.length - maxRequests] + windowMs - now;
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.schedule(false);
    }, ms);
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async dispatch(): Promise<void> {
    const text = this.latest;
    const now = Date.now();
    this.lastStart = now;
    this.starts.push(now);
    this.inFlight = true;
    this.status.set('sending');
    let failure: TvFailure | null;
    try {
      failure = await this.options.sender.send(text);
    } catch {
      failure = { kind: 'unknown', message: '', retryAfterSeconds: null };
    }
    this.inFlight = false;
    if (failure === null) {
      this.lastSent = text;
      this.failure.set(null);
      // Se o campo mudou durante o envio, o que estiver na fila (ou agendado) volta a marcar `sending` sozinho; se ele
      // virou algo que não se envia (passou do limite), nada mais sairá e o estado não pode ficar preso em "enviando".
      this.status.set(this.latest === text ? 'sent' : 'idle');
    } else {
      this.failure.set(failure);
      this.status.set('error');
      if (failure.retryAfterSeconds !== null) {
        this.blockedUntil = Date.now() + failure.retryAfterSeconds * 1000;
      }
    }
    if (this.queued) {
      const urgent = this.queuedUrgent;
      this.queued = false;
      this.queuedUrgent = false;
      this.schedule(urgent);
    }
  }
}
