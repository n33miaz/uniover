import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import { MAX_STEPS_AFTER_RELEASE, VolumeDrag } from '../input/volume-drag';

/** Segurar o volume repete: espera um pouco antes da primeira repetição e depois segue neste ritmo. */
const REPEAT_AFTER_MS = 420;
const REPEAT_EVERY_MS = 190;
/** Passos do volume sem resposta que a repetição tolera (com a rede lenta, o pedido seguinte não espera o anterior). */
const MAX_VOLUME_IN_FLIGHT = 3;
/** O quanto o botão do arrasto pode sair do centro, como fração da meia largura (o resto do arrasto vale, só o desenho para). */
const THUMB_REACH = 0.5;

type VolumeAction = 'VOLUME_UP' | 'VOLUME_DOWN';

/**
 * O volume do PC, em passos relativos: menos, uma faixa de arrastar e mais. Segurar os botões repete (já existia); arrastar
 * a faixa para os lados sobe e desce o volume continuamente, no ritmo do dedo, e o botão volta ao meio ao soltar. A faixa
 * não mostra nível nenhum: ela é relativa, e quem diz em que volume o PC está é o controle de nível (`app-pc-volume-level`), que só aparece com um PC que avisa o volume. Os botões seguem sendo o
 * caminho do teclado e do leitor de tela (a faixa é só de toque). Tudo sai por `sendMedia`, o mesmo caminho dos outros
 * comandos de mídia.
 */
