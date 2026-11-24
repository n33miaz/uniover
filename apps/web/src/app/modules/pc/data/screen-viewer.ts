/** Um monitor do PC, em pixels físicos, como ele o anuncia em `s.mon`. O `id` é estável durante a sessão. */
export interface ScreenMonitor {
  readonly id: number;
  readonly primary: boolean;
  readonly width: number;
  readonly height: number;
}

export type ScreenViewState = 'ok' | 'locked' | 'elevated';

/** A posição do cursor, em pixels do monitor. */
export interface ScreenCursor {
  readonly x: number;
  readonly y: number;
}

export type ScreenViewerMessage =
  | { readonly k: 's.mon'; readonly monitors: readonly ScreenMonitor[] }
  | { readonly k: 's.same'; readonly crc: number }
  | { readonly k: 's.cur'; readonly cursor: ScreenCursor }
  | { readonly k: 's.state'; readonly state: ScreenViewState };

const MAX_COORD = 100_000;
const MAX_MONITORS = 16;
const MAX_MONITOR_ID = 0x7fff_ffff;

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Lê uma mensagem de texto do canal `screen`. Lança se ela não segue o protocolo. */
export function parseViewerMessage(text: string): ScreenViewerMessage {
  const data = JSON.parse(text) as Record<string, unknown> | null;
  switch (data?.['k']) {
    case 's.mon': {
      const list = data['monitors'];
      if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MONITORS) {
        throw new Error('monitores inválidos');
      }
      const monitors: ScreenMonitor[] = [];
      for (const item of list as unknown[]) {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<
          string,
          unknown
        >;
        const { id, width, height, primary } = entry;
        if (
          !whole(id, -MAX_MONITOR_ID, MAX_MONITOR_ID) ||
          !whole(width, 1, MAX_COORD) ||
          !whole(height, 1, MAX_COORD) ||
          typeof primary !== 'boolean' ||
          monitors.some((known) => known.id === id)
        ) {
          throw new Error('monitor inválido');
        }
        monitors.push({ id, primary, width, height });
      }
      return { k: 's.mon', monitors };
    }
    case 's.same':
      if (!whole(data['crc'], 0, 0xffff_ffff)) throw new Error('quadro igual inválido');
      return { k: 's.same', crc: data['crc'] };
    case 's.cur': {
      const { x, y } = data;
      if (!whole(x, -MAX_COORD, MAX_COORD) || !whole(y, -MAX_COORD, MAX_COORD)) {
        throw new Error('cursor inválido');
      }
      return { k: 's.cur', cursor: { x, y } };
    }
    case 's.state':
      if (data['state'] !== 'ok' && data['state'] !== 'locked' && data['state'] !== 'elevated') {
        throw new Error('estado de tela inválido');
      }
      return { k: 's.state', state: data['state'] };
    default:
      throw new Error('mensagem de tela desconhecida');
  }
}

/** Um quadro completo: a sequência do PC, o tamanho da imagem e os pedaços do JPEG. */
export interface ScreenViewerFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly chunks: ArrayBuffer[];
}

const HEADER_BYTES = 16;
const MAGIC = 0x554f5346; // "UOSF"
const VERSION = 1;
const MAX_JPEG_BYTES = 8 * 1024 ** 2;
const MAX_SIDE = 16_384;

/**
 * Monta o quadro binário: 16 bytes de cabeçalho (marca `UOSF`, versão, reservado, largura, altura, sequência, tamanho
 * do JPEG; tudo em big-endian) seguidos do JPEG, partido em mensagens de até 16 KiB. O cabeçalho vem sempre no começo da
 * primeira mensagem; um JPEG puro, sem ele, é recusado.
 */
export class ScreenViewerFrameAssembler {
  private frame: (ScreenViewerFrame & { bytes: number; received: number }) | null = null;

  /** Devolve o quadro quando o último pedaço chega; lança se os bytes não seguem o protocolo. */
  push(data: ArrayBuffer): ScreenViewerFrame | null {
    let body = data;
    if (this.frame === null) {
      if (data.byteLength <= HEADER_BYTES) throw new Error('quadro sem imagem');
      const view = new DataView(data);
      const bytes = view.getUint32(12);
      const width = view.getUint16(6);
      const height = view.getUint16(8);
      if (
        view.getUint32(0) !== MAGIC ||
        view.getUint8(4) !== VERSION ||
        bytes < 1 ||
        bytes > MAX_JPEG_BYTES ||
        width < 1 ||
        height < 1 ||
        width > MAX_SIDE ||
        height > MAX_SIDE
      ) {
        throw new Error('cabeçalho de quadro inválido');
      }
      this.frame = { sequence: view.getUint16(10), width, height, chunks: [], bytes, received: 0 };
      body = data.slice(HEADER_BYTES);
    }
    const frame = this.frame;
    if (frame.received + body.byteLength > frame.bytes) {
      this.frame = null;
      throw new Error('pedaço de quadro inválido');
    }
    frame.chunks.push(body);
    frame.received += body.byteLength;
    if (frame.received < frame.bytes) return null;
    this.frame = null;
    return {
      sequence: frame.sequence,
      width: frame.width,
      height: frame.height,
      chunks: frame.chunks,
    };
  }
}

