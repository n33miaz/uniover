import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { SlowCommandWatch } from '../../../core/connectivity/slow-command';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { ClientTelemetry } from '../../../core/telemetry/client-telemetry';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { CANCELLED } from './pc-failure';
import { PcPrefs } from './pc-prefs';
import {
  ABANDONED_NOTICE_MS,
  DOWN_TIMEOUT_MS,
  HOLD_HEARTBEAT_MS,
  PC_POLL_MS,
  PcStore,
  INPUT_TIMEOUT_MS,
  MOVE_SETTLE_MS,
  UP_DRAIN_MS,
  UP_RETRY_BACKOFF_MS,
} from './pc-store';

function setup(initial: PcStatus | null = status()) {
  const current = signal<PcStatus | null>(initial);
  const availability = {
    status: current.asReadonly(),
    apps: () => current()?.apps ?? [],
    capabilities: () => current()?.capabilities ?? [],
    refresh: vi.fn(() => Promise.resolve(true)),
  };
  const api = {
    pointer: vi.fn(() => Promise.resolve()),
    click: vi.fn(() => Promise.resolve()),
    key: vi.fn(() => Promise.resolve()),
    keyRelease: vi.fn<(key: string, options?: unknown) => Promise<void>>(() => Promise.resolve()),
    text: vi.fn(() => Promise.resolve()),
    edit: vi.fn(() => Promise.resolve()),
    media: vi.fn(() => Promise.resolve()),
    power: vi.fn(() => Promise.resolve()),
    launch: vi.fn(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: availability },
      { provide: PcApi, useValue: api },
    ],
  });
  return { store: TestBed.inject(PcStore), api, availability, current };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function signIn(id: string) {
  TestBed.inject(SessionState).setUser({
    id,
    email: `${id}@exemplo.com`,
    displayName: id,
    role: 'owner',
  });
}

describe('PcStore phase', () => {
  it.each<[PcStatus | null, string, boolean]>([
    [null, 'loading', false],
    [status({ available: false, online: false }), 'unavailable', false],
    [status({ online: false }), 'offline', false],
    [status(), 'ready', true],
  ])('%j is %s', (current, phase, canSend) => {
    const { store } = setup(current);
    expect(store.phase()).toBe(phase);
    expect(store.canSend()).toBe(canSend);
  });

  it('follows the availability as it changes', () => {
    const { store, current } = setup(status({ online: false }));
    expect(store.phase()).toBe('offline');
    current.set(status());
    expect(store.phase()).toBe('ready');
  });
});

describe('PcStore capabilities', () => {
  it('has none until the agent declares them', () => {
    const { store } = setup(status());
    expect(store.capabilities()).toEqual([]);
    expect(store.supportsKeyV2()).toBe(false);
  });

  it('knows the agent understands pc.key.v2 once it declares it, and follows a change', () => {
    const { store, current } = setup(status());
    current.set(status({ capabilities: ['pc.key.v2'] }));
    expect(store.supportsKeyV2()).toBe(true);
    current.set(status({ capabilities: [] }));
    expect(store.supportsKeyV2()).toBe(false);
  });

  it('shows what fits the v1 to any PC, and the v2 keys only to one that declared it', () => {
    const old = setup(status());
    for (const key of ['ENTER', 'C', 'F5', 'PAGE_DOWN'] as const)
      expect(old.store.supportsKey(key)).toBe(true);
    for (const key of [
      'D0',
      'MINUS',
      'PRINT_SCREEN',
      'INSERT',
      'APPS',
      'WIN',
      'CAPS_LOCK',
    ] as const)
      expect(old.store.supportsKey(key)).toBe(false);
    expect(old.store.supportsKey('BACKSPACE', { repeat: 1 })).toBe(true);
    expect(old.store.supportsKey('BACKSPACE', { repeat: 2 })).toBe(false);
    expect(old.store.supportsKey('ALT', { action: 'DOWN' })).toBe(false);
    expect(old.store.supportsKey('C', { action: 'PRESS' })).toBe(true);

    TestBed.resetTestingModule();
    const current = setup(status({ capabilities: ['pc.key.v2'] }));
    expect(current.store.supportsKey('D0')).toBe(true);
    expect(current.store.supportsKey('BACKSPACE', { repeat: 30 })).toBe(true);
    expect(current.store.supportsKey('ALT', { action: 'DOWN' })).toBe(true);
  });
});

describe('PcStore text and click v2', () => {
  it('knows what the agent declared, and follows a change', () => {
    const { store, current } = setup(status());
    expect(store.supportsTextV2()).toBe(false);
    expect(store.supportsClickV2()).toBe(false);
    current.set(status({ capabilities: ['pc.text.v2'] }));
    expect(store.supportsTextV2()).toBe(true);
    expect(store.supportsClickV2()).toBe(false);
    current.set(status({ capabilities: ['pc.key.v2', 'pc.click.v2'] }));
    expect(store.supportsTextV2()).toBe(false);
    expect(store.supportsClickV2()).toBe(true);
  });

  it('an edit goes through the API in the queue, one request', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.text.v2'] }));
    expect(await store.sendTextEdit({ erase: 3, text: 'olá', key: 'ENTER' })).toBeNull();
    expect(api.edit).toHaveBeenCalledExactlyOnceWith({ erase: 3, text: 'olá', key: 'ENTER' });
  });

  it('an edit keeps its place in the queue: it never passes ahead of the text before it', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.text.v2'] }));
    const order: string[] = [];
    let release: () => void = () => undefined;
    api.text.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('text');
            resolve();
          };
        }),
    );
    api.edit.mockImplementationOnce(() => {
      order.push('edit');
      return Promise.resolve();
    });
    const first = store.sendText('abc');
    const second = store.sendTextEdit({ erase: 1 });
    await flush();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['text', 'edit']);
  });

  it('a failed edit cancels what was waiting behind it, as any request of the queue', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.text.v2'] }));
    api.edit.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    const first = store.sendTextEdit({ erase: 2 });
    const second = store.sendTextEdit({ text: 'x' });
    expect((await first)?.kind).toBeDefined();
    expect(await second).toBe(CANCELLED);
    expect(api.edit).toHaveBeenCalledTimes(1);
  });

  it('a click with modifiers and gap reaches the API on a PC that declared pc.click.v2', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.click.v2'] }));
    const options = { modifiers: ['CTRL'] as const, gapMs: 140 };
    expect(await store.click('LEFT', undefined, options)).toBeNull();
    expect(api.click).toHaveBeenCalledExactlyOnceWith('LEFT', undefined, options);
  });

  it('on a PC from before pc.click.v2 the click goes without them: nothing the agent would refuse', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.key.v2'] }));
    expect(await store.click('LEFT', undefined, { modifiers: ['CTRL'], gapMs: 140 })).toBeNull();
    expect(api.click).toHaveBeenCalledExactlyOnceWith('LEFT', undefined);
  });

  it('a click with no options is exactly what it always was', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.click.v2'] }));
    expect(await store.click('RIGHT')).toBeNull();
    expect(api.click).toHaveBeenCalledExactlyOnceWith('RIGHT', undefined);
  });
});

