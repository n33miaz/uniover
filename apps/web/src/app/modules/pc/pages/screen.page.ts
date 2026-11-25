import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  DirectChannel,
  DirectNotSent,
  DirectSignaling,
  PC_RTC_FACTORY,
  gatherDirectIce,
} from '../../../core/direct/direct-channel';
import { pcFailureOf } from '../data/pc-failure';
import { PcStore } from '../data/pc-store';
import { PcScreenAccess } from '../data/screen-access';
import {
  DEFAULT_SCREEN_TOUCH,
  ImageView,
  ScreenTouch,
  tapTarget,
  type TouchPoint,
} from '../data/screen-touch';
import {
  ScreenFrameLoop,
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenCursor,
  type ScreenMonitor,
  type ScreenViewState,
  type ScreenViewerFrame,
} from '../data/screen-viewer';
import { PadGesture } from '../input/pad-gesture';

const START_TIMEOUT_MS = 20_000;
/** A API encerra a sessão de tela em 90 s; a página reabre sozinha um pouco antes, sem o usuário perceber mais que um piscar. */
const RENEW_MS = 75_000;
/** A imagem não precisa passar da largura que o aparelho consegue mostrar (e 1280 basta para ler texto). */
const MAX_WIDTH = 1280;
/** O menor que o PC aceita. */
const MIN_WIDTH = 128;

/** Como o dedo age na imagem: toca no ponto (posição absoluta) ou move o ponteiro como no touchpad. */
type TouchMode = 'direct' | 'pad';

type Phase = 'idle' | 'connecting' | 'live' | 'paused' | 'locked' | 'failed';

/** O monitor e o arranjo (`s.mon`) de um pedido de quadro: o que o quadro que responde a ele mostra. */
interface FrameView {
  readonly monitor: ScreenMonitor;
  readonly layout: number | null;
}

interface Link {
  readonly connection: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  readonly assembler: ScreenViewerFrameAssembler;
  readonly loop: ScreenFrameLoop;
  readonly parentSessionId: string;
  sessionId: string | null;
  painting: boolean;
  /** Monitor do último `s.get` enviado (o do pedido em andamento, se houver). */
  requested?: number;
  /** O monitor e o arranjo do último `s.get` enviado: o quadro que chega responde a ele (um pedido por vez). */
  requestedView?: FrameView;
  watchdog?: ReturnType<typeof setTimeout>;
  renew?: ReturnType<typeof setTimeout>;
}

/**
 * A tela do PC ao vivo, em "foto ao vivo": pede um JPEG de cada vez ao PC (`s.get`), desenha e só então pede o próximo.
 * Só aparece para o dono, com o PC declarando a capacidade (atrás do `pc_screen`). Para de pedir quando a página fica
 * oculta ou é fechada, e fecha a sessão da tela junto.
 */