/** O que o quadro pedido deve mostrar: o monitor e a largura máxima da imagem, que o PC reduz do monitor inteiro. */
export interface ScreenViewRequest {
  readonly monitor: number;
  readonly width: number;
}

export interface ScreenFrameLoopOptions {
  /** Manda o texto ao canal. */
  readonly send: (text: string) => void;
  /** O pedido de agora, ou `null` enquanto o PC não disse o tamanho do monitor. */
  readonly view: () => ScreenViewRequest | null;
  /** O PC não respondeu a tempo: quem chama encerra a sessão. */
  readonly onTimeout: () => void;
  /** Quadros por segundo no máximo (1 a 10). */
  readonly fps?: number;
  readonly timeoutMs?: number;
  /** Espera entre pedidos enquanto a tela está bloqueada. */
  readonly slowMs?: number;
}

export const SCREEN_FPS = 6;
const SCREEN_TIMEOUT_MS = 10_000;
const SCREEN_SLOW_MS = 1_000;

/**
 * O laço da foto ao vivo: um `s.get` por vez. O próximo só sai depois que o anterior foi respondido (e desenhado),
 * respeitando o intervalo mínimo entre pedidos, então nada se acumula no PC nem na rede. Parado (`stop`), não pede nada.
 * O PC não numera as respostas: a que chega (quadro ou `s.same`) responde ao único pedido em andamento.
 */
export class ScreenFrameLoop {
  private readonly fps: number;
  private readonly timeoutMs: number;
  private readonly slowMs: number;
  private pending = false;
  private refresh = false;
  private reset = true;
  private lastAt = Number.NEGATIVE_INFINITY;
  private running = false;
  private wait: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ScreenFrameLoopOptions) {
    this.fps = options.fps ?? SCREEN_FPS;
    this.timeoutMs = options.timeoutMs ?? SCREEN_TIMEOUT_MS;
    this.slowMs = options.slowMs ?? SCREEN_SLOW_MS;
  }

  get active(): boolean {
    return this.running;
  }

  /** Liga o laço e pede o primeiro quadro; com ele já ligado, só pede se nada estiver em andamento. */
  start(): void {
    if (!this.running) this.reset = true;
    this.running = true;
    this.request();
  }

  stop(): void {
    this.running = false;
    this.pending = false;
    this.refresh = false;
    clearTimeout(this.wait);
    clearTimeout(this.watchdog);
  }

  /**
   * O recorte mudou (outro monitor ou outro tamanho): o próximo pedido leva o recorte novo e recomeça o quadro
   * (`reset`). O pedido em andamento continua até a resposta chegar, para o PC nunca ter dois ao mesmo tempo; sem nenhum
   * em andamento, pede já.
   */
  restart(): void {
    if (!this.running) return;
    this.reset = true;
    if (this.pending) {
      this.refresh = true;
      return;
    }
    clearTimeout(this.wait);
    this.request();
  }

  /**
   * O PC respondeu ao pedido em andamento (quadro desenhado ou `s.same`). `slow` espaça o próximo pedido (a tela
   * bloqueada responde só com o estado).
   */
  answered(slow = false): boolean {
    if (!this.running || !this.pending) return false;
    this.pending = false;
    clearTimeout(this.watchdog);
    const gap = this.refresh ? 0 : slow ? this.slowMs : 1000 / this.fps;
    this.refresh = false;
    const delay = Math.max(0, this.lastAt + gap - performance.now());
    clearTimeout(this.wait);
    this.wait = setTimeout(() => this.request(), delay);
    return true;
  }

  private request(): void {
    if (!this.running || this.pending) return;
    const view = this.options.view();
    if (view === null) return;
    const reset = this.reset;
    this.reset = false;
    this.pending = true;
    this.lastAt = performance.now();
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.options.onTimeout(), this.timeoutMs);
    try {
      this.options.send(
        JSON.stringify({
          k: 's.get',
          monitor: view.monitor,
          width: view.width,
          fps: this.fps,
          marker: 0,
          reset,
        }),
      );
    } catch {
      this.options.onTimeout();
    }
  }
}
