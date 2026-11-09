import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { status } from '../pc-test-kit';
import {
  ACK_TIMEOUT_MS,
  CLOCK_TIMEOUT_MS,
  DIRECT_BACKOFF_MS,
  DirectNotSent,
  MAX_CLOUD_IDLE_MS,
  PC_RTC_CAPABILITY,
  newCloudEpoch,
  PC_RTC_FACTORY,
  PING_MS,
  POINTER_TAIL_MS,
  PcDirect,
  PcDirectSignaling,
  STABLE_MS,
  STALL_MS,
} from './pc-direct';

/** Um canal de dados de mentira: guarda o que se manda e deixa o teste abrir, fechar e responder. */
class FakeChannel extends EventTarget {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  /** O agente de mentira responde cada sinal de vida (com a escala de relógio já firmada). */
  respond = true;
  constructor(
    readonly label: string,
    readonly options: { ordered?: boolean; maxRetransmits?: number },
  ) {
    super();
  }
  send(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(message);
    if (this.label === 'pointer' && this.respond && message['k'] === 'ping') {
      queueMicrotask(() => this.receive({ k: 'pong', n: message['n'], c: true }));
    }
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  last(kind: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((message) => message['k'] === kind);
  }
}

class FakeConnection extends EventTarget {
  iceGatheringState: 'new' | 'complete' = 'complete';
  connectionState: 'new' | 'connected' | 'failed' | 'closed' | 'disconnected' = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly channels: FakeChannel[] = [];
  closed = false;
  createDataChannel(label: string, options: { ordered?: boolean; maxRetransmits?: number }) {
    const channel = new FakeChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  createOffer() {
    return Promise.resolve({
      type: 'offer',
      sdp: 'v=0\r\nm=application\r\na=fingerprint:sha-256 AA',
    });
  }
  setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    return Promise.resolve();
  }
  setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
  channel(label: string): FakeChannel {
    return this.channels.find((c) => c.label === label)!;
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(initial: PcStatus | null = status({ capabilities: [PC_RTC_CAPABILITY] })) {
  const current = signal<PcStatus | null>(initial);
  const connections: FakeConnection[] = [];
  const signaling = {
    offer: vi.fn(() => Promise.resolve({ sessionId: 's1', sdp: 'ANSWER', token: 'tok-1' })),
    close: vi.fn(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: { status: current.asReadonly() } },
      { provide: PcDirectSignaling, useValue: signaling },
      {
        provide: PC_RTC_FACTORY,
        useValue: () => {
          const connection = new FakeConnection();
          connections.push(connection);
          return connection as unknown as RTCPeerConnection;
        },
      },
    ],
  });
  return { direct: TestBed.inject(PcDirect), signaling, connections, current };
}

/** Abre o canal até o fim: oferta, resposta, os dois canais abertos e o `ready` do agente. */
async function openChannel(direct: PcDirect, connections: FakeConnection[], index = 0) {
  direct.start();
  await vi.waitFor(() => expect(connections[index]?.channels).toHaveLength(2));
  const connection = connections[index]!;
  await vi.waitFor(() => expect(connection.remoteDescription).not.toBeNull());
  connection.channel('pointer').open();
  connection.channel('input').open();
  await vi.waitFor(() => expect(connection.channel('input').last('auth')).toBeDefined());
  connection.channel('input').receive({ k: 'ready' });
  await vi.waitFor(() => expect(direct.mode()).toBe('direct'));
  return { connection, pointer: connection.channel('pointer'), input: connection.channel('input') };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PcDirect opening', () => {
  it('does nothing without WebRTC in the browser, and the cloud stays the way', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PcAvailability,
          useValue: { status: signal(status({ capabilities: [PC_RTC_CAPABILITY] })).asReadonly() },
        },
        { provide: PC_RTC_FACTORY, useValue: null },
      ],
    });
    const direct = TestBed.inject(PcDirect);
    direct.start();
    await flush();

    expect(direct.mode()).toBe('cloud');
    expect(direct.canUse()).toBe(false);
    await expect(direct.command('pc.key.v1', { key: 'A' })).rejects.toBeInstanceOf(DirectNotSent);
    expect(() => direct.sendPointer(1, 1, 0, 0)).toThrow(DirectNotSent);
  });

  it.each<[string, Partial<PcStatus>]>([
    ['the agent does not declare pc.rtc.v1', { capabilities: [] }],
    ['the PC is offline', { online: false, capabilities: [PC_RTC_CAPABILITY] }],
    ['there is no PC', { available: false, online: false, capabilities: [] }],
  ])('does not try when %s', async (_name, overrides) => {
    const { direct, connections, signaling } = setup(status(overrides));
    direct.start();
    await flush();

    expect(connections).toHaveLength(0);
    expect(signaling.offer).not.toHaveBeenCalled();
  });

  it('opens the two channels, offers through the API and authenticates with the token first', async () => {
    const { direct, connections, signaling } = setup();
    const { connection, pointer, input } = await openChannel(direct, connections);

    // O ponteiro sem ordem e sem retransmissão; a entrada ordenada e confiável.
    expect(pointer.options).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(input.options).toEqual({ ordered: true });
    expect(signaling.offer).toHaveBeenCalledWith(expect.stringContaining('a=fingerprint'));
    expect(connection.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER' });
    // A primeira (e única até o ready) mensagem do canal de entrada é o token que a API emitiu.
    expect(input.sent[0]).toEqual({
      k: 'auth',
      tok: 'tok-1',
      cs: 0,
      ce: direct.cloudEpoch,
    });
    expect(pointer.sent.filter((m) => m['k'] === 'ptr')).toEqual([]);
  });

  it('shows the cloud until the agent accepts the token', async () => {
    const { direct, connections } = setup();
    direct.start();
    await vi.waitFor(() => expect(connections[0]?.remoteDescription).not.toBeNull());
    connections[0]!.channel('pointer').open();
    connections[0]!.channel('input').open();
    await flush();

    expect(direct.mode()).toBe('cloud');
    expect(direct.canUse()).toBe(false);
  });

  it('falls back silently when the offer fails, and tries again after the backoff', async () => {
    const { direct, connections, signaling } = setup();
    signaling.offer.mockRejectedValueOnce(new HttpErrorResponse({ status: 409 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    direct.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(direct.mode()).toBe('cloud');
    expect(connections).toHaveLength(1);
    expect(connections[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! - 20);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(connections).toHaveLength(2);
    expect(signaling.offer).toHaveBeenCalledTimes(2);
  });

  it('the backoff grows (5, 15, 60 s) and then stays', async () => {
    const { direct, connections, signaling } = setup();
    signaling.offer.mockRejectedValue(new Error('sem rede'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(1);
    for (const [index, wait] of DIRECT_BACKOFF_MS.entries()) {
      await vi.advanceTimersByTimeAsync(wait + 20);
      expect(connections).toHaveLength(index + 2);
    }
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS.at(-1)! + 20);
    expect(connections).toHaveLength(DIRECT_BACKOFF_MS.length + 2);
  });

  it('does not try while the page is hidden, and tries when it shows again', async () => {
    const { direct, connections } = setup();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    direct.start();
    await flush();
    expect(connections).toHaveLength(0);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    direct.stop();
    visibility.mockRestore();
  });

  it('opens later when the agent starts declaring the capability (the status poll)', async () => {
    const { direct, connections, current } = setup(status({ capabilities: [] }));
    direct.start();
    await flush();
    expect(connections).toHaveLength(0);

    current.set(status({ capabilities: [PC_RTC_CAPABILITY] }));
    TestBed.tick();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
  });

  it('closing the screen closes the channel and tells the API, and never retries', async () => {
    const { direct, connections, signaling } = setup();
    const { connection } = await openChannel(direct, connections);
    direct.stop();

    expect(connection.closed).toBe(true);
    expect(direct.mode()).toBe('cloud');
    expect(signaling.close).toHaveBeenCalledWith('s1', false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS.at(-1)! * 2);
    expect(connections).toHaveLength(1);
  });

  it('hiding the page closes the channel with a keepalive close', async () => {
    const { direct, connections, signaling } = setup();
    await openChannel(direct, connections);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(direct.mode()).toBe('cloud');
    expect(signaling.close).toHaveBeenCalledWith('s1', true);
    vi.restoreAllMocks();
    direct.stop();
  });

  it('an account change closes the channel (it was the other account PC)', async () => {
    const { direct, connections } = setup();
    const { connection } = await openChannel(direct, connections);
    TestBed.inject(SessionState).setUser({
      id: 'outra',
      email: 'outra@exemplo.com',
      displayName: 'Outra',
      role: 'owner',
    });
    TestBed.tick();

    expect(connection.closed).toBe(true);
    expect(direct.mode()).toBe('cloud');
  });
});

describe('PcDirect pointer', () => {
  it('sends accumulated totals with a growing sequence number', async () => {
    const { direct, connections } = setup();
    const { pointer } = await openChannel(direct, connections);
    direct.sendPointer(10, 5, 0, 0);
    direct.sendPointer(-3, 0, 0, 120);

    expect(pointer.sent.filter((m) => m['k'] === 'ptr')).toEqual([
      { k: 'ptr', s: 1, x: 10, y: 5, w: 0, h: 0 },
      { k: 'ptr', s: 2, x: 7, y: 5, w: 0, h: 120 },
    ]);
  });

  it('marks a still message as the heartbeat of a held button', async () => {
    const { direct, connections } = setup();
    const { pointer } = await openChannel(direct, connections);
    direct.sendPointer(0, 0, 0, 0);

    expect(pointer.sent.filter((m) => m['k'] === 'ptr')[0]).toEqual({
      k: 'ptr',
      s: 1,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      hb: 1,
    });
  });

  it('repeats the last total once after a pause, so a lost message does not lose the path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { direct, connections } = setup();
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const connection = connections[0]!;
    connection.channel('pointer').open();
    connection.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    connection.channel('input').receive({ k: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    const pointer = connection.channel('pointer');
    direct.sendPointer(4, 0, 0, 0);
    await vi.advanceTimersByTimeAsync(POINTER_TAIL_MS + 5);

    expect(pointer.sent.filter((m) => m['k'] === 'ptr')).toEqual([
      { k: 'ptr', s: 1, x: 4, y: 0, w: 0, h: 0 },
      { k: 'ptr', s: 1, x: 4, y: 0, w: 0, h: 0 },
    ]);
  });

  it('skips a message when the channel buffer is full (the next total covers it)', async () => {
    const { direct, connections } = setup();
    const { pointer } = await openChannel(direct, connections);
    pointer.bufferedAmount = 1_000_000;
    direct.sendPointer(5, 0, 0, 0);
    pointer.bufferedAmount = 0;
    direct.sendPointer(5, 0, 0, 0);

    expect(pointer.sent.filter((m) => m['k'] === 'ptr')).toEqual([
      { k: 'ptr', s: 2, x: 10, y: 0, w: 0, h: 0 },
    ]);
  });

  it('the totals start over with each new channel', async () => {
    const { direct, connections } = setup();
    const first = await openChannel(direct, connections);
    direct.sendPointer(50, 0, 0, 0);
    direct.stop();
    const second = await openChannel(direct, connections, 1);
    direct.sendPointer(1, 0, 0, 0);

    expect(first.pointer.sent.filter((m) => m['k'] === 'ptr')[0]).toMatchObject({ s: 1, x: 50 });
    expect(second.pointer.sent.filter((m) => m['k'] === 'ptr')[0]).toEqual({
      k: 'ptr',
      s: 1,
      x: 1,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});

describe('PcDirect commands', () => {
  it('sends the command with the pointer snapshot and resolves on the agent ack', async () => {
    const { direct, connections } = setup();
    const { input } = await openChannel(direct, connections);
    direct.sendPointer(12, -4, 0, 0);
    const sending = direct.command('pc.click.v1', { button: 'LEFT', action: 'DOWN' });
    const message = input.last('cmd')!;
    expect(message).toMatchObject({
      k: 'cmd',
      t: 'pc.click.v1',
      b: { button: 'LEFT', action: 'DOWN' },
      p: { s: 1, x: 12, y: -4, w: 0, h: 0 },
    });
    expect(typeof message['ts']).toBe('number');

    input.receive({ k: 'ack', i: message['i'], ok: true });
    await expect(sending).resolves.toBeUndefined();
  });

  it.each<[string, number]>([
    ['rate_limited', 429],
    ['invalid_message', 400],
    ['not_allowed', 400],
    ['expired', 504],
    ['failed', 502],
  ])(
    'an agent refusal %s becomes the same error the cloud gives (%i)',
    async (code, httpStatus) => {
      const { direct, connections } = setup();
      const { input } = await openChannel(direct, connections);
      const sending = direct.command('pc.key.v1', { key: 'A' });
      input.receive({ k: 'ack', i: input.last('cmd')!['i'], ok: false, c: code });

      const error = (await sending.catch((e: unknown) => e)) as HttpErrorResponse;
      expect(error).toBeInstanceOf(HttpErrorResponse);
      expect(error.status).toBe(httpStatus);
    },
  );

  it('no ack in time is an uncertain result (504), and the command is not sent again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { direct, connections } = setup();
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const connection = connections[0]!;
    connection.channel('pointer').open();
    connection.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    connection.channel('input').receive({ k: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    const sending = direct.command('pc.text.v1', { text: 'x' });
    const failure = sending.catch((e: unknown) => e);
    // O sinal de vida segue respondido: só o ack deste comando não vem.
    for (let waited = 0; waited < ACK_TIMEOUT_MS; waited += PING_MS) {
      connection.channel('pointer').receive({ k: 'pong', n: -1 });
      await vi.advanceTimersByTimeAsync(PING_MS);
    }

    expect(((await failure) as HttpErrorResponse).status).toBe(504);
    expect(connection.channel('input').sent.filter((m) => m['k'] === 'cmd')).toHaveLength(1);
  });

  it('a channel that closes with commands waiting turns them into uncertain results, not resends', async () => {
    const { direct, connections } = setup();
    const { input, connection } = await openChannel(direct, connections);
    const sending = direct.command('pc.text.v1', { text: 'x' });
    const failure = sending.catch((e: unknown) => e);
    connection.connectionState = 'failed';
    connection.dispatchEvent(new Event('connectionstatechange'));

    expect(((await failure) as HttpErrorResponse).status).toBe(504);
    expect(direct.mode()).toBe('cloud');
    expect(input.sent.filter((m) => m['k'] === 'cmd')).toHaveLength(1);
    await expect(direct.command('pc.text.v1', { text: 'y' })).rejects.toBeInstanceOf(DirectNotSent);
  });

  it('tells the listeners when an open channel drops by itself', async () => {
    const { direct, connections } = setup();
    const lost = vi.fn();
    direct.onLost(lost);
    const { connection } = await openChannel(direct, connections);
    connection.connectionState = 'disconnected';
    connection.dispatchEvent(new Event('connectionstatechange'));

    expect(lost).toHaveBeenCalledTimes(1);
    expect(direct.mode()).toBe('cloud');
  });

  it('an open channel that drops tries again after the first backoff (5 s), not by chance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { direct, connections } = setup();
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const first = connections[0]!;
    first.channel('pointer').open();
    first.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    first.channel('input').receive({ k: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    expect(direct.mode()).toBe('direct');

    first.channel('input').close(); // o canal de entrada cai sozinho
    expect(direct.mode()).toBe('cloud');
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! - 100);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(connections).toHaveLength(2);
  });

  it('does not tell the listeners when the screen closes the channel', async () => {
    const { direct, connections } = setup();
    const lost = vi.fn();
    direct.onLost(lost);
    await openChannel(direct, connections);
    direct.stop();

    expect(lost).not.toHaveBeenCalled();
  });
});

/** Só o relógio de parede é de mentira: o resto (promessas, `waitFor`) segue real. */
function freezeClock(at = 10_000): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

describe('PcDirect cloud hand-over', () => {
  it('only takes over when no cloud request is in flight', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    freezeClock();

    let finish: () => void = () => undefined;
    const request = direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    expect(direct.canUse()).toBe(false);

    finish();
    await request;
    expect(direct.canUse()).toBe(true); // a nuvem respondeu na hora (ida e volta zero): já pode
  });

  it('waits for the cloud to be quiet for one of its round trips before the first use', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    freezeClock();

    let finish: () => void = () => undefined;
    const request = direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    vi.setSystemTime(10_120); // o pedido da nuvem levou 120 ms
    finish();
    await request;

    expect(direct.canUse()).toBe(false); // acabou de responder: o pedido pode ainda estar a caminho do agente
    vi.setSystemTime(10_239);
    expect(direct.canUse()).toBe(false);
    vi.setSystemTime(10_240);
    expect(direct.canUse()).toBe(true);
  });

  it('a new cloud request restarts the quiet period, and a slow one never delays more than the cap', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    freezeClock();

    let finish: () => void = () => undefined;
    const request = direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    vi.setSystemTime(10_000 + 9_000); // um pedido lento (ex.: reconectando)
    finish();
    await request;

    expect(direct.canUse()).toBe(false);
    vi.setSystemTime(10_000 + 9_000 + MAX_CLOUD_IDLE_MS - 1);
    expect(direct.canUse()).toBe(false);
    vi.setSystemTime(10_000 + 9_000 + MAX_CLOUD_IDLE_MS);
    expect(direct.canUse()).toBe(true);
  });

  it('a failed cloud request also stops counting', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    freezeClock();
    const request = direct.trackCloud(Promise.reject(new Error('falhou')));
    await request.catch(() => undefined);
    await flush();

    expect(direct.canUse()).toBe(true);
  });

  it('declares the last cloud sequence it issued (cs) in the auth message and in every command', async () => {
    const { direct, connections } = setup();
    direct.nextCloudSeq();
    direct.nextCloudSeq();
    const { input } = await openChannel(direct, connections);
    expect(input.last('auth')?.['cs']).toBe(2);

    expect(direct.nextCloudSeq()).toBe(3);
    void direct.command('pc.media.v1', { action: 'MUTE' }).catch(() => undefined);
    expect(input.last('cmd')?.['cs']).toBe(3);
    void direct.command('pc.media.v1', { action: 'MUTE' }).catch(() => undefined);
    expect(input.last('cmd')?.['cs']).toBe(3);
  });

  it('draws one epoch per page life: 16 hex digits, the same in the auth and in every command', async () => {
    const { direct, connections } = setup();
    expect(direct.cloudEpoch).toMatch(/^[0-9a-f]{16}$/);
    const { input } = await openChannel(direct, connections);
    expect(input.last('auth')?.['ce']).toBe(direct.cloudEpoch);

    void direct.command('pc.media.v1', { action: 'MUTE' }).catch(() => undefined);
    expect(input.last('cmd')?.['ce']).toBe(direct.cloudEpoch);
  });

  it('a new page (a new service) draws a different epoch, even with the counter back at zero', () => {
    const epochs = new Set(Array.from({ length: 50 }, () => newCloudEpoch()));
    expect(epochs.size).toBe(50);
    for (const epoch of epochs) expect(epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps counting across a renewed channel (the number never goes back)', async () => {
    const { direct, connections } = setup();
    const first = await openChannel(direct, connections);
    direct.nextCloudSeq();
    first.input.receive({ k: 'bye', r: 'lifetime' });
    const second = await openChannel(direct, connections, 1);

    expect(second.input.last('auth')?.['cs']).toBe(1);
    expect(direct.nextCloudSeq()).toBe(2);
  });

  it('with the channel closed nothing can use it, whatever the cloud is doing', () => {
    const { direct } = setup();
    expect(direct.canUse()).toBe(false);
  });
});

describe('PcDirect liveness', () => {
  async function openWithTimers(
    setupResult: ReturnType<typeof setup>,
  ): Promise<{ connection: FakeConnection }> {
    setupResult.direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const connection = setupResult.connections[0]!;
    connection.channel('pointer').open();
    connection.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    connection.channel('input').receive({ k: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    return { connection };
  }

  it('pings once a second and measures the round trip from the pong', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
    const result = setup();
    const { connection } = await openWithTimers(result);
    connection.channel('pointer').respond = false; // daqui o teste responde à mão
    await vi.advanceTimersByTimeAsync(PING_MS + 5);
    const ping = connection.channel('pointer').last('ping')!;
    // O primeiro sinal (n=1) firmou a escala de relógio na abertura; este é o primeiro do ritmo de 1 por segundo.
    expect(ping).toMatchObject({ k: 'ping', n: 2 });
    expect(typeof ping['t']).toBe('number');

    await vi.advanceTimersByTimeAsync(18);
    connection.channel('pointer').receive({ k: 'pong', n: 2, c: true });
    const rtt = result.direct.rtt();
    expect(rtt).toBeGreaterThanOrEqual(18);
    expect(rtt).toBeLessThan(60);
  });

  it('a channel that stops answering is dropped for the cloud, and tried again later', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
    const result = setup();
    const lost = vi.fn();
    result.direct.onLost(lost);
    const { connection } = await openWithTimers(result);
    connection.channel('pointer').respond = false; // o agente parou de responder
    await vi.advanceTimersByTimeAsync(STALL_MS + PING_MS * 2);

    expect(result.direct.mode()).toBe('cloud');
    expect(connection.closed).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(result.signaling.close).toHaveBeenCalledWith('s1', false);
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);
    expect(result.connections.length).toBeGreaterThan(1);
  });
});

// ---- segunda rodada: vida do canal, motivo do fechamento, recuo e relógio --------------------------

const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
};

/** Abre o canal com timers falsos: oferta, canais, `ready` (com a vida) e o relógio firmado pelo agente de mentira. */
async function openWithFakeTimers(
  direct: PcDirect,
  connections: FakeConnection[],
  index = 0,
  life = 600,
) {
  direct.start();
  await vi.advanceTimersByTimeAsync(10);
  const connection = connections[index]!;
  connection.channel('pointer').open();
  connection.channel('input').open();
  await vi.advanceTimersByTimeAsync(10);
  connection.channel('input').receive({ k: 'ready', life });
  await vi.advanceTimersByTimeAsync(10);
  return connection;
}

describe('PcDirect clock and lifetime', () => {
  it('stays on the cloud until the agent says it has the clock scale (the first command is refused without it)', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const connection = connections[0]!;
    connection.channel('pointer').respond = false;
    connection.channel('pointer').open();
    connection.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    connection.channel('input').receive({ k: 'ready', life: 600 });
    await vi.advanceTimersByTimeAsync(500);

    expect(direct.mode()).toBe('cloud');
    expect(direct.canUse()).toBe(false);
    // Os sinais de vida seguem saindo enquanto espera (dois que concordam firmam a escala).
    expect(
      connection.channel('pointer').sent.filter((m) => m['k'] === 'ping').length,
    ).toBeGreaterThan(2);

    // Um `pong` que ainda diz "sem escala" não basta; o que diz "tenho" abre o canal.
    connection.channel('pointer').receive({ k: 'pong', n: 1, c: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(direct.mode()).toBe('cloud');
    connection.channel('pointer').receive({ k: 'pong', n: 2, c: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(direct.mode()).toBe('direct');
  });

  it('gives up on a channel whose agent never gets the clock scale, and tries again later', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    const first = connections[0]!;
    first.channel('pointer').respond = false;
    first.channel('pointer').open();
    first.channel('input').open();
    await vi.advanceTimersByTimeAsync(10);
    first.channel('input').receive({ k: 'ready', life: 600 });
    await vi.advanceTimersByTimeAsync(CLOCK_TIMEOUT_MS + 100);

    expect(direct.mode()).toBe('cloud');
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);
    expect(connections).toHaveLength(2);
  });

  it('opens a new channel before the lifetime ends, with nobody noticing, when nothing is held', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections, signaling } = setup();
    const lost = vi.fn();
    direct.onLost(lost);
    const first = await openWithFakeTimers(direct, connections, 0, 50); // a vida é de 50 s: renova aos 20 s
    expect(direct.mode()).toBe('direct');

    await vi.advanceTimersByTimeAsync(19_000);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(first.closed).toBe(true);
    expect(signaling.close).toHaveBeenCalledWith('s1', false);
    expect(connections).toHaveLength(2);
    expect(lost).not.toHaveBeenCalled(); // renovar não é perder: nada foi segurado nem solto
  });

  it('waits for what is held to be released before it renews the channel', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    let held = true;
    direct.setBusyProbe(() => held);
    await openWithFakeTimers(direct, connections, 0, 50);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(connections).toHaveLength(1);
    expect(direct.mode()).toBe('direct');

    held = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connections).toHaveLength(2);
  });

  it.each(['replaced', 'revoked'])(
    'after the agent says %s the channel is not retried by itself, only when the screen opens again',
    async (reason) => {
      vi.useFakeTimers(FAKE_TIMERS);
      const { direct, connections } = setup();
      const lost = vi.fn();
      direct.onLost(lost);
      const first = await openWithFakeTimers(direct, connections);
      first.channel('input').receive({ k: 'bye', r: reason });
      await vi.advanceTimersByTimeAsync(10);

      expect(direct.mode()).toBe('cloud');
      expect(lost).toHaveBeenCalledTimes(1); // a tela alinha o estado: o agente já soltou o que segurava
      await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS.at(-1)! * 3);
      expect(connections).toHaveLength(1);

      direct.start(); // a próxima visita à tela
      await vi.advanceTimersByTimeAsync(10);
      expect(connections).toHaveLength(2);
    },
  );

  it('a send that throws with the channel still open hands the input back to the cloud until it is done', async () => {
    const { direct, connections } = setup();
    const { input } = await openChannel(direct, connections);
    expect(direct.canUse()).toBe(true); // a primeira entrada: o canal assumiu

    input.send = () => {
      throw new Error('o canal fechou agora');
    };
    await expect(direct.command('pc.media.v1', { action: 'MUTE' })).rejects.toBeInstanceOf(
      DirectNotSent,
    );
    // Antes de o pedido da nuvem entrar em voo (passos assíncronos de quem chama), o canal também não pode ser readotado.
    expect(direct.canUse()).toBe(false);
    // Quem chama recua para a nuvem: o pedido dela está em voo, e o próximo comando NÃO pode passar por ela na frente.
    let finish: () => void = () => undefined;
    const cloud = direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    expect(direct.canUse()).toBe(false);

    finish();
    await cloud;
  });

  it('a 409 pc-direct-revoked on the offer suspends the channel: no backoff retry, back on the next screen visit', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections, signaling } = setup();
    signaling.offer.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { type: 'https://uniover.app/problems/pc-direct-revoked' },
      }),
    );
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS.at(-1)! * 3);
    expect(connections).toHaveLength(1);

    direct.start(); // a próxima visita à tela
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);
  });

  it('a revoked suspension also ends when the access token is renewed', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections, signaling } = setup();
    const session = TestBed.inject(SessionState);
    session.setToken('token-1', 600, 1_000);
    signaling.offer.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { type: 'https://uniover.app/problems/pc-direct-revoked' },
      }),
    );
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS.at(-1)! * 2);
    expect(connections).toHaveLength(1);

    session.setToken('token-2', 600, 2_000_000); // o refresh trouxe outro token de acesso
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);
  });

  it('any other 409 on the offer keeps the generic retry with backoff', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections, signaling } = setup();
    signaling.offer.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { type: 'https://uniover.app/problems/pc-direct-unavailable' },
      }),
    );
    direct.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);

    expect(connections).toHaveLength(2);
  });

  it('opens another channel at once when the agent says the lifetime is over', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    const first = await openWithFakeTimers(direct, connections);
    first.channel('input').receive({ k: 'bye', r: 'lifetime' });
    await vi.advanceTimersByTimeAsync(10);

    expect(connections).toHaveLength(2);
  });

  it('follows the backoff after the other reasons (the cloud closed it, idle...)', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    const first = await openWithFakeTimers(direct, connections);
    first.channel('input').receive({ k: 'bye', r: 'cloud' });
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! - 100);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);

    expect(connections).toHaveLength(2);
  });

  it('the backoff grows when the channel keeps dropping soon after it opens (two devices fighting)', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    const first = await openWithFakeTimers(direct, connections);
    first.channel('input').receive({ k: 'bye', r: 'cloud' }); // caiu logo: 5 s
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);
    expect(connections).toHaveLength(2);
    const second = await openWithFakeTimers(direct, connections, 1);
    second.channel('input').receive({ k: 'bye', r: 'cloud' }); // caiu logo de novo: agora 15 s, não 5

    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 500);
    expect(connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[1]!);
    expect(connections).toHaveLength(3);
  });

  it('a channel that lasted a while and then drops starts the backoff over', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { direct, connections } = setup();
    const first = await openWithFakeTimers(direct, connections);
    first.channel('input').receive({ k: 'bye', r: 'cloud' });
    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);
    const second = await openWithFakeTimers(direct, connections, 1);
    await vi.advanceTimersByTimeAsync(STABLE_MS + 1_000); // o agente de mentira responde aos sinais de vida
    second.channel('input').receive({ k: 'bye', r: 'cloud' });

    await vi.advanceTimersByTimeAsync(DIRECT_BACKOFF_MS[0]! + 50);
    expect(connections).toHaveLength(3);
  });

  it('after the first command the channel keeps every input, even with the cloud busy with something else', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    expect(direct.canUse()).toBe(true); // a nuvem sem nada em voo: o canal assume (primeiro uso)

    let finish: () => void = () => undefined;
    void direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    // Energia ou favorito pela nuvem não tiram o canal da entrada (o agente só fecha o canal por entrada da nuvem).
    expect(direct.canUse()).toBe(true);
    finish();
  });

  it('the first use waits for the cloud to settle, and then it never mixes again', async () => {
    const { direct, connections } = setup();
    await openChannel(direct, connections);
    // (openChannel não chamou canUse: ainda não houve primeiro uso)
    freezeClock();
    let finish: () => void = () => undefined;
    const request = direct.trackCloud(new Promise<void>((resolve) => (finish = resolve)));
    expect(direct.canUse()).toBe(false);
    finish();
    await request;
    expect(direct.canUse()).toBe(true);
    void direct.trackCloud(new Promise<void>(() => undefined));
    expect(direct.canUse()).toBe(true);
  });
});
