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
  DirectSignaling,
  PC_RTC_FACTORY,
  gatherDirectIce,
} from '../../../core/direct/direct-channel';
import { PcScreenAccess } from '../data/screen-access';
import {
  ScreenFrameLoop,
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenCursor,
  type ScreenMonitor,
  type ScreenViewState,
  type ScreenViewerFrame,
} from '../data/screen-viewer';

const START_TIMEOUT_MS = 20_000;
/** A API encerra a sessão de tela em 90 s; a página reabre sozinha um pouco antes, sem o usuário perceber mais que um piscar. */
const RENEW_MS = 75_000;
/** A imagem não precisa passar da largura que o aparelho consegue mostrar (e 1280 basta para ler texto). */
const MAX_WIDTH = 1280;
/** O menor que o PC aceita. */
const MIN_WIDTH = 128;

type Phase = 'idle' | 'connecting' | 'live' | 'paused' | 'locked' | 'failed';

interface Link {
  readonly connection: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  readonly assembler: ScreenViewerFrameAssembler;
  readonly loop: ScreenFrameLoop;
  readonly parentSessionId: string;
  sessionId: string | null;
  painting: boolean;
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
      <div class="stage" [hidden]="!hasFrame()">
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
      @if (notice(); as text) {
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
  private readonly surface = viewChild<ElementRef<HTMLCanvasElement>>('surface');
  private link: Link | null = null;

  protected readonly phase = signal<Phase>('idle');
  protected readonly monitors = signal<readonly ScreenMonitor[]>([]);
  protected readonly monitorId = signal<number | null>(null);
  protected readonly cursor = signal<ScreenCursor | null>(null);
  protected readonly state = signal<ScreenViewState>('ok');
  protected readonly hasFrame = signal(false);

  protected readonly canOpen = computed(
    () => this.access.allowed() && this.factory !== null && this.direct.pcSessionId() !== null,
  );
  protected readonly current = computed(
    () => this.monitors().find((item) => item.id === this.monitorId()) ?? null,
  );
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
          view: () => this.viewRequest(),
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

  protected selectMonitor(id: number): void {
    const link = this.link;
    if (!link || id === this.monitorId() || !this.monitors().some((item) => item.id === id)) return;
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
        void this.paint(link, frame).catch(() => {
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
        const chosen =
          message.monitors.find((item) => item.id === this.monitorId()) ??
          message.monitors.find((item) => item.primary) ??
          message.monitors[0];
        this.monitors.set(message.monitors);
        this.monitorId.set(chosen.id);
        if (!link.loop.active) {
          clearTimeout(link.watchdog);
          this.phase.set('live');
          link.renew = setTimeout(() => this.renew(link), RENEW_MS);
          link.loop.start();
        } else if (
          before === null ||
          before.id !== chosen.id ||
          before.width !== chosen.width ||
          before.height !== chosen.height
        ) {
          // O pedido em andamento termina antes; o próximo já leva o monitor e o tamanho novos. Se o monitor pedido
          // sumiu, o PC descartou o pedido sem responder: ele é dado como perdido.
          const gone = before !== null && !message.monitors.some((item) => item.id === before.id);
          link.loop.restart(gone);
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

  private async paint(link: Link, frame: ScreenViewerFrame): Promise<void> {
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
    this.phase.set(next);
  }
}