@Component({
  selector: 'app-pc-screen-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!access.allowed()) {
      <p class="note" i18n="@@pc.screen.unavailable">A tela do PC não está disponível aqui.</p>
    } @else {
      @if (monitors().length > 1) {
        <div
          class="monitors"
          role="group"
          aria-label="Monitores"
          i18n-aria-label="@@pc.screen.monitors"
        >
          @for (item of monitors(); track item.id; let index = $index) {
            <button
              type="button"
              [attr.aria-pressed]="item.id === monitorId()"
              (click)="selectMonitor(item.id)"
            >
              <span i18n="@@pc.screen.monitor">Monitor {{ index + 1 }}</span>
            </button>
          }
        </div>
      }
      @if (access.touch() && hasFrame()) {
        <div
          class="tools"
          role="group"
          aria-label="Toque na tela"
          i18n-aria-label="@@pc.screen.touch"
        >
          <button type="button" [attr.aria-pressed]="mode() === 'pad'" (click)="toggleMode()">
            @if (mode() === 'direct') {
              <span i18n="@@pc.screen.mode.direct">Toque direto</span>
            } @else {
              <span i18n="@@pc.screen.mode.pad">Touchpad</span>
            }
          </button>
          @if (mode() === 'direct') {
            <button type="button" [attr.aria-pressed]="scrolling()" (click)="toggleScroll()">
              <span i18n="@@pc.screen.scroll">Rolar</span>
            </button>
            @if (zoomed()) {
              <button type="button" (click)="resetZoom()">
                <span i18n="@@pc.screen.zoom.reset">Zoom 1x</span>
              </button>
            }
          }
        </div>
      }
      <div
        #stage
        class="stage"
        [class.touch]="access.touch()"
        [hidden]="!hasFrame()"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onCancel()"
      >
        <div class="view" [style.transform]="viewTransform()">
          <canvas
            #surface
            width="1"
            height="1"
            aria-label="Tela do PC"
            i18n-aria-label="@@pc.screen.canvas"
          ></canvas>
          @if (pointer(); as spot) {
            <svg
              class="cursor"
              viewBox="0 0 24 24"
              aria-hidden="true"
              [style.left.%]="spot.left"
              [style.top.%]="spot.top"
            >
              <path [attr.d]="'M5 3l14 8-6 2-3 6z'" />
            </svg>
          }
        </div>
      </div>
      @if (notice(); as text) {
        <p class="note notice" role="status">{{ text }}</p>
      }
      @if (touchNotice(); as text) {
        <p class="note notice" role="status">{{ text }}</p>
      }
      @if (!canOpen() && phase() === 'idle') {
        <p class="note" i18n="@@pc.screen.waitDirect">
          Aguardando o canal direto do PC na rede local.
        </p>
      }
      @if (phase() === 'live' || phase() === 'connecting') {
        <button type="button" class="action" (click)="stop()" i18n="@@pc.screen.stop">Parar</button>
      } @else {
        <button
          type="button"
          class="action"
          [disabled]="!canOpen()"
          (click)="open()"
          i18n="@@pc.screen.open"
        >
          Ver a tela
        </button>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .stage {
      position: relative;
      line-height: 0;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--a-surface);
    }
    .stage.touch {
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    .view {
      position: relative;
      transform-origin: 0 0;
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .tools button {
      min-height: 44px;
      padding: 0 var(--space-4);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      touch-action: manipulation;
    }
    .tools button[aria-pressed='true'] {
      background: var(--a-accent-soft);
      border-color: var(--a-accent);
    }
    canvas {
      display: block;
      width: 100%;
      height: auto;
    }
    .cursor {
      position: absolute;
      width: 18px;
      height: 18px;
      fill: var(--a-ink);
      stroke: var(--a-surface);
      stroke-width: 1.5;
      pointer-events: none;
    }
    .monitors {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .monitors button,
    .action {
      min-height: 44px;
      padding: 0 var(--space-4);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      touch-action: manipulation;
    }
    .monitors button[aria-pressed='true'] {
      background: var(--a-accent-soft);
      border-color: var(--a-accent);
    }
    button:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.5;
    }
    .note {
      margin: 0;
      color: var(--a-ink2);
    }
  `,
})
export class ScreenPage {
  protected readonly access = inject(PcScreenAccess);
  private readonly direct = inject(DirectChannel);
  private readonly signaling = inject(DirectSignaling);
  private readonly factory = inject(PC_RTC_FACTORY);
  private readonly doc = inject(DOCUMENT);
  private readonly store = inject(PcStore);
  private readonly surface = viewChild<ElementRef<HTMLCanvasElement>>('surface');
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly view = new ImageView(1, 1);
  private readonly zoom = signal({ scale: 1, panX: 0, panY: 0 });
  private link: Link | null = null;

  protected readonly phase = signal<Phase>('idle');
  protected readonly monitors = signal<readonly ScreenMonitor[]>([]);
  protected readonly monitorId = signal<number | null>(null);
  /** A impressão do arranjo do último `s.mon` (`null` num PC anterior ao toque na tela). */
  private readonly layout = signal<number | null>(null);
  /** O que o quadro NA TELA mostra (não o monitor selecionado, cujo quadro pode ainda estar a caminho). */
  private readonly painted = signal<FrameView | null>(null);
  protected readonly cursor = signal<ScreenCursor | null>(null);
  protected readonly state = signal<ScreenViewState>('ok');
  protected readonly hasFrame = signal(false);
  protected readonly mode = signal<TouchMode>('direct');
  protected readonly scrolling = signal(false);
  protected readonly touchNotice = signal<string | null>(null);
  protected readonly zoomed = computed(() => this.zoom().scale > 1);
  protected readonly viewTransform = computed(() => {
    const { scale, panX, panY } = this.zoom();
    return scale === 1 ? null : `translate(${panX}px, ${panY}px) scale(${scale})`;
  });

  /** Os dedos no modo "toque direto": clique, clique direito, duplo e arrasto pela posição absoluta. */
  private readonly touch = new ScreenTouch(
    {
      tap: (button, action, at) => this.tapAt(button, action, at),
      drag: (at) => this.dragTo(at),
      pinch: (factor, center, dx, dy) => this.pinchView(factor, center, dx, dy),
      scroll: (dx, dy) => this.store.scrollPointer(dx, dy),
    },
    DEFAULT_SCREEN_TOUCH,
  );

  /** Os dedos no modo touchpad sobre a imagem: o movimento relativo de sempre. */
  private readonly pad = new PadGesture({
    move: (dx, dy, elapsedMs) => this.store.movePointer(dx, dy, elapsedMs),
    scroll: (dx, dy, elapsedMs) => this.store.scrollPointer(dx, dy, elapsedMs),
    tap: (button) => void this.store.click(button),
    dragStart: () => void this.store.startDrag(),
    dragEnd: () => void this.store.release(),
  });

  protected readonly canOpen = computed(
    () => this.access.allowed() && this.factory !== null && this.direct.pcSessionId() !== null,
  );
  protected readonly current = computed(
    () => this.monitors().find((item) => item.id === this.monitorId()) ?? null,
  );
  /**
   * O toque direto só vale quando o quadro na tela é o do monitor selecionado, no arranjo do último `s.mon`: logo depois de trocar
   * de monitor (ou de o arranjo mudar) a imagem ainda é a anterior, e um toque nela cairia no lugar errado. Um quadro antigo que
   * chegue depois da troca é do pedido antigo e não reabilita.
   */
  private readonly touchReady = computed(() => {
    const painted = this.painted();
    const monitor = this.current();
    const layout = this.layout();
    return (
      painted !== null &&
      monitor !== null &&
      layout !== null &&
      painted.layout === layout &&
      painted.monitor.id === monitor.id &&
      painted.monitor.width === monitor.width &&
      painted.monitor.height === monitor.height
    );
  });
  /** A posição do cursor em porcentagem da imagem. */
  protected readonly pointer = computed(() => {
    const monitor = this.current();
    const cursor = this.cursor();
    if (!monitor || !cursor) return null;
    const clamp = (value: number) => Math.min(100, Math.max(0, value));
    return {
      left: clamp((cursor.x / monitor.width) * 100),
      top: clamp((cursor.y / monitor.height) * 100),
    };
  });
  protected readonly notice = computed(() => {
    switch (this.phase()) {
      case 'connecting':
        return $localize`:@@pc.screen.connecting:Abrindo a tela do PC…`;
      case 'failed':
        return $localize`:@@pc.screen.failed:Não foi possível mostrar a tela do PC.`;
      case 'paused':
        return $localize`:@@pc.screen.paused:A tela parou porque a página ficou oculta.`;
      case 'locked':
        return this.lockedText();
    }
    if (this.phase() !== 'live') return null;
    if (this.state() === 'locked') return this.lockedText();
    if (this.state() === 'elevated') {
      return $localize`:@@pc.screen.elevated:Há uma janela de administrador na tela: o Windows não deixa controlá-la daqui.`;
    }
    return null;
  });

  private lockedText(): string {
    return $localize`:@@pc.screen.locked:PC bloqueado ou aviso do Windows na tela: confirme no PC.`;
  }

  constructor() {
    // O palco muda de tamanho (girar o aparelho, a barra do navegador): o zoom e o deslocamento são ajustados e aplicados já,
    // para o toque seguinte usar a mesma transformação da imagem na tela.
    effect((onCleanup) => {
      const stage = this.stage()?.nativeElement;
      if (!stage || typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver(() => this.syncStage());
      observer.observe(stage);
      onCleanup(() => observer.disconnect());
    });
    effect(() => {
      // Perdeu a permissão, o dono ou o canal direto do PC: a tela fecha.
      // Os sinais são lidos antes de `link` (que não é sinal) para o efeito sempre registrar a dependência.
      const open = this.canOpen();
      const parent = this.direct.pcSessionId();
      if (this.link && (!open || parent !== this.link.parentSessionId)) this.finish('failed');
    });
    let resume = false;
    const visibility = () => {
      if (this.doc.visibilityState === 'hidden') {
        resume = this.link !== null;
        if (resume) this.finish('paused');
      } else if (resume) {
        resume = false;
        if (this.canOpen()) void this.open();
      }
    };
    const hide = () => {
      resume = false;
      this.finish('idle');
    };
    this.doc.addEventListener('visibilitychange', visibility);
    this.doc.defaultView?.addEventListener('pagehide', hide);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', visibility);
      this.doc.defaultView?.removeEventListener('pagehide', hide);
      hide();
    });
  }

  protected stop(): void {
    this.finish('idle');
  }

  protected async open(): Promise<void> {
    const parentSessionId = this.direct.pcSessionId();
    if (this.link || !this.factory || !this.canOpen() || !parentSessionId) return;
    this.phase.set('connecting');
    this.state.set('ok');
    let link: Link | null = null;
    let connection: RTCPeerConnection | null = null;
    try {
      connection = this.factory();
      const channel = connection.createDataChannel('screen', { ordered: true });
      channel.binaryType = 'arraybuffer';
      const active: Link = {
        connection,
        channel,
        assembler: new ScreenViewerFrameAssembler(),
        loop: new ScreenFrameLoop({
          send: (text) => channel.send(text),
          view: () => {
            const view = this.viewRequest();
            const monitor = this.current();
            if (view && monitor) {
              active.requested = view.monitor;
              active.requestedView = { monitor, layout: this.layout() };
            }
            return view;
          },
          onTimeout: () => {
            if (this.link === active) this.finish(this.state() === 'locked' ? 'locked' : 'failed');
          },
        }),
        parentSessionId,
        sessionId: null,
        painting: false,
      };
      link = active;
      this.link = active;
      this.listen(active);
      await connection.setLocalDescription(await connection.createOffer());
      await gatherDirectIce(connection);
      if (this.link !== active) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error('oferta ausente');
      const answer = await this.signaling.offer(sdp, {
        scopes: ['screen'],
        tvId: null,
        parentSessionId,
      });
      if (this.link !== active) {
        void this.signaling.close(answer.sessionId, true).catch(() => undefined);
        return;
      }
      active.sessionId = answer.sessionId;
      if (!answer.scopes.includes('screen')) throw new Error('escopo de tela ausente');
      // O PC conta os 90 s da sessão a partir da oferta aceita, não do primeiro `s.mon`: a margem vale desde já.
      active.renew = setTimeout(() => this.renew(active), RENEW_MS);
      channel.addEventListener(
        'open',
        () => {
          if (this.link !== active) return;
          try {
            channel.send(JSON.stringify({ k: 'auth', token: answer.token }));
          } catch {
            this.finish('failed');
          }
        },
        { once: true },
      );
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch {
      if (link && this.link === link) this.finish('failed');
      else if (!link) {
        connection?.close();
        this.phase.set('failed');
      }
    }
  }

  protected toggleMode(): void {
    this.settleTouch();
    this.mode.update((mode) => (mode === 'direct' ? 'pad' : 'direct'));
  }

  protected toggleScroll(): void {
    this.settleTouch();
    this.scrolling.update((on) => !on);
    this.touch.scrolling = this.scrolling();
  }

  protected resetZoom(): void {
    this.view.reset();
    this.syncZoom();
  }

  protected onDown(event: PointerEvent): void {
    if (!this.access.touch() || !this.hasFrame()) return;
    event.preventDefault();
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    const at = this.pointOf(event);
    if (!at) return;
    const id = event.pointerId ?? 0;
    if (this.mode() === 'pad') {
      if (!this.pad.active) this.store.beginGesture();
      this.pad.down(id, at.x, at.y, event.timeStamp);
    } else {
      // O quadro na tela ainda não é o do monitor selecionado, ou o palco mudou e a transformação nova ainda não foi aplicada:
      // este toque não sai (o próximo, já sobre a imagem certa, sai).
      if (this.syncStage() || !this.touchReady()) return;
      this.touch.down(id, at.x, at.y, event.timeStamp);
    }
  }

  protected onMove(event: PointerEvent): void {
    const at = this.pointOf(event);
    if (!at) return;
    const id = event.pointerId ?? 0;
    if (this.mode() === 'pad') this.pad.move(id, at.x, at.y, event.timeStamp);
    else this.touch.move(id, at.x, at.y);
  }

  protected onUp(event: PointerEvent): void {
    const id = event.pointerId ?? 0;
    if (this.mode() === 'pad') {
      this.pad.up(id, event.timeStamp);
      if (!this.pad.active) this.store.endGesture();
    } else {
      this.touch.up(id, event.timeStamp);
    }
  }

  protected onCancel(): void {
    this.settleTouch();
  }

  /** O que estiver apertado é solto e o que esperava um segundo toque é descartado: o botão nunca fica preso. */
  private settleTouch(): void {
    const padDragging = this.pad.dragging;
    this.touch.cancel();
    this.pad.cancel();
    if (padDragging) void this.store.release();
  }

  /**
   * Leva o tamanho do palco ao modelo do zoom e aplica a transformação. Devolve se a transformação mudou: aí o que o dedo tocava
   * foi mapeado com a anterior, e o gesto em curso é encerrado (o botão é solto, o toque que esperava o segundo é esquecido).
   */
  private syncStage(): boolean {
    const stage = this.stage()?.nativeElement;
    if (!stage || stage.clientWidth <= 0 || stage.clientHeight <= 0) return false;
    const size = this.view.size;
    if (size.width === stage.clientWidth && size.height === stage.clientHeight) return false;
    const moved = this.view.resize(stage.clientWidth, stage.clientHeight);
    this.syncZoom();
    if (moved) this.settleTouch();
    return moved;
  }

  /** O ponto do dedo em pixels do quadro da imagem (sem a borda do quadro). */
  private pointOf(event: PointerEvent): TouchPoint | null {
    const stage = this.stage()?.nativeElement;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - stage.clientLeft,
      y: event.clientY - rect.top - stage.clientTop,
    };
  }

  /**
   * O alvo no quadro PINTADO, com a transformação aplicada a ele. Só com o quadro certo na tela (`touchReady`), exceto a soltura
   * (`release`): o `UP` sempre sai, para o botão nunca ficar preso (o PC solta sem mover se o arranjo mudou).
   */
  private targetAt(at: TouchPoint, release = false) {
    const painted = this.painted();
    if (!painted || (!release && !this.touchReady())) return null;
    return tapTarget(painted.monitor, painted.layout ?? 0, this.view.toImage(at), this.view.size);
  }

  private tapAt(
    button: 'LEFT' | 'RIGHT',
    action: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
    at: TouchPoint,
  ): void {
    const target = this.targetAt(at, action === 'UP');
    if (!target) return;
    if (!this.direct.accepts('pc.tap.v1')) {
      this.touchNotice.set(this.noChannelText());
      return;
    }
    this.direct.command('pc.tap.v1', { ...target, button, action }).then(
      () => this.touchNotice.set(null),
      (error: unknown) => this.touchNotice.set(this.refusal(error)),
    );
  }

  private dragTo(at: TouchPoint): void {
    const target = this.targetAt(at);
    if (!target) return;
    try {
      this.direct.sendAbsolute(target);
    } catch (error) {
      this.touchNotice.set(this.refusal(error));
    }
  }

  private pinchView(factor: number, center: TouchPoint, dx: number, dy: number): void {
    this.view.pinch(factor, center, dx, dy);
    this.syncZoom();
  }

  private syncZoom(): void {
    this.zoom.set({ scale: this.view.scale, panX: this.view.panX, panY: this.view.panY });
  }

  private refusal(error: unknown): string {
    if (error instanceof DirectNotSent) return this.noChannelText();
    const code = (error as { error?: { agentError?: unknown } } | null)?.error?.agentError;
    if (code === 'stale_layout') {
      return $localize`:@@pc.screen.stale:Os monitores do PC mudaram. Espere a imagem atualizar e toque de novo.`;
    }
    const failure = pcFailureOf(error);
    return failure.kind === 'elevated'
      ? $localize`:@@pc.screen.tap.elevated:Há uma janela de administrador nesse ponto: o Windows não deixa clicar nela daqui.`
      : $localize`:@@pc.screen.tap.failed:O toque não chegou ao PC.`;
  }

  private noChannelText(): string {
    return $localize`:@@pc.screen.tap.channel:O toque na tela precisa do canal direto com o PC, que não está ativo agora.`;
  }

  protected selectMonitor(id: number): void {
    const link = this.link;
    if (!link || id === this.monitorId() || !this.monitors().some((item) => item.id === id)) return;
    this.settleTouch();
    this.resetZoom();
    this.monitorId.set(id);
    link.loop.restart();
  }

  private viewRequest() {
    const monitor = this.current();
    return monitor
      ? { monitor: monitor.id, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, monitor.width)) }
      : null;
  }

  private listen(link: Link): void {
    const lost = () => {
      // Bloqueada, o PC avisa e fecha a sessão: é um aviso estável, não uma falha.
      if (this.link === link) this.finish(this.state() === 'locked' ? 'locked' : 'failed');
    };
    link.channel.addEventListener('close', lost);
    link.channel.addEventListener('error', lost);
    link.connection.addEventListener('connectionstatechange', () => {
      if (link.connection.connectionState === 'failed') lost();
    });
    link.channel.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
      if (this.link !== link) return;
      try {
        this.receive(link, data);
      } catch {
        lost();
      }
    });
    link.watchdog = setTimeout(lost, START_TIMEOUT_MS);
  }

  private receive(link: Link, data: unknown): void {
    if (typeof data !== 'string') {
      if (!(data instanceof ArrayBuffer) || link.painting) throw new Error('quadro inválido');
      const frame = link.assembler.push(data);
      if (frame) {
        link.painting = true;
        // O quadro responde ao único pedido em andamento: mostra o monitor e o arranjo daquele pedido.
        const view = link.requestedView ?? null;
        void this.paint(link, frame, view).catch(() => {
          if (this.link === link) this.finish('failed');
        });
      }
      return;
    }
    const message = parseViewerMessage(data);
    switch (message.k) {
      case 's.mon': {
        // O PC manda a lista de monitores assim que a sessão autoriza, sem esperar pedido: é o sinal de que está pronto.
        const before = this.current();
        const beforeLayout = this.layout();
        const chosen =
          message.monitors.find((item) => item.id === this.monitorId()) ??
          message.monitors.find((item) => item.primary) ??
          message.monitors[0];
        this.monitors.set(message.monitors);
        this.monitorId.set(chosen.id);
        this.layout.set(message.layout);
        if (!link.loop.active) {
          clearTimeout(link.watchdog);
          this.phase.set('live');
          link.loop.start();
        } else {
          // Se o monitor do pedido em andamento (não o selecionado) sumiu, o PC o descartou sem responder: ele é dado
          // como perdido.
          const gone =
            link.requested !== undefined &&
            !message.monitors.some((item) => item.id === link.requested);
          // Outra impressão é outro arranjo, mesmo com o monitor de mesmo número e tamanho (dois iguais, o primeiro desligado).
          if (
            gone ||
            beforeLayout !== message.layout ||
            before === null ||
            before.id !== chosen.id ||
            before.width !== chosen.width ||
            before.height !== chosen.height
          ) {
            // Um toque que esperava o segundo e o zoom eram do quadro antigo: um clique atrasado cairia no lugar errado.
            this.settleTouch();
            this.resetZoom();
            // O pedido em andamento termina antes; o próximo já leva o monitor e o tamanho novos.
            link.loop.restart(gone);
          }
        }
        break;
      }
      case 's.same':
        if (this.state() === 'locked') this.state.set('ok');
        link.loop.answered();
        break;
      case 's.cur':
        this.cursor.set(message.cursor);
        break;
      case 's.state':
        // O estado chega sem ser pedido (a cada mudança) e não responde a nenhum `s.get`: não mexe no laço. Bloqueada,
        // o PC fecha a sessão logo depois e `lost` mostra o aviso como fase própria, não como falha.
        this.state.set(message.state);
        break;
    }
  }

  /** Fim normal da sessão de tela (90 s): fecha esta e abre outra, em vez de esperar o PC encerrar. */
  private renew(link: Link): void {
    if (this.link !== link) return;
    this.finish('connecting');
    if (this.canOpen()) void this.open();
    else this.phase.set('failed');
  }

  private async paint(link: Link, frame: ScreenViewerFrame, view: FrameView | null): Promise<void> {
    const bitmap = await createImageBitmap(new Blob(frame.chunks, { type: 'image/jpeg' }));
    try {
      const canvas = this.surface()?.nativeElement;
      if (this.link !== link || !canvas) return;
      // O JPEG tem de ter o tamanho que o cabeçalho declarou (e já validou): outro tamanho é recusado.
      if (bitmap.width !== frame.width || bitmap.height !== frame.height) {
        throw new Error('imagem diverge do cabeçalho');
      }
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas indisponível');
      context.drawImage(bitmap, 0, 0);
      this.painted.set(view);
      this.hasFrame.set(true);
    } finally {
      bitmap.close();
    }
    if (this.link !== link) return;
    link.painting = false;
    if (this.state() === 'locked') this.state.set('ok');
    link.loop.answered();
  }

  private finish(next: Phase): void {
    const link = this.link;
    if (!link) {
      if (next === 'idle' && this.phase() !== 'failed') this.phase.set('idle');
      return;
    }
    this.link = null;
    this.settleTouch();
    this.resetZoom();
    this.touchNotice.set(null);
    clearTimeout(link.watchdog);
    clearTimeout(link.renew);
    link.loop.stop();
    link.channel.close();
    link.connection.close();
    if (link.sessionId !== null) {
      void this.signaling.close(link.sessionId, true).catch(() => undefined);
    }
    const canvas = this.surface()?.nativeElement;
    if (canvas && this.hasFrame()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.hasFrame.set(false);
    this.cursor.set(null);
    this.monitors.set([]);
    this.monitorId.set(null);
    this.layout.set(null);
    this.painted.set(null);
    this.phase.set(next);
  }
}
