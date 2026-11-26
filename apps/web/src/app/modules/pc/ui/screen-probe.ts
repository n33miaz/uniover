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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  DirectChannel,
  DirectSignaling,
  PC_RTC_FACTORY,
  STALL_MS,
  gatherDirectIce,
} from '../../../core/direct/direct-channel';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { ScreenMetrics, readScreenMarker } from '../data/screen-metrics';
import {
  ScreenViewerFrameAssembler,
  parseViewerMessage,
  type ScreenFrameStats,
  type ScreenViewerFrame,
} from '../data/screen-viewer';

const MEASUREMENT_MS = 60_000;
const FRAME_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;
const SCREEN_CAPABILITY = 'pc.screen.v1';

type Result = ReturnType<ScreenMetrics['result']>;

interface Run {
  readonly connection: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  readonly assembler: ScreenViewerFrameAssembler;
  readonly parentSessionId: string;
  readonly width: number;
  readonly fps: number;
  sessionId: string | null;
  stats: ScreenMetrics | null;
  frameStats: ScreenFrameStats | null;
  startedAt: number;
  watchdog?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  painting: boolean;
}

const STOPPED = $localize`:@@pc.screenProbe.stopped:Medição interrompida.`;
const FAILED = $localize`:@@pc.screenProbe.failed:Não foi possível medir a tela.`;
const WAITING = $localize`:@@pc.screenProbe.waiting:Conectando à tela do PC…`;
const LOCKED = $localize`:@@pc.screenProbe.locked:Desbloqueie o PC para medir a tela.`;
const DONE = $localize`:@@pc.screenProbe.done:Medição concluída.`;
const DIRECT_LOST = $localize`:@@pc.screenProbe.directLost:O canal direto do ponteiro foi encerrado.`;