describe('PcStore commands', () => {
  it('sends text, keys, media, power and launches through the API and reports success as null', async () => {
    const { store, api } = setup();
    expect(await store.sendText('olá')).toBeNull();
    expect(await store.sendKey('C', ['CTRL'])).toBeNull();
    expect(await store.sendMedia('VOLUME_UP', 2)).toBeNull();
    expect(await store.power('SLEEP', true)).toBeNull();
    expect(await store.launch('notas')).toBeNull();
    expect(api.text).toHaveBeenCalledWith('olá');
    expect(api.key).toHaveBeenCalledWith('C', ['CTRL'], {});
    expect(api.media).toHaveBeenCalledWith('VOLUME_UP', 2);
    expect(api.power).toHaveBeenCalledWith('SLEEP', true);
    expect(api.launch).toHaveBeenCalledWith('notas');
  });

  it('hands the repeat and the action of a key to the API', async () => {
    const { store, api } = setup(status({ capabilities: ['pc.key.v2'] }));
    expect(await store.sendKey('BACKSPACE', [], { repeat: 12 })).toBeNull();
    expect(await store.sendKey('ALT', [], { action: 'DOWN' })).toBeNull();
    expect(api.key).toHaveBeenNthCalledWith(1, 'BACKSPACE', [], { repeat: 12 });
    expect(api.key).toHaveBeenNthCalledWith(2, 'ALT', [], { action: 'DOWN' });
  });

  it('still asks the API for a key the PC did not declare: the API decides, and refuses if it must', async () => {
    const { store, api } = setup();
    expect(store.supportsKey('BACKSPACE', { repeat: 12 })).toBe(false);
    expect(await store.sendKey('BACKSPACE', [], { repeat: 12 })).toBeNull();
    expect(api.key).toHaveBeenCalledTimes(1);
  });

  it('maps the refusal of an agent that is too old and re-reads what the PC declared', async () => {
    const { store, api, availability } = setup();
    api.key.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { type: 'https://uniover.dev/problems/pc-key-unsupported', title: 'x' },
      }),
    );
    const failure = await store.sendKey('PRINT_SCREEN');
    expect(failure?.kind).toBe('key-unsupported');
    expect(store.notice()?.kind).toBe('key-unsupported');
    expect(availability.refresh).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while the PC is not connected, and says why', async () => {
    const { store, api } = setup(status({ online: false }));
    expect((await store.sendKey('ENTER'))?.kind).toBe('offline');
    const { store: other, api: otherApi } = (() => {
      TestBed.resetTestingModule();
      return setup(status({ available: false, online: false }));
    })();
    expect((await other.sendText('x'))?.kind).toBe('unavailable');
    expect(api.key).not.toHaveBeenCalled();
    expect(otherApi.text).not.toHaveBeenCalled();
  });

  it('turns an API error into a short failure and re-reads the status when the PC went away', async () => {
    const { store, api, availability } = setup();
    api.key.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const failure = await store.sendKey('ENTER');
    expect(failure?.kind).toBe('offline');
    expect(store.notice()?.kind).toBe('offline');
    expect(availability.refresh).toHaveBeenCalledTimes(1);
  });

  it('a media request that never answers becomes a timeout, so whoever waits for it is not stuck forever', async () => {
    vi.useFakeTimers();
    try {
      const { store, api } = setup();
      api.media.mockImplementationOnce(() => new Promise<void>(() => undefined));
      let result: unknown = 'pending';
      void store.sendMedia('VOLUME_UP', 3).then((failure) => (result = failure));
      await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS - 1);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(2);
      expect((result as { kind: string }).kind).toBe('timeout');
      expect(store.notice()?.kind).toBe('timeout');
      // A fila de mídia não ficou presa: o pedido seguinte sai normalmente.
      expect(await store.sendMedia('MUTE')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-read the status for a failure that says nothing about the PC being away', async () => {
    const { store, api, availability } = setup();
    api.media.mockRejectedValueOnce(new HttpErrorResponse({ status: 429 }));
    expect((await store.sendMedia('MUTE'))?.kind).toBe('rate-limited');
    expect(availability.refresh).not.toHaveBeenCalled();
  });

  it('a click goes after the movement that was already on its way', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    let release = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('pointer done');
            resolve();
          };
        }),
    );
    api.click.mockImplementationOnce(() => {
      order.push('click');
      return Promise.resolve();
    });
    store.movePointer(10, 0, 16);
    const clicking = store.click('LEFT');
    await flush();
    expect(order).toEqual([]);
    release();
    await clicking;
    expect(order).toEqual(['pointer done', 'click']);
  });

  it('a click waits for every movement in flight and for the one still waiting for its slot', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    const finish: (() => void)[] = [];
    api.pointer.mockImplementation(((dx: number) => {
      order.push(`pointer ${dx}`);
      return new Promise<void>((resolve) => finish.push(resolve));
    }) as never);
    api.click.mockImplementationOnce(() => {
      order.push('click');
      return Promise.resolve();
    });
    store.movePointer(10, 0, 16); // sai já
    store.movePointer(7, 0, 16); // espera a taxa
    const clicking = store.click('LEFT');
    await flush();
    expect(order).toEqual(['pointer 10', 'pointer 7']);
    finish.forEach((resolve) => resolve());
    await clicking;
    expect(order).toEqual(['pointer 10', 'pointer 7', 'click']);
  });

  it('a move made after the tap cannot overtake the click: it is held until the click is sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      const order: string[] = [];
      const finish: (() => void)[] = [];
      api.pointer.mockImplementation(((dx: number) => {
        order.push(`pointer ${dx}`);
        return new Promise<void>((resolve) => finish.push(resolve));
      }) as never);
      api.click.mockImplementationOnce(() => {
        order.push('click');
        return Promise.resolve();
      });
      store.movePointer(10, 0, 16); // em voo
      const clicking = store.click('LEFT');
      store.movePointer(7, 0, 16); // depois do toque: não entra na espera e não pode passar na frente
      await vi.advanceTimersByTimeAsync(200); // a taxa já permitiria mandar o segundo
      expect(order).toEqual(['pointer 10']);
      finish[0]!(); // o primeiro responde
      await clicking;
      await vi.advanceTimersByTimeAsync(200);
      // O clique saiu primeiro e o movimento retido veio atrás dele (sem esperar a resposta do clique ou do primeiro).
      expect(order).toEqual(['pointer 10', 'click', 'pointer 7']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click does not release the hold of a button press that is still starting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      let finishDown: () => void = () => undefined;
      api.click.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishDown = resolve)),
      );
      const starting = store.startDrag();
      await vi.advanceTimersByTimeAsync(10);
      await store.click('RIGHT');
      store.movePointer(5, 0, 16);
      await vi.advanceTimersByTimeAsync(200);
      // O DOWN ainda não terminou: o movimento segue retido, mesmo depois de o clique ter saído.
      expect(api.pointer).not.toHaveBeenCalled();
      finishDown();
      await starting;
      await vi.advanceTimersByTimeAsync(200);
      expect(api.pointer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the notice of an abandoned tap is not cleared by the next movement that works, only by time or a newer failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.pointer.mockImplementationOnce(() => new Promise<void>(() => undefined)); // preso
      store.movePointer(10, 0, 16);
      const clicking = store.click('LEFT');
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS + 1);
      expect((await clicking)?.kind).toBe('timeout');
      expect(store.notice()?.message).toContain('o toque não foi enviado');

      // O movimento seguinte dá certo e não apaga o aviso.
      store.movePointer(3, 0, 16);
      await vi.advanceTimersByTimeAsync(100);
      expect(api.pointer).toHaveBeenCalledTimes(2);
      expect(store.notice()?.message).toContain('o toque não foi enviado');

      // Passado o tempo, o aviso some.
      await vi.advanceTimersByTimeAsync(ABANDONED_NOTICE_MS);
      expect(store.notice()).toBeNull();

      // E uma falha mais nova substitui o aviso preso.
      api.pointer.mockImplementationOnce(() => new Promise<void>(() => undefined));
      store.movePointer(1, 0, 16);
      const second = store.click('LEFT');
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS + 1);
      await second;
      api.pointer.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
      store.movePointer(2, 0, 16);
      await vi.advanceTimersByTimeAsync(100);
      expect(store.notice()?.kind).toBe('offline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a movement that never answers makes the click give up with a notice, never fire late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(10, 0, 16);
      const clicking = store.click('LEFT');
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS - 1);
      expect(api.click).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      const failure = await clicking;
      expect(failure?.kind).toBe('timeout');
      expect(store.notice()?.message).toContain('o toque não foi enviado');
      // Nem agora nem depois: o clique abandonado nunca sai.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the press of the button also gives up (nothing is pressed) when the movement never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(10, 0, 16);
      const starting = store.startDrag();
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS + 1);
      expect((await starting)?.kind).toBe('timeout');
      expect(api.click).not.toHaveBeenCalled();
      expect(store.dragging()).toBe(false);
      expect(store.buttonBusy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a text or key that never answers becomes a timeout, and the queue goes on without what was behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.text.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const first = store.sendText('abc');
      const second = store.sendKey('ENTER');
      await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS + 1);
      expect((await first)?.kind).toBe('timeout');
      expect(await second).toBe(CANCELLED);
      expect(store.notice()?.kind).toBe('timeout');
      expect(api.key).not.toHaveBeenCalled();
      expect(await store.sendKey('TAB')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second text only leaves after the first one settled, so they never swap on the way', async () => {
    const { store, api } = setup();
    let finishFirst: () => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    await flush();
    expect(api.text.mock.calls).toEqual([['abc']]);
    finishFirst();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(api.text.mock.calls).toEqual([['abc'], ['def']]);
  });

  it('a key never overtakes the text before it (Enter after a text goes after it)', async () => {
    const { store, api } = setup();
    const order: string[] = [];
    let finishText: () => void = () => undefined;
    api.text.mockImplementationOnce(() => {
      order.push('text');
      return new Promise<void>((resolve) => (finishText = resolve));
    });
    api.key.mockImplementationOnce(() => {
      order.push('key');
      return Promise.resolve();
    });
    const text = store.sendText('senha');
    const key = store.sendKey('ENTER');
    await flush();
    expect(order).toEqual(['text']);
    finishText();
    await Promise.all([text, key]);
    expect(order).toEqual(['text', 'key']);
  });

  it('a failure cancels the texts and keys queued behind it, and the queue works again afterwards', async () => {
    const { store, api } = setup();
    let failFirst: (error: unknown) => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((_, reject) => (failFirst = reject)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    const third = store.sendKey('ENTER');
    await flush();
    failFirst(new HttpErrorResponse({ status: 503 }));
    expect((await first)?.kind).toBe('offline');
    expect(await second).toBe(CANCELLED);
    expect(await third).toBe(CANCELLED);
    expect(api.text.mock.calls).toEqual([['abc']]);
    expect(api.key).not.toHaveBeenCalled();

    // O que for pedido depois da falha já sai.
    expect(await store.sendText('ghi')).toBeNull();
    expect(api.text.mock.calls).toEqual([['abc'], ['ghi']]);
  });

  it('typed input is cancelled when the account changes while it waits', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishFirst: () => void = () => undefined;
    api.text.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const first = store.sendText('abc');
    const second = store.sendText('def');
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishFirst();
    await first;
    expect(await second).toBe(CANCELLED);
    expect(api.text.mock.calls).toEqual([['abc']]);
  });

  it('numbers each movement request with a growing sequence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      store.movePointer(10, 0, 16);
      await vi.advanceTimersByTimeAsync(40);
      const seqs = (api.pointer.mock.calls as unknown as number[][]).map((call) => call[4]);
      expect(seqs).toHaveLength(3);
      expect(seqs.every((seq) => typeof seq === 'number')).toBe(true);
      expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
      expect(new Set(seqs).size).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drag holds the left button and the next call releases it', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    await store.toggleDrag();
    expect(store.dragging()).toBe(false);
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
  });

  it('drag stays off when the button could not be pressed', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    expect((await store.toggleDrag())?.kind).toBe('timeout');
    expect(store.dragging()).toBe(false);
  });
});

