import { vi } from 'vitest';
import { computed, signal } from '@angular/core';
import type { PcFavorite, PcStatus } from '../../core/modules/pc-availability';
import {
  PC_CLICK_V2_CAPABILITY,
  PC_KEY_V2_CAPABILITY,
  PC_TEXT_V2_CAPABILITY,
  keyNeedsV2,
} from './data/pc-types';
import type { PcFailure } from './data/pc-failure';
import type { PcPhase } from './data/pc-store';
import type {
  PcClickButton,
  PcClickOptions,
  PcHoldableKey,
  PcKey,
  PcKeyOptions,
  PcMediaAction,
  PcModifier,
  PcPowerAction,
  PcTextEdit,
} from './data/pc-types';

type Outcome = Promise<PcFailure | null>;

/**
 * Dublê do `PcStore` para os testes das telas: os mesmos sinais e métodos, sem rede. Cada comando é um `vi.fn` que
 * responde sem falha (`null`), e o teste troca a resposta quando quer provar uma falha.
 */
export function createFakePcStore(initial: PcPhase = 'ready') {
  const phase = signal<PcPhase>(initial);
  const apps = signal<readonly PcFavorite[]>([]);
  const capabilities = signal<readonly string[]>([]);
  const heldKeys = signal<readonly PcHoldableKey[]>([]);
  const store = {
    phase,
    canSend: computed(() => phase() === 'ready'),
    apps,
    capabilities,
    heldKeys,
    holdKey: vi.fn<(key: PcHoldableKey) => Outcome>(() => Promise.resolve(null)),
    releaseKey: vi.fn<(key: PcHoldableKey, options?: { persistent?: boolean }) => Outcome>(() =>
      Promise.resolve(null),
    ),
    releaseHeldKeys: vi.fn<(options?: { persistent?: boolean }) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    supportsKeyV2: computed(() => capabilities().includes(PC_KEY_V2_CAPABILITY)),
    supportsTextV2: computed(() => capabilities().includes(PC_TEXT_V2_CAPABILITY)),
    supportsClickV2: computed(() => capabilities().includes(PC_CLICK_V2_CAPABILITY)),
    supportsKey: (key: PcKey, options?: PcKeyOptions) =>
      !keyNeedsV2(key, options) || capabilities().includes(PC_KEY_V2_CAPABILITY),
    notice: signal<PcFailure | null>(null),
    dragging: signal(false),
    watch: vi.fn(() => () => undefined),
    refresh: vi.fn(() => Promise.resolve(true)),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    movePointer: vi.fn<(dx: number, dy: number, elapsedMs: number) => void>(),
    scrollPointer: vi.fn<(dx: number, dy: number, elapsedMs?: number) => void>(),
    click: vi.fn<(button: PcClickButton, action?: string, options?: PcClickOptions) => Outcome>(
      () => Promise.resolve(null),
    ),
    toggleDrag: vi.fn<() => Outcome>(() => Promise.resolve(null)),
    startDrag: vi.fn<() => Outcome>(() => Promise.resolve(null)),
    release: vi.fn<(options?: { persistent?: boolean }) => Outcome>(() => Promise.resolve(null)),
    buttonBusy: false,
    pressEpoch: 0,
    sendKey: vi.fn<
      (key: PcKey, modifiers?: readonly PcModifier[], options?: PcKeyOptions) => Outcome
    >(() => Promise.resolve(null)),
    sendText: vi.fn<(text: string) => Outcome>(() => Promise.resolve(null)),
    sendTextEdit: vi.fn<(edit: PcTextEdit) => Outcome>(() => Promise.resolve(null)),
    sendMedia: vi.fn<(action: PcMediaAction, steps?: number) => Outcome>(() =>
      Promise.resolve(null),
    ),
    power: vi.fn<(action: PcPowerAction, confirm?: boolean) => Outcome>(() =>
      Promise.resolve(null),
    ),
    launch: vi.fn<(appId: string) => Outcome>(() => Promise.resolve(null)),
  };
  return store;
}

export type FakePcStore = ReturnType<typeof createFakePcStore>;

export const FAILURE: PcFailure = { kind: 'offline', message: 'O PC está desconectado.' };

export function status(overrides: Partial<PcStatus> = {}): PcStatus {
  return { available: true, online: true, apps: [], capabilities: [], ...overrides };
}
