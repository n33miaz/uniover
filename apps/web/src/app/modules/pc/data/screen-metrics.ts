import type { ScreenFrameStats } from './screen-viewer';

/** O agente que anuncia `ready` envia o tamanho no JSON e o JPEG básico em mensagens binárias. */
export class LegacyScreenFrameAssembler {
  private jpeg: Uint8Array<ArrayBuffer> | null = null;
  private received = 0;

  push(data: ArrayBuffer, requestedWidth: number, bytes: number) {
    if (bytes > 8 * 1024 ** 2 || !data.byteLength || this.received + data.byteLength > bytes) {
      throw new Error('pedaço de JPEG inválido');
    }
    this.jpeg ??= new Uint8Array(bytes);
    this.jpeg.set(new Uint8Array(data), this.received);
    this.received += data.byteLength;
    if (this.received < bytes) return null;

    const jpeg = this.jpeg;
    this.jpeg = null;
    this.received = 0;
    const { width, height } = legacyJpegDimensions(new DataView(jpeg.buffer));
    if (
      !width ||
      !height ||
      width > requestedWidth ||
      height > 16_384 ||
      width * height > 1920 * 4320
    ) {
      throw new Error('dimensões de JPEG inválidas');
    }
    return { width, height, wireBytes: bytes, chunks: [jpeg.buffer] };
  }
}

// O JPEG básico do agente antigo traz as dimensões no SOF0. Limita a imagem antes da decodificação.
function legacyJpegDimensions(jpeg: DataView) {
  if (jpeg.getUint16(0) !== 0xffd8) throw new Error('JPEG inválido');
  let offset = 2;
  while (offset + 4 <= jpeg.byteLength) {
    const marker = jpeg.getUint16(offset);
    const length = jpeg.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > jpeg.byteLength) break;
    if (marker === 0xffc0) {
      if (length < 11 || length !== 8 + 3 * jpeg.getUint8(offset + 9)) break;
      return { width: jpeg.getUint16(offset + 7), height: jpeg.getUint16(offset + 5) };
    }
    // A captura antiga do Pillow escreve APP0 (JFIF) e as tabelas de quantização antes do SOF0.
    if (marker !== 0xffe0 && marker !== 0xffdb) break;
    offset += 2 + length;
  }
  throw new Error('JPEG sem dimensões');
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
  private marker = 1;
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
    // O agente só envia métricas com um marcador diferente de zero.
    this.marker = (this.marker % 0xffff) + 1;
    this.latestTouch = { marker: this.marker, at };
  }

  request(): number {
    this.requestedTouch = this.latestTouch;
    return this.marker;
  }

  frame(stats: ScreenFrameStats, width: number, marker: number, at: number): void {
    const touch = this.requestedTouch;
    this.requestedTouch = null;
    if (touch && touch.marker === marker && touch.at <= at) {
      this.touches.push(at - touch.at);
      if (this.latestTouch === touch) this.latestTouch = null;
    }
    this.frames++;
    this.bytes += stats.bytes;
    this.width = width;
    this.cpu = stats.cpu;
    this.privateMB = Math.max(this.privateMB ?? 0, stats.privateMB);
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
