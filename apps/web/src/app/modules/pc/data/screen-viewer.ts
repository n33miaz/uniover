/** Um monitor do PC, em pixels físicos, como o PC o anuncia em `s.mon`. */
export interface ScreenMonitor {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly primary: boolean;
}

export type ScreenViewState = 'ok' | 'locked' | 'elevated';

/** A posição do cursor no monitor `m`, em pixels do monitor. */
export interface ScreenCursor {
  readonly m: number;
  readonly x: number;
  readonly y: number;
}

export type ScreenViewerMessage =
  | { readonly k: 'ready' }
  | { readonly k: 's.mon'; readonly monitors: readonly ScreenMonitor[] }
  | { readonly k: 's.same'; readonly i: number }
  | { readonly k: 's.cur'; readonly cursor: ScreenCursor }
  | { readonly k: 's.state'; readonly state: ScreenViewState };

const MAX_MONITORS = 16;
const MAX_COORD = 100_000;

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseMonitor(value: unknown): ScreenMonitor {
  const m = value as Record<string, unknown> | null;
  if (
    !m ||
    !whole(m['id'], 0, 0xffff) ||
    !whole(m['x'], -MAX_COORD, MAX_COORD) ||
    !whole(m['y'], -MAX_COORD, MAX_COORD) ||
    !whole(m['w'], 1, MAX_COORD) ||
    !whole(m['h'], 1, MAX_COORD)
  ) {
    throw new Error('monitor inválido');
  }
  return {
    id: m['id'],
    x: m['x'],
    y: m['y'],
    w: m['w'],
    h: m['h'],
    primary: m['primary'] === true,
  };
}

/** Lê uma mensagem de texto do canal `screen`. Lança se ela não segue o protocolo. */
export function parseViewerMessage(text: string): ScreenViewerMessage {
  const data = JSON.parse(text) as Record<string, unknown> | null;
  switch (data?.['k']) {
    case 'ready':
      return { k: 'ready' };
    case 's.mon': {
      const list = data['monitors'];
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MONITORS) {
        throw new Error('lista de monitores inválida');
      }
      return { k: 's.mon', monitors: list.map(parseMonitor) };
    }
    case 's.same':
      if (!whole(data['i'], 0, 0xffff)) throw new Error('quadro igual inválido');
      return { k: 's.same', i: data['i'] };
    case 's.cur': {
      const { m, x, y } = data;
      if (
        !whole(m, 0, 0xffff) ||
        !whole(x, -MAX_COORD, MAX_COORD) ||
        !whole(y, -MAX_COORD, MAX_COORD)
      ) {
        throw new Error('cursor inválido');
      }
      return { k: 's.cur', cursor: { m, x, y } };
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

/** Um quadro completo: o número do pedido, o tamanho da imagem e os pedaços do JPEG. */
export interface ScreenViewerFrame {
  readonly i: number;
  readonly width: number;
  readonly height: number;
  readonly chunks: ArrayBuffer[];
}

const HEADER_BYTES = 16;
const MAGIC = 0x554f5346; // "UOSF"
const MAX_JPEG_BYTES = 8 * 1024 ** 2;
const MAX_SIDE = 16_384;

/**
 * Monta o quadro binário: 16 bytes de cabeçalho (marca, versão, reservado, largura, altura, número do pedido, tamanho do
 * JPEG) seguidos do JPEG, partido em mensagens de até 16 KiB. O cabeçalho vem sempre no começo da primeira mensagem.
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
        view.getUint8(4) !== 1 ||
        bytes < 1 ||
        bytes > MAX_JPEG_BYTES ||
        width < 1 ||
        height < 1 ||
        width > MAX_SIDE ||
        height > MAX_SIDE
      ) {
        throw new Error('cabeçalho de quadro inválido');
      }
      this.frame = { i: view.getUint16(10), width, height, chunks: [], bytes, received: 0 };
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
    return { i: frame.i, width: frame.width, height: frame.height, chunks: frame.chunks };
  }
}

/** O que o quadro pedido deve mostrar: o monitor inteiro, no tamanho que cabe na tela do aparelho. */
export interface ScreenViewRequest {
  readonly m: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly maxW: number;
  readonly maxH: number;
  readonly q: number;
}

export interface ScreenFrameLoopOptions {
  /** Manda o texto ao canal. */
  readonly send: (text: string) => void;
  /** O recorte de agora, ou `null` enquanto o PC não disse quais são os monitores. */
  readonly view: () => ScreenViewRequest | null;
  /** O PC não respondeu a tempo: quem chama encerra a sessão. */
  readonly onTimeout: () => void;
  /** Quadros por segundo no máximo (5 a 8). */
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
 */
export class ScreenFrameLoop {
  private readonly fps: number;
  private readonly timeoutMs: number;
  private readonly slowMs: number;
  private pending: number | null = null;
  private sequence = 0;
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
    this.running = true;
    this.request();
  }

  stop(): void {
    this.running = false;
    this.pending = null;
    clearTimeout(this.wait);
    clearTimeout(this.watchdog);
  }

  /** Pede já um quadro novo (trocou o monitor ou chegou a lista de monitores); descarta o pedido em andamento. */
  restart(): void {
    if (!this.running) return;
    this.pending = null;
    clearTimeout(this.wait);
    this.request();
  }

  /**
   * O PC respondeu ao pedido `i` (quadro desenhado ou `s.same`). Ignora respostas de pedidos antigos. Com `i` nulo, vale
   * para o pedido em andamento (a tela bloqueada responde com o estado, sem número). `slow` espaça o próximo pedido.
   */
  answered(i: number | null, slow = false): boolean {
    if (!this.running || this.pending === null || (i !== null && i !== this.pending)) return false;
    this.pending = null;
    clearTimeout(this.watchdog);
    const gap = slow ? this.slowMs : 1000 / this.fps;
    const delay = Math.max(0, this.lastAt + gap - performance.now());
    clearTimeout(this.wait);
    this.wait = setTimeout(() => this.request(), delay);
    return true;
  }

  private request(): void {
    if (!this.running || this.pending !== null) return;
    const view = this.options.view();
    if (view === null) return;
    this.sequence = (this.sequence + 1) & 0xffff;
    this.pending = this.sequence;
    this.lastAt = performance.now();
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.options.onTimeout(), this.timeoutMs);
    try {
      this.options.send(JSON.stringify({ k: 's.get', i: this.sequence, ...view }));
    } catch {
      this.options.onTimeout();
    }
  }
}