describe('PcStore holding the button', () => {
  const failing = (status: number) => new HttpErrorResponse({ status });

  /** Um pedido que só termina quando o teste manda. */
  function hanging(mock: { mockImplementationOnce: (fn: () => Promise<void>) => unknown }) {
    let finish: () => void = () => undefined;
    mock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    return () => finish();
  }

  afterEach(() => vi.restoreAllMocks());

  it('a failed DOWN is followed by an UP right away, and the button is not shown as held', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(failing(504));
    expect((await store.toggleDrag())?.kind).toBe('timeout');
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
    expect(store.dragging()).toBe(false);
  });

  it('a DOWN that never answers is given up after the timeout and released', async () => {
    vi.useFakeTimers();
    try {
      const { store, api } = setup();
      hanging(api.click);
      const asking = store.toggleDrag();
      await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
      expect((await asking)?.kind).toBe('timeout');
      expect(api.click.mock.calls).toEqual([
        ['LEFT', 'DOWN'],
        ['LEFT', 'UP'],
      ]);
      expect(store.dragging()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second tap on Drag while the DOWN is on its way does not send another DOWN', async () => {
    const { store, api } = setup();
    const finish = hanging(api.click);
    const first = store.toggleDrag();
    const second = store.toggleDrag();
    const third = store.toggleDrag();
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'DOWN']]);
    finish();
    await Promise.all([first, second, third]);
    expect(store.dragging()).toBe(true);
    expect(api.click).toHaveBeenCalledTimes(1);
  });

  it('a tap while the UP is on its way is ignored too, and the next one starts again', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockClear();
    const finish = hanging(api.click);
    const releasing = store.toggleDrag();
    await flush();
    await store.toggleDrag();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    finish();
    await releasing;
    expect(store.dragging()).toBe(false);
    await store.toggleDrag();
    expect(api.click.mock.calls.at(-1)).toEqual(['LEFT', 'DOWN']);
  });

  it('a release asked while the DOWN is still leaving goes out as soon as the DOWN answers', async () => {
    const { store, api } = setup();
    const finish = hanging(api.click);
    const starting = store.startDrag();
    await flush();
    expect(await store.release()).toBeNull();
    expect(api.click.mock.calls).toEqual([['LEFT', 'DOWN']]);
    finish();
    await starting;
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'UP'],
    ]);
    expect(store.dragging()).toBe(false);
  });

  it('a release asked while the movement was still going out means the DOWN is not sent at all', async () => {
    const { store, api } = setup();
    const finishMove = hanging(api.pointer);
    store.movePointer(10, 0, 16);
    const starting = store.startDrag();
    await flush();
    await store.release();
    finishMove();
    expect(await starting).toBeNull();
    expect(store.dragging()).toBe(false);
    expect(api.click).not.toHaveBeenCalled();
  });

  it('the normal release waits for the movement in flight, so the drop happens where the finger ended', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockClear();
    const order: string[] = [];
    let finishMove: () => void = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishMove = () => {
            order.push('move done');
            resolve();
          };
        }),
    );
    api.click.mockImplementationOnce(() => {
      order.push('UP');
      return Promise.resolve();
    });
    store.movePointer(30, 0, 16);
    const releasing = store.release();
    await flush();
    expect(order).toEqual([]);
    finishMove();
    await releasing;
    expect(order).toEqual(['move done', 'UP']);
  });

  it('a movement request that never answers cannot keep the button pressed: the UP leaves after a limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store, api } = setup();
      await store.toggleDrag();
      api.click.mockClear();
      api.pointer.mockImplementation((() => new Promise<void>(() => undefined)) as never);
      store.movePointer(30, 0, 16);
      const releasing = store.release();
      await vi.advanceTimersByTimeAsync(UP_DRAIN_MS - 1);
      expect(api.click).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await releasing;
      expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
      expect(store.dragging()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('release does nothing when no button is held', async () => {
    const { store, api } = setup();
    expect(await store.release()).toBeNull();
    expect(api.click).not.toHaveBeenCalled();
  });

  it('release works even when the PC is shown as disconnected (an extra UP is harmless)', async () => {
    const { store, api, current } = setup();
    await store.toggleDrag();
    current.set(status({ online: false }));
    api.click.mockClear();
    await store.release();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    expect(store.dragging()).toBe(false);
  });

  it('a release that fails keeps the button shown as held, so the person can try again', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(failing(503));
    expect((await store.release())?.kind).toBe('offline');
    expect(store.dragging()).toBe(true);
    await store.release();
    expect(store.dragging()).toBe(false);
  });

  it('pagehide releases the button with a keepalive request', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP', { keepalive: true }]]);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('going to the background (the page turns hidden) releases it too', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP', { keepalive: true }]]);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('hiding the page with nothing held sends nothing', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click).not.toHaveBeenCalled();
    stop();
  });

  it('hiding the page while the DOWN is on its way sends no UP out of the queue: the keepalive UP follows right after the DOWN settled', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    const log: string[] = [];
    let finish: () => void = () => undefined;
    api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finish = () => {
            log.push('DOWN settled');
            resolve();
          };
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    const starting = store.startDrag();
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(log).toEqual(['DOWN sent']);
    finish();
    await starting;
    await flush();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    expect(store.dragging()).toBe(false);
    stop();
  });

  it('if the release on hide does not get through, the button stays shown as held', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(failing(503));
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(store.dragging()).toBe(true);
    stop();
  });

  it('closing the watch (leaving the module) releases the button', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    stop();
    await flush();
    expect(api.click.mock.calls).toEqual([['LEFT', 'UP']]);
    expect(store.dragging()).toBe(false);
  });

  it('stops listening once the watch is closed', async () => {
    const { store, api } = setup();
    store.watch()();
    await store.toggleDrag();
    api.click.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(api.click).not.toHaveBeenCalled();
  });
});

