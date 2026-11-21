import { vi } from 'vitest';
import { computed, signal } from '@angular/core';
import type {
  PcFavorite,
  PcPowerOutcome,
  PcStatus,
  PcVolumeLevel,
} from '../../core/modules/pc-availability';
import {
  PC_CLICK_V2_CAPABILITY,
  PC_CLIPBOARD_CAPABILITY,
  PC_HIBERNATE_CAPABILITY,
  PC_KEY_V2_CAPABILITY,
  PC_MEDIA_STATE_CAPABILITY,
  PC_TARGET_CAPABILITY,
  PC_TEXT_V2_CAPABILITY,
  PC_TEXT_V3_CAPABILITY,
  PC_POWER_CANCEL_CAPABILITY,
  PC_POWER_V2_CAPABILITY,
  PC_VOLUME_CAPABILITY,
  PC_ZOOM_CAPABILITY,
  keyNeedsV2,
} from './data/pc-types';
import type { PcFailure } from './data/pc-failure';
import type { PcPhase, PcRead } from './data/pc-store';
import type {
  PcClickButton,
  PcClickOptions,
  PcFocusTarget,
  PcHoldableKey,
  PcKey,
  PcKeyOptions,
  PcMediaAction,
  PcModifier,
  PcNowPlaying,
  PcCountdownStart,
  PcPowerAction,
  PcTextEdit,
  PcVolumeChange,
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
  const volume = signal<PcVolumeLevel | null>(null);
  const powerOutcome = signal<PcPowerOutcome | null>(null);
  const store = {
    phase,
    canSend: computed(() => phase() === 'ready'),
    apps,
    capabilities,
    powerOutcome,
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
    supportsTextV3: computed(() => capabilities().includes(PC_TEXT_V3_CAPABILITY)),
    supportsTarget: computed(() => capabilities().includes(PC_TARGET_CAPABILITY)),
    supportsClickV2: computed(() => capabilities().includes(PC_CLICK_V2_CAPABILITY)),
    supportsZoom: computed(() => capabilities().includes(PC_ZOOM_CAPABILITY)),
    supportsVolume: computed(() => capabilities().includes(PC_VOLUME_CAPABILITY)),
    supportsPowerV2: computed(() => capabilities().includes(PC_POWER_V2_CAPABILITY)),
    supportsHibernate: computed(
      () =>
        capabilities().includes(PC_POWER_V2_CAPABILITY) &&
        capabilities().includes(PC_HIBERNATE_CAPABILITY),
    ),
    supportsPowerCancel: computed(() => capabilities().includes(PC_POWER_CANCEL_CAPABILITY)),
    supportsNowPlaying: computed(() => capabilities().includes(PC_MEDIA_STATE_CAPABILITY)),
    supportsClipboard: computed(() => capabilities().includes(PC_CLIPBOARD_CAPABILITY)),
    nowPlaying: vi.fn<() => Promise<PcNowPlaying | null>>(() => Promise.resolve(null)),
    readClipboard: vi.fn<() => Promise<PcRead<string>>>(() =>
      Promise.resolve({ ok: true, value: '' }),
    ),
    writeClipboard: vi.fn<(text: string) => Outcome>(() => Promise.resolve(null)),
    volume,
    zoomPointer: vi.fn<(steps: number) => void>(),
    setVolume: vi.fn<(change: PcVolumeChange) => Outcome>(() => Promise.resolve(null)),
    supportsKey: (key: PcKey, options?: PcKeyOptions) =>
      !keyNeedsV2(key, options) || capabilities().includes(PC_KEY_V2_CAPABILITY),
    notice: signal<PcFailure | null>(null),
    dragging: signal(false),
    watch: vi.fn(() => () => undefined),
    refresh: vi.fn(() => Promise.resolve(true)),
    requestApproval: vi.fn<() => Outcome>(() => Promise.resolve(null)),
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
    sendText: vi.fn<(text: string, target?: PcFocusTarget) => Outcome>(() => Promise.resolve(null)),
    sendTextEdit: vi.fn<(edit: PcTextEdit) => Outcome>(() => Promise.resolve(null)),
    sendMedia: vi.fn<(action: PcMediaAction, steps?: number) => Outcome>(() =>
      Promise.resolve(null),
    ),
    power: vi.fn<(action: PcPowerAction, confirm?: boolean, countdownId?: string) => Outcome>(
      () => Promise.resolve(null),
    ),
    startCountdown: vi.fn<(action: 'SHUTDOWN' | 'RESTART') => Promise<PcCountdownStart>>(() =>
      Promise.resolve({ failure: null, countdownId: null }),
    ),
    launch: vi.fn<(appId: string) => Outcome>(() => Promise.resolve(null)),
  };
  return store;
}

export type FakePcStore = ReturnType<typeof createFakePcStore>;

export const FAILURE: PcFailure = { kind: 'offline', message: 'O PC está desconectado.' };

export function status(overrides: Partial<PcStatus> = {}): PcStatus {
  return {
    available: true,
    online: true,
    apps: [],
    capabilities: [],
    volume: null,
    ...overrides,
  };
}