@Component({
  selector: 'app-pc-volume',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="vol"
      aria-label="Diminuir o volume"
      i18n-aria-label="@@pc.media.volume-down"
      [disabled]="!store.canSend()"
      (pointerdown)="hold('VOLUME_DOWN', $event)"
      (pointerup)="release()"
      (pointercancel)="release()"
      (lostpointercapture)="release()"
      (pointerleave)="release()"
      (click)="$event.detail === 0 && press('VOLUME_DOWN')"
      (contextmenu)="$event.preventDefault()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5a4 4 0 0 1 0 5'" />
      </svg>
    </button>

    <div
      class="strip"
      aria-hidden="true"
      [class.dragging]="dragging()"
      [class.off]="!store.canSend()"
      (pointerdown)="begin($event)"
      (pointermove)="move($event)"
      (pointerup)="end($event)"
      (pointercancel)="end($event)"
      (lostpointercapture)="end($event)"
      (pointerleave)="leave($event)"
      (contextmenu)="$event.preventDefault()"
    >
      <svg class="hint left" viewBox="0 0 24 24"><path [attr.d]="'M14 7l-5 5 5 5'" /></svg>
      <svg class="hint right" viewBox="0 0 24 24"><path [attr.d]="'M10 7l5 5-5 5'" /></svg>
      <span class="thumb" [style.transform]="'translateX(' + offset() + 'px)'"></span>
    </div>

    <button
      type="button"
      class="vol"
      aria-label="Aumentar o volume"
      i18n-aria-label="@@pc.media.volume-up"
      [disabled]="!store.canSend()"
      (pointerdown)="hold('VOLUME_UP', $event)"
      (pointerup)="release()"
      (pointercancel)="release()"
      (lostpointercapture)="release()"
      (pointerleave)="release()"
      (click)="$event.detail === 0 && press('VOLUME_UP')"
      (contextmenu)="$event.preventDefault()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          [attr.d]="'M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11'"
        />
      </svg>
    </button>
  `,
  styleUrl: './volume.css',
})
export class PcVolume {
  protected readonly store = inject(PcStore);
  protected readonly dragging = signal(false);
  /** O quanto o botão do arrasto está fora do meio, em pixels (só o desenho). */
  protected readonly offset = signal(0);

  private startTimer: number | null = null;
  private repeatTimer: number | null = null;
  /** Passos do volume ainda sem resposta: a repetição não espera a ida e volta do anterior, mas não se acumula sem fim. */
  private inFlight = 0;

  private readonly drag = new VolumeDrag();
  private pointerId: number | null = null;
  private lastX = 0;
  private reach = 0;
  /** Há um pedido do arrasto em voo: o seguinte só sai quando ele volta (um por vez, na ordem). */
  private sending = false;
  private destroyed = false;
  /** O ponteiro do arrasto está capturado pela faixa; sem isso (a captura falhou) o fim do dedo vem de fora da faixa. */
  private captured = false;

  constructor() {
    const destroy = inject(DestroyRef);
    // Esconder a página ou ir para o segundo plano não pode deixar o volume subindo (o iOS nem avisa o componente).
    const onHide = () => this.stopAll();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.stopAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    // Sem captura de ponteiro a faixa não ouve o dedo sair dela: o fim do toque se ouve na janela.
    const onWindowEnd = (event: PointerEvent) => {
      if (!this.captured) this.end(event);
    };
    window.addEventListener('pointerup', onWindowEnd);
    window.addEventListener('pointercancel', onWindowEnd);
    destroy.onDestroy(() => {
      this.destroyed = true;
      this.stopAll();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pointerup', onWindowEnd);
      window.removeEventListener('pointercancel', onWindowEnd);
    });
    // O PC caiu no meio de um toque: nada mais sai, e o arrasto e a repetição acabam.
    effect(() => {
      if (!this.store.canSend()) untracked(() => this.stopAll());
    });
  }

  /** Para a repetição e o arrasto de vez, sem mandar o que esperava (a página se foi, o PC caiu, a tela acabou). */
  private stopAll(): void {
    this.release();
    this.drag.reset();
    this.pointerId = null;
    this.captured = false;
    this.dragging.set(false);
    this.offset.set(0);
  }

  protected press(action: VolumeAction): void {
    tick();
    void this.store.sendMedia(action);
  }

  /** Aperta uma vez já e, se o dedo ficar, repete o volume até soltar (no máximo `MAX_VOLUME_IN_FLIGHT` sem resposta). */
  protected hold(action: VolumeAction, event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.release();
    this.step(action);
    this.startTimer = window.setTimeout(() => {
      this.repeatTimer = window.setInterval(() => this.step(action), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
  }

  protected release(): void {
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    if (this.repeatTimer !== null) window.clearInterval(this.repeatTimer);
    this.startTimer = null;
    this.repeatTimer = null;
  }

  protected begin(event: PointerEvent): void {
    if (!this.store.canSend() || this.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const strip = event.currentTarget as HTMLElement;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.reach = (strip.getBoundingClientRect().width / 2) * THUMB_REACH;
    this.drag.reset();
    this.offset.set(0);
    this.dragging.set(true);
    try {
      strip.setPointerCapture(event.pointerId);
      this.captured = true;
    } catch {
      // Sem captura (o ponteiro já acabou): o arrasto acaba quando o dedo sai da faixa ou sobe em qualquer lugar da janela.
      this.captured = false;
    }
  }

  protected move(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastX;
    this.lastX = event.clientX;
    this.offset.set(Math.max(-this.reach, Math.min(this.reach, this.offset() + dx)));
    this.drag.move(dx);
    this.flush();
  }

  /** O dedo saiu da faixa sem captura: o arrasto acaba ali. Com captura o `pointerleave` não conta (o dedo segue valendo fora). */
  protected leave(event: PointerEvent): void {
    if (!this.captured) this.end(event);
  }

  /**
   * O dedo saiu: o botão volta ao meio e o que já foi andado ainda sai, mas só um pouco (`MAX_STEPS_AFTER_RELEASE`): a rede
   * lenta não pode seguir mexendo no volume muito depois de soltar. Nenhum pedido novo nasce depois disto.
   */
  protected end(event: PointerEvent): void {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.captured = false;
    this.dragging.set(false);
    this.offset.set(0);
    this.drag.limit(MAX_STEPS_AFTER_RELEASE);
    this.flush();
  }

  /** Manda o próximo grupo de passos se não há pedido em voo; ao voltar, segue com o que juntou nesse meio tempo. */
  private flush(): void {
    if (this.sending || this.destroyed) return;
    const request = this.drag.take();
    if (!request) return;
    this.sending = true;
    tick(5);
    void this.store.sendMedia(`VOLUME_${request.direction}`, request.steps).then(
      (failure) => {
        this.sending = false;
        // Falhou: o resto do arrasto não vai (a falha já está na tela); tentar de novo seria mexer no volume às cegas.
        if (failure) this.drag.reset();
        else this.flush();
      },
      () => {
        this.sending = false;
        this.drag.reset();
      },
    );
  }

  private step(action: VolumeAction): void {
    // Cada rodada confere o PC: com ele fora a repetição não manda nada (e o efeito do construtor a encerra).
    if (!this.store.canSend()) return;
    if (this.inFlight >= MAX_VOLUME_IN_FLIGHT) return;
    this.inFlight++;
    tick(5);
    void this.store.sendMedia(action).finally(() => {
      this.inFlight--;
    });
  }
}