describe('PcStore pointer preferences', () => {
  it('moves the pointer one for one by default, at any speed', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.movePointer(40, 0, 4);
    await flush();
    expect(api.pointer).toHaveBeenCalledWith(40, 0, 0, 0, expect.any(Number));
  });

  it('uses the gain the person chose', async () => {
    const { store, api } = setup();
    TestBed.inject(PcPrefs).set({ sensitivity: 'high' });
    store.beginGesture();
    store.movePointer(10, 0, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledWith(16, 0, 0, 0, expect.any(Number));
  });

  it('scrolls the Windows way by default and the other way when inverted', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.scrollPointer(0, 20, 400);
    await flush();
    const natural = (api.pointer.mock.calls[0] as unknown as number[])[3];
    expect(natural).toBeLessThan(0);

    TestBed.inject(PcPrefs).set({ invertScroll: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.beginGesture();
    store.scrollPointer(0, 20, 400);
    await flush();
    const inverted = (api.pointer.mock.calls[1] as unknown as number[])[3];
    expect(inverted).toBe(-natural);
  });

  it('the scroll sensitivity scales how far the same swipe scrolls', async () => {
    const { store, api } = setup();
    const prefs = TestBed.inject(PcPrefs);
    const scrolled = async (index: number) => {
      store.beginGesture();
      store.scrollPointer(0, 40, 400);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Math.abs((api.pointer.mock.calls[index] as unknown as number[])[3]);
    };
    prefs.set({ scrollSensitivity: 'low' });
    const low = await scrolled(0);
    prefs.set({ scrollSensitivity: 'normal' });
    const normal = await scrolled(1);
    prefs.set({ scrollSensitivity: 'high' });
    const high = await scrolled(2);
    expect(low).toBeLessThan(normal);
    expect(normal).toBeLessThan(high);
  });

  it('a faster swipe scrolls farther than the same swipe done slowly', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.scrollPointer(0, 40, 400);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.beginGesture();
    store.scrollPointer(0, 40, 20);
    await flush();
    const slow = (api.pointer.mock.calls[0] as unknown as number[])[3];
    const fast = (api.pointer.mock.calls[1] as unknown as number[])[3];
    expect(Math.abs(fast)).toBeGreaterThan(Math.abs(slow));
  });
});

describe('PcStore press after a click', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the press of the button waits for the click that was already on its way (a double-tap drag never lets the click land after the DOWN)', async () => {
    const { store, api } = setup();
    let answerClick: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answerClick = resolve;
        }),
    );
    void store.click('LEFT');
    await flush();
    expect(api.click).toHaveBeenCalledTimes(1);
    const started = store.startDrag();
    await flush();
    // O DOWN ainda espera: o clique não respondeu.
    expect(api.click).toHaveBeenCalledTimes(1);
    answerClick();
    await started;
    expect(api.click.mock.calls.map((call) => (call as unknown[])[1])).toEqual([undefined, 'DOWN']);
    await store.release();
  });

  it('a click that never answers gives the press up with a notice, and nothing is pressed behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      api.click.mockImplementationOnce(() => new Promise<void>(() => undefined));
      void store.click('LEFT');
      await vi.advanceTimersByTimeAsync(0);
      const started = store.startDrag();
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS + 10);
      const failure = await started;
      expect(failure?.kind).toBe('timeout');
      expect(failure?.message).toContain('clique');
      expect(store.notice()?.message).toContain('clique');
      // Nenhum DOWN: o botão não é apertado por trás de um clique que ninguém sabe se saiu.
      expect(api.click.mock.calls.map((call) => (call as unknown[])[1])).toEqual([undefined]);
      expect(store.dragging()).toBe(false);
      // E a tela não fica travada: o próximo aperto, sem clique pendente, sai.
      expect(store.buttonBusy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click that never answers times out by itself, and then the press is no longer held back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      api.click.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const clicking = store.click('LEFT');
      await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS + 10);
      const failure = await clicking;
      expect(failure?.kind).toBe('timeout');
      // Um aperto agora sai: o clique preso já não barra nenhum.
      const started = store.startDrag();
      await vi.advanceTimersByTimeAsync(10);
      expect(await started).toBeNull();
      expect(api.click.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
        undefined,
        'DOWN',
      ]);
      await store.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung click gives up one press (after the settle time) but not every press for ever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      api.click.mockImplementationOnce(() => new Promise<void>(() => undefined));
      void store.click('LEFT');
      await vi.advanceTimersByTimeAsync(0);
      const first = store.startDrag();
      await vi.advanceTimersByTimeAsync(MOVE_SETTLE_MS + 10);
      expect((await first)?.kind).toBe('timeout');
      await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS);
      const second = store.startDrag();
      await vi.advanceTimersByTimeAsync(10);
      expect(await second).toBeNull();
      await store.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no click in flight the press goes out at once', async () => {
    const { store, api } = setup();
    await store.startDrag();
    expect(api.click.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['DOWN']);
    await store.release();
  });
});

