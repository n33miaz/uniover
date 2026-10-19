import { DestroyRef, Directive, inject, input, signal } from '@angular/core';
import { TV_CONFIG } from '../data/tv-config';
import { TvStore } from '../data/tv-store';
import { TvKey } from '../data/tv-types';
import { HoldRepeater } from './hold-repeater';

/** Tempo depois do fim do toque em que um clique ainda é "o mesmo toque" (e não uma tecla do teclado). */
const CLICK_ECHO_MS = 500;

/**
 * Liga um botão a uma tecla da TV. A tecla sai no **clique** (ao soltar): um dedo que começa a deslizar sobre o
 * botão para virar a página do controle cancela o toque e nada é enviado, então o carrossel nunca aperta tecla sem
 * querer. Com `repeat`, segurar o botão repete a tecla a cada ~250 ms (a primeira vez ao passar o tempo de espera)
 * até soltar ou falhar; o clique que o navegador gera ao soltar, depois de repetir, é ignorado para a tecla não
 * sair uma vez a mais. Teclado e leitor de tela chegam como clique e mandam a tecla uma vez. O botão fica
 * desabilitado quando o controle não pode mandar comandos. O estado (volume, conexão) nunca muda por aqui: só pelo
 * que o servidor informa.
 */
@Directive({
  selector: '[appKey]',
  host: {
    '[attr.disabled]': 'store.canSend() ? null : ""',
    '[class.pressed]': 'pressed()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointerup)': 'onPointerEnd()',
    '(pointercancel)': 'onPointerEnd()',
    '(lostpointercapture)': 'onPointerEnd()',
    '(click)': 'onClick()',
    '(contextmenu)': '$event.preventDefault()',
  },
})
export class KeyButton {
  protected readonly store = inject(TvStore);
  private readonly config = inject(TV_CONFIG);

  readonly appKey = input.required<TvKey>();
  /** Segurar repete a tecla (setas e volume). */
  readonly repeat = input(false);

  protected readonly pressed = signal(false);

  private readonly repeater = new HoldRepeater(
    () => {
      this.repeated = true;
      this.send();
    },
    this.config.repeatDelayMs,
    this.config.repeatIntervalMs,
    // Comandos demais sem resposta: a rodada passa, a repetição não para.
    () => this.store.inFlightKeys() >= this.config.maxKeysInFlight,
  );
  private repeated = false;
  private echoTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.repeater.stop();
      clearTimeout(this.echoTimer);
    });
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!this.store.canSend()) return;
    clearTimeout(this.echoTimer);
    this.repeated = false;
    this.pressed.set(true);
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // sem captura o `pointerup` ainda chega enquanto o dedo estiver sobre o botão
    }
    if (this.repeat()) this.repeater.start();
  }

  protected onPointerEnd(): void {
    this.repeater.stop();
    this.pressed.set(false);
    clearTimeout(this.echoTimer);
    // Se o toque virou repetição e o clique não chegar, o aviso de "já repetiu" não pode vazar para o próximo toque.
    this.echoTimer = setTimeout(() => (this.repeated = false), CLICK_ECHO_MS);
  }

  protected onClick(): void {
    if (this.repeated) {
      this.repeated = false;
      return;
    }
    this.send();
  }

  private send(): void {
    vibrate();
    void this.store.sendKey(this.appKey()).then((ok) => {
      if (!ok) this.repeater.stop();
    });
  }
}

/** Vibração curta onde existe (o iOS não tem), respeitando "reduzir movimento". */
export function vibrate(): void {
  try {
    if (typeof navigator.vibrate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(8);
  } catch {
    // sem vibração: nada a fazer
  }
}
