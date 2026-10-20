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
    iconDataUri: null,
    ...overrides,
  };
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