describe('PcStore held modifiers', () => {
  const pageHide = () =>
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));

  it('holds with a DOWN through the API and lets go through its own release path, never the input queue', async () => {
    const { store, api } = setup();
    expect(await store.holdKey('ALT')).toBeNull();
    expect(store.heldKeys()).toEqual(['ALT']);
    expect(api.key).toHaveBeenCalledExactlyOnceWith('ALT', [], { action: 'DOWN' });

    expect(await store.releaseKey('ALT')).toBeNull();
    expect(store.heldKeys()).toEqual([]);
    expect(api.keyRelease).toHaveBeenCalledExactlyOnceWith('ALT');
    expect(api.key).toHaveBeenCalledTimes(1);
  });

  it('sendKey with DOWN and UP goes to the same paths', async () => {
    const { store, api } = setup();
    await store.sendKey('ALT', [], { action: 'DOWN' });
    expect(store.heldKeys()).toEqual(['ALT']);
    await store.sendKey('ALT', [], { action: 'UP' });
    expect(store.heldKeys()).toEqual([]);
    expect(api.keyRelease).toHaveBeenCalledWith('ALT');
    expect(api.key).toHaveBeenCalledTimes(1);
  });

  it('an explicit release always goes out, even when the key is not marked as held', async () => {
    const { store, api } = setup();
    expect(await store.releaseKey('ALT')).toBeNull();
    expect(api.keyRelease).toHaveBeenCalledExactlyOnceWith('ALT');
  });

  it('a release that overtook its own DOWN is sent again once the DOWN settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      let finishDown: () => void = () => undefined;
      api.key.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDown = resolve;
          }),
      );
      const holding = store.holdKey('ALT');
      await vi.advanceTimersByTimeAsync(0);
      const releasing = store.releaseKey('ALT');
      await vi.advanceTimersByTimeAsync(UP_DRAIN_MS);
      await releasing;
      // O `UP` saiu enquanto o `DOWN` seguia no ar (ele pode demorar até `INPUT_TIMEOUT_MS`).
      expect(api.keyRelease).toHaveBeenCalledTimes(1);
      expect(store.heldKeys()).toEqual([]);

      finishDown();
      await vi.advanceTimersByTimeAsync(0);
      await holding;
      expect(api.keyRelease).toHaveBeenCalledTimes(2);
      expect(api.keyRelease).toHaveBeenLastCalledWith('ALT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a DOWN that times out may still arrive: the release is sent again when it finally settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      let finishDown: () => void = () => undefined;
      api.key.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDown = resolve;
          }),
      );
      const holding = store.holdKey('ALT');
      await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS);
      expect((await holding)?.kind).toBe('timeout');
      await vi.advanceTimersByTimeAsync(0);
      const before = api.keyRelease.mock.calls.length;
      expect(before).toBeGreaterThanOrEqual(1);

      finishDown();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.keyRelease.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a DOWN that settles while the key is still held asks for nothing more', async () => {
    const { store, api } = setup();
    await store.holdKey('ALT');
    await flush();
    expect(api.keyRelease).not.toHaveBeenCalled();
  });

  it('a failure of the input queue never cancels the release of a held modifier', async () => {
    const { store, api } = setup();
    await store.holdKey('ALT');
    api.key.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    expect((await store.sendKey('TAB'))?.kind).toBe('failed');
    // A fila cancelou o que vinha atrás dela, mas o soltar tem caminho próprio.
    expect(await store.releaseKey('ALT')).toBeNull();
    expect(api.keyRelease).toHaveBeenCalledWith('ALT');
    expect(store.heldKeys()).toEqual([]);
  });

  it('waits only briefly for what is already in flight, and then sends the release anyway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, api } = setup();
      await store.holdKey('ALT');
      api.key.mockImplementationOnce(() => new Promise<void>(() => undefined)); // um toque que nunca responde
      void store.sendKey('TAB');
      await vi.advanceTimersByTimeAsync(0);
      const releasing = store.releaseKey('ALT');
      await vi.advanceTimersByTimeAsync(UP_DRAIN_MS - 1);
      expect(api.keyRelease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await releasing).toBeNull();
      expect(api.keyRelease).toHaveBeenCalledWith('ALT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hold whose request never went out (the queue was cancelled) is not left marked as held', async () => {
    const { store, api } = setup();
    let fail: (error: unknown) => void = () => undefined;
    api.key.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const first = store.sendKey('A');
    const hold = store.holdKey('ALT');
    expect(store.heldKeys()).toEqual(['ALT']);
    await flush(); // o primeiro toque já saiu e está no ar
    fail(new HttpErrorResponse({ status: 502 }));
    await first;
    expect((await hold)?.kind).toBe('cancelled');
    expect(store.heldKeys()).toEqual([]);
    expect(api.key).toHaveBeenCalledTimes(1);
  });

  it('a DOWN whose answer was lost may have arrived: it is let go at once', async () => {
    const { store, api } = setup();
    api.key.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    expect((await store.holdKey('ALT'))?.kind).toBe('timeout');
    await flush();
    await flush();
    expect(api.keyRelease).toHaveBeenCalledWith('ALT');
    expect(store.heldKeys()).toEqual([]);
  });

  it('a plain release that fails keeps the modifier marked as held, so it can be tried again', async () => {
    const { store, api } = setup();
    await store.holdKey('ALT');
    api.keyRelease.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    expect((await store.releaseKey('ALT'))?.kind).toBe('offline');
    expect(store.heldKeys()).toEqual(['ALT']);
  });

  describe('a hold still waiting in the queue when the screen goes away', () => {
    /** Um toque lento na frente: o `DOWN` do Alt espera atrás dele. */
    function queuedBehindSlowKey() {
      const ctx = setup();
      let finish: () => void = () => undefined;
      ctx.api.key.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      void ctx.store.sendKey('TAB');
      return { ...ctx, finishSlow: () => finish() };
    }

    it('leaving the module: the queued DOWN never goes out, and the Alt is let go', async () => {
      const { store, api, finishSlow } = queuedBehindSlowKey();
      const stop = store.watch();
      await flush();
      const holding = store.holdKey('ALT');
      expect(store.heldKeys()).toEqual(['ALT']);
      stop();
      finishSlow();
      expect((await holding)?.kind).toBe('cancelled');
      await flush();
      expect((api.key.mock.calls as unknown[][]).map(([key]) => key)).toEqual(['TAB']);
      expect(api.keyRelease).toHaveBeenCalledWith('ALT');
      expect(store.heldKeys()).toEqual([]);
    });

    it('hiding the page: the queued DOWN never goes out either', async () => {
      const { store, api, finishSlow } = queuedBehindSlowKey();
      const stop = store.watch();
      await flush();
      const holding = store.holdKey('ALT');
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
      finishSlow();
      expect((await holding)?.kind).toBe('cancelled');
      await flush();
      expect((api.key.mock.calls as unknown[][]).map(([key]) => key)).toEqual(['TAB']);
      expect(api.keyRelease).toHaveBeenCalledWith('ALT', { keepalive: true });
      stop();
    });

    it('a hold asked after the screen is gone is refused and sends nothing', async () => {
      const { store, api } = setup();
      const stop = store.watch();
      stop();
      expect((await store.holdKey('ALT'))?.kind).toBe('cancelled');
      expect(api.key).not.toHaveBeenCalled();
      expect(store.heldKeys()).toEqual([]);
    });

    it('a hold let go while it waited (the release did not wait for a stuck queue) does not go out later', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { store, api, finishSlow } = queuedBehindSlowKey();
        await vi.advanceTimersByTimeAsync(0); // o toque lento já saiu e está no ar
        const holding = store.holdKey('ALT');
        const releasing = store.releaseKey('ALT');
        await vi.advanceTimersByTimeAsync(UP_DRAIN_MS);
        await releasing;
        expect(api.keyRelease).toHaveBeenCalledTimes(1);
        finishSlow();
        await vi.advanceTimersByTimeAsync(0);
        expect((await holding)?.kind).toBe('cancelled');
        expect((api.key.mock.calls as unknown[][]).map(([key]) => key)).toEqual(['TAB']);
        expect(store.heldKeys()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('leaving the module lets go of what is held, retrying while it fails', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.holdKey('ALT');
    api.keyRelease.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    stop();
    await new Promise((resolve) => setTimeout(resolve, (UP_RETRY_BACKOFF_MS[0] ?? 0) + 100));
    expect(api.keyRelease).toHaveBeenCalledTimes(2);
    expect(store.heldKeys()).toEqual([]);
  });

  it('hiding the page lets go at once with keepalive, without waiting for any queue', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.holdKey('ALT');
    api.key.mockImplementationOnce(() => new Promise<void>(() => undefined)); // fila presa
    void store.sendKey('TAB');
    pageHide();
    expect(api.keyRelease).toHaveBeenCalledExactlyOnceWith('ALT', { keepalive: true });
    await flush();
    expect(store.heldKeys()).toEqual([]);
    stop();
  });

  it('a hide whose release failed keeps it marked, so the screen can try again', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.holdKey('SHIFT');
    api.keyRelease.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    pageHide();
    await flush();
    expect(store.heldKeys()).toEqual(['SHIFT']);
    stop();
  });

  it('switching accounts forgets what was held and sends nothing to the new account', async () => {
    const { store, api } = setup();
    signIn('a');
    await store.holdKey('ALT');
    signIn('b');
    TestBed.tick();
    expect(store.heldKeys()).toEqual([]);
    expect(await store.releaseKey('ALT')).toBeNull();
    expect(api.keyRelease).not.toHaveBeenCalled();
  });

  it('a PC that went away forgets what was held (the agent let go when it lost the connection)', async () => {
    const { store, api, current } = setup();
    await store.holdKey('ALT');
    current.set(status({ online: false }));
    TestBed.tick();
    expect(store.heldKeys()).toEqual([]);
    expect(api.keyRelease).not.toHaveBeenCalled();
  });

  it('several modifiers are held and let go independently', async () => {
    const { store, api } = setup();
    await store.holdKey('CTRL');
    await store.holdKey('SHIFT');
    await store.holdKey('CTRL'); // já segurado: nada vai
    expect(store.heldKeys()).toEqual(['CTRL', 'SHIFT']);
    expect(api.key).toHaveBeenCalledTimes(2);
    await store.releaseHeldKeys();
    expect(store.heldKeys()).toEqual([]);
    expect(api.keyRelease.mock.calls.map(([key]) => key).sort()).toEqual(['CTRL', 'SHIFT']);
  });
});

