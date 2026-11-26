import type { ScreenFrameStats } from './screen-viewer';

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
