import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { PcDirect } from './pc-direct';
import { PcStore } from './pc-store';

/**
 * O que o armazém do controle faz com o canal direto: liga com a tela, fecha primeiro ao sair, e, se o canal cai sozinho,
 * solta o botão e os modificadores (pela nuvem, já que o canal acabou). O `PcApi` é falso, então os pedidos vistos aqui são
 * o que sairia pela nuvem.
 */
function setup() {
  const calls: string[] = [];
  const lost: (() => void)[] = [];
  // O canal direto está em uso agora? (`canUse` do `PcDirect`): o teste liga e desliga.
  const usable = { value: false };
  const direct = {
    canUse: vi.fn(() => usable.value),
    start: vi.fn(() => calls.push('direct.start')),
    stop: vi.fn(() => calls.push('direct.stop')),
    setBusyProbe: vi.fn(),
    onLost: vi.fn((listener: () => void) => {
      lost.push(listener);
      return () => {
        lost.splice(lost.indexOf(listener), 1);
      };
    }),
  };
  const api = {
    pointer: vi.fn(() => Promise.resolve()),
    click: vi.fn((button: string, action?: string) => {
      calls.push(`click:${button}:${action ?? 'CLICK'}`);
      return Promise.resolve();
    }),
    key: vi.fn(() => Promise.resolve()),
    keyRelease: vi.fn((key: string) => {
      calls.push(`release:${key}`);
      return Promise.resolve();
    }),
    text: vi.fn(() => Promise.resolve()),
    media: vi.fn(() => Promise.resolve()),
    power: vi.fn(() => Promise.resolve()),
    launch: vi.fn(() => Promise.resolve()),
  };
  const current = signal<PcStatus | null>(status());
  TestBed.configureTestingModule({
    providers: [
      {
        provide: PcAvailability,
        useValue: {
          status: current.asReadonly(),
          apps: () => [],
          capabilities: () => [],
          refresh: vi.fn(() => Promise.resolve(true)),
        },
      },
      { provide: PcApi, useValue: api },
      { provide: PcDirect, useValue: direct },
    ],
  });
  return { store: TestBed.inject(PcStore), api, direct, calls, lost, usable };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PcStore with the direct channel', () => {
  /** Um pedido de movimento que nunca termina: o HTTP preso de uma nuvem lenta (ou um agente que engasgou). */
  const stuckPointer = () => new Promise<void>(() => undefined);

  it('over the cloud a click still waits for the moves already sent (and is abandoned if they never finish)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api, usable } = setup();
      usable.value = false;
      store.watch();
      api.pointer.mockImplementation(stuckPointer);
      store.movePointer(30, 0, 16);
      const click = store.click('LEFT');
      await vi.advanceTimersByTimeAsync(2_000);

      expect((await click)?.kind).toBe('timeout'); // abandonado: o movimento não terminou
      expect(api.click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with the direct channel in use a click does not wait for any HTTP and the finger movement goes out first', async () => {
    const { store, api, usable, calls } = setup();
    usable.value = true;
    store.watch();
    api.pointer.mockImplementation(stuckPointer);
    store.movePointer(30, 0, 16);
    calls.length = 0;

    const result = await store.click('LEFT');

    expect(result).toBeNull();
    expect(api.pointer).toHaveBeenCalledTimes(1); // o que o dedo andou saiu antes do clique
    expect(calls).toEqual(['click:LEFT:CLICK']);
  });

  it('the pointer batcher groups at 10 ms through the direct channel and at 32 ms through the cloud', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { store, api, usable } = setup();
      store.watch();

      const sentIn = async (direct: boolean): Promise<number> => {
        usable.value = direct;
        api.pointer.mockClear();
        store.movePointer(5, 0, 16); // sai já (a primeira não espera taxa nenhuma)
        await vi.advanceTimersByTimeAsync(1);
        store.movePointer(5, 0, 16); // esta espera o intervalo mínimo
        for (let ms = 1; ms <= 40; ms++) {
          if (api.pointer.mock.calls.length >= 2) return ms;
          await vi.advanceTimersByTimeAsync(1);
        }
        return 99;
      };

      const viaDirect = await sentIn(true);
      await vi.advanceTimersByTimeAsync(100);
      const viaCloud = await sentIn(false);

      expect(viaDirect).toBeLessThanOrEqual(12);
      expect(viaCloud).toBeGreaterThanOrEqual(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening the screen starts the channel, and closing it stops the channel before the release', async () => {
    const { store, calls } = setup();
    const stop = store.watch();
    expect(calls).toEqual(['direct.start']);

    await store.toggleDrag(); // aperta o botão (arrastar)
    calls.length = 0;
    stop();
    await flush();

    // O canal fecha primeiro (o agente solta o que segurava) e o `UP` que segue sai pela nuvem.
    expect(calls[0]).toBe('direct.stop');
    expect(calls).toContain('click:LEFT:UP');
  });

  it('a channel that drops while the button is held releases it through the cloud and clears the state', async () => {
    const { store, calls, lost } = setup();
    store.watch();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    calls.length = 0;

    lost[0]!();
    await flush();
    await flush();

    expect(calls).toContain('click:LEFT:UP');
    expect(store.dragging()).toBe(false);
  });

  it('a channel that drops while a modifier is held releases that modifier', async () => {
    const { store, calls, lost } = setup();
    store.watch();
    expect(await store.holdKey('ALT')).toBeNull();
    expect(store.heldKeys()).toEqual(['ALT']);
    calls.length = 0;

    lost[0]!();
    await flush();
    await flush();

    expect(calls).toContain('release:ALT');
    expect(store.heldKeys()).toEqual([]);
  });

  it('a channel that drops with nothing held sends nothing', async () => {
    const { store, calls, lost } = setup();
    store.watch();
    calls.length = 0;

    lost[0]!();
    await flush();

    expect(calls).toEqual([]);
  });

  it('stops listening for the loss when the screen closes', () => {
    const { store, lost } = setup();
    const stop = store.watch();
    expect(lost).toHaveLength(1);
    stop();

    expect(lost).toHaveLength(0);
  });
});