describe('PcStore sign of life while a modifier is held', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  const beats = (api: ReturnType<typeof setup>['api']) =>
    (api.pointer.mock.calls as unknown[][]).filter(([dx, dy]) => dx === 0 && dy === 0).length;

  it('reuses the 10 s zero movement while a modifier is held, and stops when it is let go', async () => {
    const { store, api } = setup();
    await store.holdKey('ALT');
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(1);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(2);
    await store.releaseKey('ALT');
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(beats(api)).toBe(2);
  });

  it('keeps beating while either the mouse button or a modifier is held', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    await store.holdKey('ALT');
    await store.toggleDrag(); // solta o mouse: o Alt ainda precisa do sinal de vida
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(1);
  });
});

describe('PcStore sign of life while the button is held', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  const beats = (api: ReturnType<typeof setup>['api']) =>
    (api.pointer.mock.calls as unknown[][]).filter(([dx, dy]) => dx === 0 && dy === 0).length;

  it('sends a zero movement every 10 s while the button is held, and nothing before it is', async () => {
    const { store, api } = setup();
    vi.advanceTimersByTime(HOLD_HEARTBEAT_MS * 2);
    expect(api.pointer).not.toHaveBeenCalled();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS - 1);
    expect(beats(api)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 2);
    expect(beats(api)).toBe(3);
  });

  it('the beat carries no scroll and moves nothing', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer.mock.calls).toEqual([[0, 0]]);
  });

  it('stops when the button is released', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('stops when the page is hidden, and comes back if the button is still held when it shows again', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 2);
    expect(beats(api)).toBe(0);
    expect(store.dragging()).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(1);
    stop();
  });

  it('stops when the module is left', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(beats(api)).toBe(0);
  });

  it('stops when the account changes', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 3);
    expect(beats(api)).toBe(0);
  });

  it('stays quiet when a beat fails and tries again at the next one', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.pointer.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(store.notice()).toBeNull();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(beats(api)).toBe(2);
  });

  it('does not add a beat while real pointer traffic is on its way', async () => {
    const { store, api } = setup();
    await store.toggleDrag();
    api.pointer.mockImplementationOnce(() => new Promise<void>(() => undefined));
    store.movePointer(10, 0, 16);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledTimes(1);
  });
});

describe('PcStore button commands in order and without leftovers', () => {
  /** Um pedido que só termina quando o teste manda, com o que aconteceu anotado numa lista. */
  function logged(api: ReturnType<typeof setup>['api'], log: string[]) {
    const finishers: (() => void)[] = [];
    api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finishers.push(() => {
            log.push('DOWN settled');
            resolve();
          });
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    return { settleDown: () => finishers.shift()!() };
  }

  afterEach(() => vi.useRealTimers());

  it('an UP asked while the DOWN is still on its way waits for the DOWN to settle', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const starting = store.startDrag();
    await flush();
    await store.release();
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settleDown();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent']);
    expect(store.dragging()).toBe(false);
  });

  it('when the DOWN fails, the UP goes only after it settled', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    api.click.mockImplementation(((_button?: string, action?: string) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((_resolve, reject) =>
          setTimeout(() => {
            log.push('DOWN settled');
            reject(new HttpErrorResponse({ status: 503 }));
          }, 10),
        );
      }
      log.push('UP sent');
      return Promise.resolve();
    }) as never);
    await store.toggleDrag();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent']);
  });

  it('on the timeout the UP goes out, and if the DOWN answers OK later there is one more UP', async () => {
    vi.useFakeTimers();
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const starting = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    expect((await starting)?.kind).toBe('timeout');
    expect(log).toEqual(['DOWN sent', 'UP sent']);
    settleDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['DOWN sent', 'UP sent', 'DOWN settled', 'UP sent']);
    expect(store.dragging()).toBe(false);
  });

  it('a late DOWN does not release a new drag that started after the timeout', async () => {
    vi.useFakeTimers();
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    const first = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    await first;
    const second = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(0);
    settleDown(); // o primeiro DOWN, atrasado
    await vi.advanceTimersByTimeAsync(0);
    settleDown(); // o segundo
    await second;
    expect(store.dragging()).toBe(true);
    expect(log.filter((entry) => entry === 'UP sent')).toHaveLength(1);
  });

  it('movement during a held-down press waits for the DOWN and then goes out', async () => {
    const { store, api } = setup();
    const log: string[] = [];
    const { settleDown } = logged(api, log);
    api.pointer.mockImplementation((() => {
      log.push('pointer');
      return Promise.resolve();
    }) as never);
    const starting = store.startDrag();
    await flush();
    store.beginGesture();
    store.movePointer(10, 0, 16);
    store.movePointer(5, 0, 16);
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settleDown();
    await starting;
    await flush();
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'pointer']);
    expect(api.pointer).toHaveBeenCalledTimes(1);
    expect(store.dragging()).toBe(true);
  });
});

