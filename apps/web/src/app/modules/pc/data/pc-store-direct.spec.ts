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
  const direct = {
    start: vi.fn(() => calls.push('direct.start')),
    stop: vi.fn(() => calls.push('direct.stop')),
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
  return { store: TestBed.inject(PcStore), api, direct, calls, lost };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PcStore with the direct channel', () => {
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
