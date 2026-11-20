/** Metadados da imagem enviados antes dos pedaços binários. */
export interface ScreenFrameHeader {
  readonly bytes: number;
  readonly cpu: number;
  readonly privateMB: number;
}

export interface ScreenFrame extends ScreenFrameHeader {
  readonly chunks: ArrayBuffer[];
}

const MAX_JPEG_BYTES = 8 * 1024 ** 2;

export class ScreenFrameBuffer {
  private frame: (ScreenFrame & { received: number }) | null = null;

  header(value: unknown): void {
    const data = value as Partial<ScreenFrameHeader> | null;
    if (
      this.frame !== null ||
      typeof data?.bytes !== 'number' ||
      !Number.isInteger(data.bytes) ||
      data.bytes < 1 ||
      data.bytes > MAX_JPEG_BYTES ||
      typeof data.cpu !== 'number' ||
      !Number.isFinite(data.cpu) ||
      data.cpu < 0 ||
      typeof data.privateMB !== 'number' ||
      !Number.isFinite(data.privateMB) ||
      data.privateMB < 0
    ) {
      throw new Error('cabeçalho de quadro inválido');
    }
    this.frame = {
      bytes: data.bytes,
      cpu: data.cpu,
      privateMB: data.privateMB,
      received: 0,
      chunks: [],
    };
  }

  chunk(data: ArrayBuffer): ScreenFrame | null {
    const frame = this.frame;
    if (!frame || data.byteLength === 0 || frame.received + data.byteLength > frame.bytes) {
      throw new Error('pedaço de quadro inválido');
    }
    frame.chunks.push(data);
    frame.received += data.byteLength;
    if (frame.received < frame.bytes) return null;
    this.frame = null;
    return frame;
  }
}

/** Lê o marcador desenhado antes da codificação JPEG. Cada bit ocupa 8 × 8 pixels. */
export function readScreenMarker(readRed: (x: number, y: number) => number): number {
  let marker = 0;
  for (let bit = 0; bit < 16; bit++) {
    if (readRed(4 + 8 * bit, 4) > 128) marker |= 1 << bit;
  }
  return marker;
}

function percentile(samples: readonly number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export class ScreenMetrics {
  private readonly touches: number[] = [];
  private readonly pongs: number[] = [];
  private lastPong: number | null = null;
  private maxPointerGap = 0;
  private latestTouch: { marker: number; at: number } | null = null;
  private requestedTouch: { marker: number; at: number } | null = null;
  private marker = 0;
  private frames = 0;
  private bytes = 0;
  private width: number | null = null;
  private cpu: number | null = null;
  private privateMB: number | null = null;

  constructor(
    private readonly startedAt: number,
    private readonly pointerGapLimit: number,
  ) {}

  touch(at: number): void {
    this.marker = (this.marker + 1) & 0xffff;
    this.latestTouch = { marker: this.marker, at };
  }

  request(): number {
    this.requestedTouch = this.latestTouch;
    return this.marker;
  }

  frame(header: ScreenFrameHeader, width: number, marker: number, at: number): void {
    const touch = this.requestedTouch;
    this.requestedTouch = null;
    if (touch && touch.marker === marker && touch.at <= at) {
      this.touches.push(at - touch.at);
      if (this.latestTouch === touch) this.latestTouch = null;
    }
    this.frames++;
    this.bytes += header.bytes;
    this.width = width;
    this.cpu = header.cpu;
    this.privateMB = Math.max(this.privateMB ?? 0, header.privateMB);
  }

  pointerRtt(milliseconds: number, at: number): void {
    if (this.frames === 0) return;
    this.pongs.push(milliseconds);
    this.maxPointerGap = Math.max(this.maxPointerGap, at - (this.lastPong ?? this.startedAt));
    this.lastPong = at;
  }

  result(at: number, completed = false) {
    const pointerGap =
      this.lastPong === null ? null : Math.max(this.maxPointerGap, at - this.lastPong);
    const seconds = Math.max(0, (at - this.startedAt) / 1000);
    return {
      seconds,
      frames: this.frames,
      width: this.width,
      fps: seconds > 0 ? this.frames / seconds : 0,
      mbps: seconds > 0 ? (this.bytes * 8) / seconds / 1e6 : 0,
      touchP50: percentile(this.touches, 0.5),
      touchP95: percentile(this.touches, 0.95),
      touchCount: this.touches.length,
      pointerP95: percentile(this.pongs, 0.95),
      pointerCount: this.pongs.length,
      cpu: this.cpu,
      privateMB: this.privateMB,
      pointerGap,
      concurrent: completed && pointerGap !== null && pointerGap <= this.pointerGapLimit,
    };
  }
}