describe('PcStore after leaving the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const clickActions = (api: ReturnType<typeof setup>['api']) =>
    (api.click.mock.calls as unknown[][]).map(([, action]) => action);

  /** O DOWN fica no ar até o teste mandar; os UP seguem a regra dada. */
  function hangingDown(api: ReturnType<typeof setup>['api'], up: () => Promise<void>) {
    let finish: () => void = () => undefined;
    api.click.mockImplementation(((_button?: string, action?: string) =>
      action === 'DOWN'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : up()) as never);
    return () => finish();
  }

  it('leaving while the DOWN is on its way: a failing UP is retried, never re-marked as held, and no heartbeat leaks', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    const finish = hangingDown(api, () => Promise.reject(new HttpErrorResponse({ status: 503 })));
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await starting;
    expect(clickActions(api)).toEqual(['DOWN', 'UP', 'UP', 'UP']);
    expect(store.dragging()).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('the retry stops at the first UP that gets through', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    let attempts = 0;
    const finish = hangingDown(api, () =>
      ++attempts === 1 ? Promise.reject(new HttpErrorResponse({ status: 503 })) : Promise.resolve(),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS[0]);
    await starting;
    expect(clickActions(api)).toEqual(['DOWN', 'UP', 'UP']);
    expect(store.dragging()).toBe(false);
  });

  it('hiding the page while the DOWN is on its way: the UP that fails afterwards leaves no heartbeat either', async () => {
    const { store, api } = setup();
    store.watch();
    const finish = hangingDown(api, () => Promise.reject(new HttpErrorResponse({ status: 503 })));
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await starting;
    expect(store.dragging()).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('leaving with the button held and the UP failing keeps trying a few times, with no heartbeat', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockClear();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(clickActions(api)).toEqual(['UP', 'UP', 'UP']);
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('coming back to the screen allows the heartbeat again', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    stop();
    store.watch();
    await store.toggleDrag();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
  });
});

describe('PcStore when the account changes while a button is held', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const actions = (api: ReturnType<typeof setup>['api']) =>
    (api.click.mock.calls as unknown[][]).map(([, action]) => action);

  it('forgets the held button locally and sends nothing at all (the agent releases it by itself)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    api.click.mockClear();

    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS * 6);

    expect(store.dragging()).toBe(false);
    expect(api.click).not.toHaveBeenCalled();
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('a release retrying a failing UP gives up when the account changes during the wait', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    api.click.mockClear();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));

    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(actions(api)).toEqual(['UP']);
    signIn('conta-b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    await releasing;
    expect(actions(api)).toEqual(['UP']);
  });

  it('the UP that follows a DOWN gives up when the account changed meanwhile', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    await store.release();
    signIn('conta-b');
    TestBed.tick();
    finish();
    await starting;
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(actions(api)).toEqual(['DOWN']);
  });

  it('the extra UP after a late DOWN is not sent once the account is another', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = store.toggleDrag();
    await vi.advanceTimersByTimeAsync(DOWN_TIMEOUT_MS);
    await starting;
    expect(actions(api)).toEqual(['DOWN', 'UP']);
    signIn('conta-b');
    TestBed.tick();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(actions(api)).toEqual(['DOWN', 'UP']);
  });
});

describe('PcStore after a press that failed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('DOWN fails and the safety UP fails too: the release when the finger lifts retries the UP until it gets through', async () => {
    const { store, api } = setup();
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 })); // DOWN
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 })); // UP de segurança
    expect((await store.startDrag())?.kind).toBe('timeout');
    expect(store.dragging()).toBe(false);
    expect((api.click.mock.calls as unknown[][]).map(([, action]) => action)).toEqual([
      'DOWN',
      'UP',
    ]);

    // O dedo sobe: o botão pode estar apertado, então o soltar insiste (a primeira tentativa falha, a segunda passa).
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS[0]);
    expect(await releasing).toBeNull();
    expect((api.click.mock.calls as unknown[][]).map(([, action]) => action)).toEqual([
      'DOWN',
      'UP',
      'UP',
      'UP',
    ]);
    // Agora nada pode estar apertado: soltar de novo não manda nada.
    await store.release({ persistent: true });
    expect(api.click).toHaveBeenCalledTimes(4);
  });
});

describe('PcStore pagehide with the DOWN still in flight', () => {
  /** O DOWN fica no ar; tudo que sai é anotado na ordem. */
  function setupInFlight() {
    const ctx = setup();
    const log: string[] = [];
    let finish: () => void = () => undefined;
    ctx.api.click.mockImplementation(((_button?: string, action?: string, options?: unknown) => {
      if (action === 'DOWN') {
        log.push('DOWN sent');
        return new Promise<void>((resolve) => {
          finish = () => {
            log.push('DOWN settled');
            resolve();
          };
        });
      }
      log.push(options ? 'UP sent (keepalive)' : 'UP sent');
      return Promise.resolve();
    }) as never);
    return { ...ctx, log, settle: () => finish() };
  }

  const pageHide = (persisted: boolean) =>
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

  it('a page that really dies (persisted false) also sends an immediate keepalive UP, besides the queued one', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    pageHide(false);
    await flush();
    expect(log).toEqual(['DOWN sent', 'UP sent (keepalive)']);
    settle();
    await starting;
    await flush();
    expect(log).toEqual([
      'DOWN sent',
      'UP sent (keepalive)',
      'DOWN settled',
      'UP sent (keepalive)',
    ]);
    stop();
  });

  it('a page that goes to the cache (persisted true) only queues the UP after the DOWN', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    pageHide(true);
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settle();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    stop();
  });

  it('going to the background (visibilitychange) keeps only the queued UP', async () => {
    const { store, log, settle } = setupInFlight();
    const stop = store.watch();
    const starting = store.startDrag();
    await flush();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(log).toEqual(['DOWN sent']);
    settle();
    await starting;
    expect(log).toEqual(['DOWN sent', 'DOWN settled', 'UP sent (keepalive)']);
    vi.restoreAllMocks();
    stop();
  });
});

describe('PcStore commands that give up because the account changed', () => {
  afterEach(() => localStorage.clear());

  it('an UP already waiting in the queue is dropped when the account changed before its turn, with no notice and no re-read of the state', async () => {
    const { store, api, availability } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);
    api.click.mockClear();
    availability.refresh.mockClear();

    // Algo na frente da fila segura a vez do UP (um pedido anterior ainda em voo).
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const releasing = store.release();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    await releasing;
    await flush();

    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
    expect(availability.refresh).not.toHaveBeenCalled();
  });

  it('a DOWN waiting in the queue gives up the same way', async () => {
    const { store, api, availability } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const starting = store.startDrag();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    await starting;
    await flush();
    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
    expect(availability.refresh).not.toHaveBeenCalled();
    expect(store.dragging()).toBe(false);
  });
});

describe('PcStore heartbeat when coming back to the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a button still held when the screen opens again gets its sign of life back', async () => {
    const { store, api } = setup();
    const stop = store.watch();
    await store.toggleDrag();
    api.click.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    stop();
    await vi.advanceTimersByTimeAsync(UP_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
    expect(store.dragging()).toBe(true);
    api.pointer.mockClear();

    store.watch();
    await vi.advanceTimersByTimeAsync(HOLD_HEARTBEAT_MS);
    expect(api.pointer).toHaveBeenCalledWith(0, 0);
  });
});

describe('PcStore heartbeat and the account', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('a tick never goes out when the session is already another account (before the store noticed)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    // Sem esperar o efeito da troca de conta: logo depois de entrar com a outra, o botão ainda consta como apertado, e é a
    // conferência do próprio sinal que o impede de ir para o PC errado.
    signIn('conta-b');
    expect(store.dragging()).toBe(true);
    await (store as unknown as { beat(): Promise<void> }).beat();
    expect(api.pointer).not.toHaveBeenCalled();
  });
});

