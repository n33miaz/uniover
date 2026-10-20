import { vi } from 'vitest';
import { signal } from '@angular/core';
import { TvFailure } from './data/tv-errors';
import { TvLink, TvNotice, TvStatus, TvStreamStatus } from './data/tv-store';
import { TvShortcut, TvState, TvWatchdog } from './data/tv-types';

/** Estado quente padrão dos testes de tela. */
export const HOT: TvState = {
  power: 'on',
  volume: 22,
  app: null,
  connection: 'hot',
  agentOnline: true,
  updatedAt: '2026-10-19T14:02:00Z',
};

export function makeShortcut(position: number, overrides: Partial<TvShortcut> = {}): TvShortcut {
  return {
    id: `s${position}`,
    position,
    package: `pacote.app${position}`,
    tvLabel: null,
    customLabel: null,
    enabled: true,
    installed: true,
    iconDataUri: null,
    ...overrides,
  };
}

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const text = (value: string) => [...value].map((char) => char.charCodeAt(0));

/**
 * Ícones sintéticos só com o cabeçalho (o jsdom não decodifica imagem; o e2e usa PNGs de verdade): o suficiente para a
 * tela ler a forma. Nada vem de app real.
 */
export function pngIcon(width: number, height: number): string {
  const header = [
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32be(13),
    ...text('IHDR'),
    ...u32be(width),
    ...u32be(height),
    ...[8, 6, 0, 0, 0, 0, 0, 0, 0],
  ];
  return `data:image/png;base64,${toBase64(header)}`;
}

export type WebpKind = 'lossy' | 'lossless' | 'extended';

export function webpIcon(kind: WebpKind, width: number, height: number): string {
  const riff = [...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')];
  let body: number[];
  if (kind === 'extended') {
    body = [...text('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  } else if (kind === 'lossless') {
    const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
    body = [...text('VP8L'), 5, 0, 0, 0, 0x2f, ...u32be(bits).reverse()];
  } else {
    body = [
      ...text('VP8 '),
      ...[10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a],
      ...u16le(width),
      ...u16le(height),
    ];
  }
  const bytes = [...riff, ...body];
  while (bytes.length < 36) bytes.push(0);
  return `data:image/webp;base64,${toBase64(bytes)}`;
}

/**
 * `TvStore` de mentira para as telas: só signals que o teste liga e desliga, e métodos que registram a chamada.
 * Assim cada tela é testada sem rede, sem fluxo e sem relógio.
 */
export function createFakeTvStore() {
  return {
    state: signal<TvState | null>(HOT),
    shortcuts: signal<TvShortcut[] | null>([makeShortcut(1), makeShortcut(2), makeShortcut(3)]),
    status: signal<TvStatus>('hot'),
    lastKnownStatus: signal<TvStatus | null>('hot'),
    link: signal<TvLink>('ok'),
    canSend: signal(true),
    disabledReason: signal<string | null>(null),
    seenAtText: signal('14:02'),
    streamStatus: signal<TvStreamStatus>('live'),
    notice: signal<TvNotice | null>(null),
    watchdogNote: signal<string | null>(null),
    watchdog: signal<TvWatchdog | null>(null),
    notConfigured: signal(false),
    inFlightKeys: signal(0),
    hibernateMinutes: 5,
    start: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    sendKey: vi.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true),
    sendText: vi.fn<(text: string) => Promise<TvFailure | null>>().mockResolvedValue(null),
    powerOff: vi.fn<() => Promise<TvFailure | null>>().mockResolvedValue(null),
    launch: vi.fn<(shortcut: TvShortcut) => Promise<boolean>>().mockResolvedValue(true),
    refreshShortcuts: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    renameShortcut: vi
      .fn<(id: string, label: string) => Promise<boolean>>()
      .mockResolvedValue(true),
    setShortcutEnabled: vi
      .fn<(id: string, enabled: boolean) => Promise<boolean>>()
      .mockResolvedValue(true),
    clearNotice: vi.fn(),
  };
}

export type FakeTvStore = ReturnType<typeof createFakeTvStore>;