@Component({
  selector: 'app-pc-screen-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './screen-probe.css',
  template: `
    @if (!supported()) {
      <p i18n="@@pc.screenProbe.unavailable">A medição de tela não está disponível neste PC.</p>
    } @else {
      <div class="controls">
        <label>
          <span i18n="@@pc.screenProbe.width">Largura (px)</span>
          <select #width [disabled]="running()">
            <option value="960">960</option>
            <option value="1280" selected>1280</option>
            <option value="1920">1920</option>
          </select>
        </label>
        <label>
          <span i18n="@@pc.screenProbe.fps">Quadros/s</span>
          <select #fps [disabled]="running()">
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="8" selected>8</option>
            <option value="10">10</option>
          </select>
        </label>
        @if (running()) {
          <button type="button" (click)="cancel()" i18n="@@pc.screenProbe.stop">Parar</button>
        } @else {
          <button
            type="button"
            (click)="start(+width.value, +fps.value)"
            [disabled]="!canStart()"
            i18n="@@pc.screenProbe.start"
          >
            Medir
          </button>
        }
      </div>
      @if (!canStart() && !running() && !result()) {
        <p i18n="@@pc.screenProbe.waitForDirect">Aguardando o canal direto do PC na rede local.</p>
      }
    }
    <canvas
      #surface
      width="1"
      height="1"
      [hidden]="!hasFrame()"
      aria-label="Tela do PC durante a medição"
      i18n-aria-label="@@pc.screenProbe.preview"
    ></canvas>
    <p role="status" [hidden]="!status()">{{ status() }}</p>
    @if (running() && current(); as sample) {
      <p i18n="@@pc.screenProbe.progress">
        {{ elapsed() }}/60 s · {{ sample.frames }} quadros. Use o touchpad para medir do toque até a
        exibição do quadro marcado.
      </p>
    }
    @if (result()) {
      <p i18n="@@pc.screenProbe.touchHelp">
        O marcador identifica o quadro pedido pelo toque. A resposta visual do PC ao comando precisa
        de uma medição própria.
      </p>
      <button type="button" (click)="copy()" i18n="@@pc.screenProbe.copy">Copiar resultados</button>
      @if (showTable()) {
        <textarea
          readonly
          [value]="table()"
          aria-label="Tabela de resultados"
          i18n-aria-label="@@pc.screenProbe.table"
        ></textarea>
      }
    }
  `,
})
export class PcScreenProbe {
  private readonly direct = inject(DirectChannel);
  private readonly signaling = inject(DirectSignaling);
  private readonly doc = inject(DOCUMENT);
  private readonly factory = inject(PC_RTC_FACTORY);
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);
  private readonly surface = viewChild<ElementRef<HTMLCanvasElement>>('surface');
  private run: Run | null = null;

  protected readonly supported = computed(
    () => this.factory !== null && this.availability.capabilities().includes(SCREEN_CAPABILITY),
  );
  protected readonly canStart = computed(
    () =>
      this.supported() &&
      this.session.isAuthenticated() &&
      this.session.role() === 'owner' &&
      this.direct.pcSessionId() !== null,
  );
  protected readonly running = signal(false);
  protected readonly hasFrame = signal(false);
  protected readonly status = signal('');
  protected readonly current = signal<Result | null>(null);
  protected readonly elapsed = computed(() => Math.floor(this.current()?.seconds ?? 0));
  protected readonly result = signal<(Result & { fpsTarget: number; widthTarget: number }) | null>(
    null,
  );
  protected readonly showTable = signal(false);

  constructor() {
    this.direct.pointerRtt.pipe(takeUntilDestroyed()).subscribe(({ sessionId, milliseconds }) => {
      if (this.run?.parentSessionId === sessionId)
        this.run.stats?.pointerRtt(milliseconds, performance.now());
    });
    effect(() => {
      const parentSessionId = this.direct.pcSessionId();
      const granted = this.canStart();
      if (this.run && (!granted || parentSessionId !== this.run.parentSessionId)) {
        this.finish(DIRECT_LOST);
      }
    });
    const hide = () => this.finish(STOPPED);
    const visibility = () => {
      if (this.doc.visibilityState === 'hidden') hide();
    };
    this.doc.addEventListener('visibilitychange', visibility);
    this.doc.defaultView?.addEventListener('pagehide', hide);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', visibility);
      this.doc.defaultView?.removeEventListener('pagehide', hide);
      hide();
    });
  }

  markTouch(releasedAt: number): void {
    const run = this.run;
    if (!run?.stats) return;
    const now = performance.now();
    // O evento costuma usar o mesmo relógio dos quadros, mas pode chegar com a origem Unix.
    const at = releasedAt > now ? releasedAt - performance.timeOrigin : releasedAt;
    if (at >= run.startedAt && at <= now) run.stats.touch(at);
  }

  protected async start(width: number, fps: number): Promise<void> {
    const parentSessionId = this.direct.pcSessionId();
    if (this.run || !this.factory || !this.canStart() || !parentSessionId) return;
    this.result.set(null);
    this.current.set(null);
    this.showTable.set(false);
    this.status.set(WAITING);
    let run: Run | null = null;
    let connection: RTCPeerConnection | null = null;
    try {
      connection = this.factory();
      const channel = connection.createDataChannel('screen', { ordered: true });
      run = {
        connection,
        channel,
        assembler: new ScreenViewerFrameAssembler(),
        parentSessionId,
        width,
        fps,
        sessionId: null,
        stats: null,
        frameStats: null,
        startedAt: 0,
        painting: false,
      };
      this.run = run;
      this.running.set(true);
      this.listen(run);
      await connection.setLocalDescription(await connection.createOffer());
      await gatherDirectIce(connection);
      if (this.run !== run) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error('oferta ausente');
      const answer = await this.signaling.offer(sdp, {
        scopes: ['screen'],
        tvId: null,
        parentSessionId,
      });
      if (this.run !== run) {
        this.close(answer.sessionId);
        return;
      }
      run.sessionId = answer.sessionId;
      if (!answer.scopes.includes('screen')) throw new Error('escopo de tela ausente');
      const active = run;
      channel.addEventListener(
        'open',
        () => {
          if (this.run !== active) return;
          try {
            channel.send(JSON.stringify({ k: 'auth', token: answer.token }));
          } catch {
            this.finish(FAILED);
          }
        },
        { once: true },
      );
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch {
      if (run && this.run === run) this.finish(FAILED);
      else if (!run) {
        connection?.close();
        this.status.set(FAILED);
      }
    }
  }

  protected cancel(): void {
    this.finish(STOPPED);
  }

  private listen(run: Run): void {
    const lost = () => {
      if (this.run === run) this.finish(FAILED);
    };
    run.channel.binaryType = 'arraybuffer';
    run.channel.addEventListener('close', lost);
    run.channel.addEventListener('error', lost);
    run.connection.addEventListener('connectionstatechange', () => {
      if (run.connection.connectionState === 'failed') lost();
    });
    run.channel.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
      if (this.run !== run) return;
      try {
        this.receive(run, data);
      } catch {
        lost();
      }
    });
    run.watchdog = setTimeout(lost, START_TIMEOUT_MS);
  }

  private receive(run: Run, data: unknown): void {
    if (typeof data === 'string') {
      const message = parseViewerMessage(data);
      if (message.k === 's.state' && message.state === 'locked') {
        this.finish(LOCKED);
      } else if (message.k === 's.mon' && run.stats === null) {
        run.startedAt = performance.now();
        run.stats = new ScreenMetrics(run.startedAt, STALL_MS);
        this.current.set(run.stats.result(run.startedAt));
        this.status.set('');
        run.deadline = setTimeout(() => this.finish(DONE, true), MEASUREMENT_MS);
        this.request(run, true);
      } else if (message.k === 's.stat') {
        if (!run.stats || run.painting || run.frameStats) {
          throw new Error('medição de quadro fora de ordem');
        }
        run.frameStats = message;
      }
      return;
    }
    const stats = run.frameStats;
    if (!(data instanceof ArrayBuffer) || run.painting || !stats) {
      throw new Error('quadro inválido');
    }
    const frame = run.assembler.push(data, run.width);
    if (frame) {
      if (stats.bytes !== frame.wireBytes) throw new Error('tamanho do quadro diverge da medição');
      run.frameStats = null;
      run.painting = true;
      void this.paint(run, frame, stats).catch(() => {
        if (this.run === run) this.finish(FAILED);
      });
    }
  }

  private request(run: Run, reset = false): void {
    if (!run.stats) return;
    clearTimeout(run.watchdog);
    run.watchdog = setTimeout(() => this.finish(FAILED), FRAME_TIMEOUT_MS);
    run.channel.send(
      JSON.stringify({
        k: 's.get',
        width: run.width,
        fps: run.fps,
        marker: run.stats.request(),
        ...(reset ? { reset: true } : {}),
      }),
    );
  }

  private async paint(run: Run, frame: ScreenViewerFrame, stats: ScreenFrameStats): Promise<void> {
    const bitmap = await createImageBitmap(new Blob(frame.chunks, { type: 'image/jpeg' }));
    const canvas = this.surface()?.nativeElement;
    let marker: number;
    try {
      if (this.run !== run || !canvas) return;
      if (bitmap.width !== frame.width || bitmap.height !== frame.height) {
        throw new Error('imagem diverge do cabeçalho');
      }
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || canvas.width < 128 || canvas.height < 8) throw new Error('quadro inválido');
      context.drawImage(bitmap, 0, 0);
      const red = context.getImageData(0, 4, 128, 1).data;
      marker = readScreenMarker((x) => red[x * 4]);
      this.hasFrame.set(true);
    } finally {
      bitmap.close();
    }
    // Dois callbacks dão ao navegador uma oportunidade de pintar entre o desenho e a medição.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (this.run !== run || !run.stats) return;
    const at = performance.now();
    if (at - run.startedAt >= MEASUREMENT_MS) {
      this.finish(DONE, true);
      return;
    }
    run.stats.frame(stats, frame.width, marker, at);
    this.current.set(run.stats.result(at));
    run.painting = false;
    this.request(run);
  }

  private close(sessionId: string): void {
    void this.signaling.close(sessionId, true).catch(() => undefined);
  }

  private finish(message: string, completed = false): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    clearTimeout(run.deadline);
    clearTimeout(run.watchdog);
    run.channel.close();
    run.connection.close();
    if (run.sessionId !== null) this.close(run.sessionId);
    const canvas = this.surface()?.nativeElement;
    if (canvas && this.hasFrame()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.hasFrame.set(false);
    const now = Math.min(performance.now(), run.startedAt + MEASUREMENT_MS);
    if (run.stats) {
      this.result.set({
        ...run.stats.result(now, completed),
        fpsTarget: run.fps,
        widthTarget: run.width,
      });
    }
    this.running.set(false);
    this.status.set(message);
  }

  protected table(): string {
    const result = this.result();
    if (!result) return '';
    const format = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
    const display = (n: number | null) => (n === null ? '—' : format.format(n));
    const yes = $localize`:@@pc.screenProbe.yes:Sim`;
    const no = $localize`:@@pc.screenProbe.no:Não`;
    return [
      $localize`:@@pc.screenProbe.tableHeading:| Métrica | Resultado | Critério |`,
      '| --- | --- | --- |',
      $localize`:@@pc.screenProbe.rowDuration:| Duração | ${display(result.seconds)}:DURATION: s | 60 s |`,
      $localize`:@@pc.screenProbe.rowWidth:| Largura (recebida / pedida) | ${display(result.width)}:RECEIVED: / ${display(result.widthTarget)}:TARGET: px | 1280 px |`,
      $localize`:@@pc.screenProbe.rowFps:| Quadros/s (medido / pedido) | ${display(result.fps)}:MEASURED: / ${display(result.fpsTarget)}:TARGET: | ≥ 5 em 1280 px |`,
      $localize`:@@pc.screenProbe.rowTouchMedian:| Toque até o quadro marcado, p50 | ${display(result.touchP50)}:MEASURED: ms (n=${display(result.touchCount)}:COUNT:) | ≤ 250 ms |`,
      $localize`:@@pc.screenProbe.rowTouchP95:| Toque até o quadro marcado, p95 | ${display(result.touchP95)}:MEASURED: ms (n=${display(result.touchCount)}:COUNT:) | — |`,
      $localize`:@@pc.screenProbe.rowPointer:| RTT do ponteiro, p95 | ${display(result.pointerP95)}:MEASURED: ms (n=${display(result.pointerCount)}:COUNT:) | ≤ 30 ms |`,
      $localize`:@@pc.screenProbe.rowPointerGap:| Maior intervalo sem resposta do ponteiro | ${display(result.pointerGap)}:GAP: ms | ≤ ${display(STALL_MS)}:LIMIT: ms |`,
      $localize`:@@pc.screenProbe.rowThroughput:| Vazão dos JPEGs via SCTP | ${display(result.mbps)}:MEASURED: Mbit/s | — |`,
      $localize`:@@pc.screenProbe.rowCpu:| CPU média do processo de tela | ${display(result.cpu)}:MEASURED:% de um núcleo | ≤ 25% |`,
      $localize`:@@pc.screenProbe.rowMemory:| Pico de memória privada do processo de tela | ${display(result.privateMB)}:MEASURED: MB | ≤ 80 MB |`,
      $localize`:@@pc.screenProbe.rowConcurrent:| JPEG binário e ponteiro ativos por 60 s | ${result.concurrent ? yes : no}:MEASURED: | ${yes}:YES: |`,
      $localize`:@@pc.screenProbe.rowLegibility:| Texto legível sem zoom | Preencher no iPhone | Sim |`,
    ].join('\n');
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.table());
      this.status.set($localize`:@@pc.screenProbe.copied:Resultados copiados.`);
    } catch {
      this.showTable.set(true);
      this.status.set(
        $localize`:@@pc.screenProbe.copyManual:Selecione a tabela para copiar os resultados.`,
      );
    }
  }
}