describe('PcStore giving up quietly', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('an UP that gives up because the account changed leaves the retry loop at once, with a neutral value and no wait', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    api.click.mockClear();

    // O primeiro UP está na fila atrás de algo em voo; a conta muda antes de a vez dele chegar.
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const releasing = store.release({ persistent: true });
    await vi.advanceTimersByTimeAsync(0);
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    // Nenhuma espera de retry: a promessa resolve sem avançar o relógio.
    const result = await releasing;
    expect(result?.kind).toBe('cancelled');
    expect(result?.message).toBe('');
    expect(api.click).not.toHaveBeenCalled();
    expect(store.notice()).toBeNull();
  });

  it('a command that gives up reports the neutral value, never a misleading message', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finishHead: () => void = () => undefined;
    void (
      store as unknown as { queueButton(task: () => Promise<void>): Promise<void> }
    ).queueButton(
      () =>
        new Promise<void>((resolve) => {
          finishHead = resolve;
        }),
    );
    const starting = store.startDrag();
    await vi.advanceTimersByTimeAsync(0);
    signIn('conta-b');
    TestBed.tick();
    finishHead();
    expect(await starting).toBe(CANCELLED);
    expect(api.click).not.toHaveBeenCalled();
  });
});

describe('PcStore pointer', () => {
  it('accelerates the swipe and sends it as one request', async () => {
    const { store, api } = setup();
    store.beginGesture();
    store.movePointer(10, 4, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledTimes(1);
    const [dx, dy] = api.pointer.mock.calls[0] as unknown as number[];
    expect(dx).toBeGreaterThanOrEqual(10);
    expect(dy).toBeGreaterThanOrEqual(4);
  });

  it('turns a two-finger swipe into wheel units (down scrolls down)', async () => {
    const { store, api } = setup();
    store.scrollPointer(0, 40, 4_000);
    await flush();
    const [, , , scrollY] = api.pointer.mock.calls[0] as unknown as number[];
    expect(scrollY).toBeLessThanOrEqual(-120);
    expect(scrollY).toBeGreaterThan(-130);
  });

  it('sends nothing while the PC is not connected', async () => {
    const { store, api } = setup(status({ online: false }));
    store.movePointer(50, 50, 16);
    store.scrollPointer(0, 50);
    await flush();
    expect(api.pointer).not.toHaveBeenCalled();
  });

  it('shows the failure of a movement and clears it at the next success', async () => {
    const { store, api } = setup();
    api.pointer.mockRejectedValueOnce(new HttpErrorResponse({ status: 429 }));
    store.movePointer(5, 5, 16);
    await flush();
    expect(store.notice()?.kind).toBe('rate-limited');
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.movePointer(5, 5, 16);
    await flush();
    expect(store.notice()).toBeNull();
  });
});

describe('PcStore watch', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('reads the status now and then every poll interval, until stopped', () => {
    const { store, availability } = setup();
    const stop = store.watch();
    expect(availability.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PC_POLL_MS * 2);
    expect(availability.refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(PC_POLL_MS * 3);
    expect(availability.refresh).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden', () => {
    const { store, availability } = setup();
    const stop = store.watch();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(PC_POLL_MS * 2);
    expect(availability.refresh).toHaveBeenCalledTimes(1);
    stop();
    vi.restoreAllMocks();
  });
});

describe('PcStore when the account changes', () => {
  afterEach(() => localStorage.clear());

  /** Um pedido de movimento que só termina quando o teste manda. */
  function hangingPointer(api: ReturnType<typeof setup>['api']) {
    let finish: () => void = () => undefined;
    api.pointer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    return () => finish();
  }

  it('a movement scheduled by one account never leaves after the next person signed in', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);

    store.movePointer(10, 0, 16); // sai já e fica em voo
    store.movePointer(20, 0, 16); // fica esperando atrás dele
    expect(api.pointer).toHaveBeenCalledTimes(1);

    signIn('conta-b');
    TestBed.tick();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.pointer).toHaveBeenCalledTimes(1);

    // E o store segue utilizável para a pessoa nova.
    store.movePointer(5, 0, 16);
    await flush();
    expect(api.pointer).toHaveBeenCalledTimes(2);
  });

  it('a movement still waiting is dropped even before the effect noticed the change', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);
    store.movePointer(10, 0, 16);
    store.movePointer(20, 0, 16);

    signIn('conta-b'); // sem `TestBed.tick()`: quem barra é a conferência na hora de enviar
    finish();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(api.pointer).toHaveBeenCalledTimes(1);
  });

  it('an active drag does not carry over: the next toggle presses, it does not release (the UP of the old one went before the switch)', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    await store.toggleDrag();
    expect(store.dragging()).toBe(true);

    signIn('conta-b');
    TestBed.tick();
    expect(store.dragging()).toBe(false);

    await store.toggleDrag();
    expect(api.click.mock.calls).toEqual([
      ['LEFT', 'DOWN'],
      ['LEFT', 'DOWN'],
    ]);
    expect(store.dragging()).toBe(true);
  });

  it('a click that was waiting for the movement of another account is not sent', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    const finish = hangingPointer(api);
    store.movePointer(10, 0, 16);

    const clicking = store.click('LEFT');
    await flush();
    signIn('conta-b');
    finish();

    expect((await clicking)?.kind).toBe('unavailable');
    expect(api.click).not.toHaveBeenCalled();
  });

  it('a drag that finished after the change does not mark the new account as dragging', async () => {
    const { store, api } = setup();
    signIn('conta-a');
    TestBed.tick();
    let finish: () => void = () => undefined;
    api.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dragging = store.toggleDrag();
    await flush();
    signIn('conta-b');
    TestBed.tick();
    finish();
    await dragging;
    expect(store.dragging()).toBe(false);
  });
});

describe('PcStore commands without an answer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a command that gets no answer for 3 s raises the "O PC não está respondendo" flag, and it goes away with the answer', async () => {
    const { store, api } = setup();
    const watch = TestBed.inject(SlowCommandWatch);
    let release!: () => void;
    api.click.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    const pending = store.click('LEFT');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(watch.isSlow('pc')).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(watch.isSlow('pc')).toBe(true);
    release();
    await expect(pending).resolves.toBeNull();
    expect(watch.isSlow('pc')).toBe(false);
  });

  it('a command that answers in time never raises it', async () => {
    const { store } = setup();
    const watch = TestBed.inject(SlowCommandWatch);
    await store.click('LEFT');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watch.isSlow('pc')).toBe(false);
  });

  it('a command that fails clears the flag and still shows the failure', async () => {
    const { store, api } = setup();
    const watch = TestBed.inject(SlowCommandWatch);
    let fail!: (error: unknown) => void;
    api.click.mockReturnValueOnce(new Promise<void>((_, reject) => (fail = reject)));
    const pending = store.click('LEFT');
    await vi.advanceTimersByTimeAsync(3_100);
    expect(watch.isSlow('pc')).toBe(true);
    fail(new HttpErrorResponse({ status: 0 }));
    const failure = await pending;
    expect(failure?.kind).toBe('network');
    expect(watch.isSlow('pc')).toBe(false);
    expect(store.notice()?.kind).toBe('network');
  });

  it('a failed command is registered for the owner: module, kind and path, never the message', async () => {
    const { store, api } = setup();
    const record = vi.spyOn(TestBed.inject(ClientTelemetry), 'record');
    api.click.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    await store.click('LEFT');
    expect(record).toHaveBeenCalledWith({
      kind: 'command-failure',
      module: 'pc',
      code: 'timeout',
      transport: 'cloud',
    });
  });
});
