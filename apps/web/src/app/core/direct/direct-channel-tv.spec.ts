import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PcAvailability, type PcStatus } from '../modules/pc-availability';
import {
  DIRECT_TV_MAX_RTT_MS,
  DirectChannel,
  DirectNotSent,
  DirectRetryCloud,
  DirectSignaling,
  PC_RTC_CAPABILITY,
  PC_RTC_FACTORY,
  type DirectOfferRequest,
  type DirectScope,
  type DirectTvTarget,
} from './direct-channel';

/** Um canal de dados de mentira: guarda o que se manda e deixa o teste abrir, fechar e responder. */
class FakeChannel extends EventTarget {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  constructor(readonly label: string) {
    super();
  }
  send(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(message);
    if (this.label === 'pointer' && message['k'] === 'ping') {
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
  createDataChannel(label: string) {
    const channel = new FakeChannel(label);
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

const TV_MESSAGES = ['tv.key.v3', 'tv.text.v1'];

const pcStatus = (overrides: Partial<PcStatus> = {}): PcStatus => ({
  available: true,
  online: true,
  apps: [],
  capabilities: [PC_RTC_CAPABILITY],
  volume: null,
  ...overrides,
});

const tvTarget = (overrides: Partial<DirectTvTarget> = {}): DirectTvTarget => ({
  tvId: 'tv-1',
  usable: true,
  live: true,
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(initialPc: PcStatus | null = null) {
  const pc = signal<PcStatus | null>(initialPc);
  const connections: FakeConnection[] = [];
  const signaling = {
    // A API concede o que foi pedido (o que não couber, o teste troca com `mockImplementationOnce`).
    offer: vi.fn((_sdp: string, request: DirectOfferRequest) =>
      Promise.resolve({
        sessionId: `s${connections.length}`,
        sdp: 'ANSWER',
        token: `tok-${connections.length}`,
        scopes: [...request.scopes] as DirectScope[],
      }),
    ),
    close: vi.fn(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: { status: pc.asReadonly() } },
      { provide: DirectSignaling, useValue: signaling },
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
  return { channel: TestBed.inject(DirectChannel), signaling, connections, pc };
}

/** Termina de abrir o canal que está negociando: os dois canais de dados abertos e o `ready` do agente (com as mensagens da TV, se quiser). */
async function finishOpening(
  channel: DirectChannel,
  connections: FakeConnection[],
  index: number,
  ready: Record<string, unknown> = { k: 'ready', life: 600, caps: TV_MESSAGES, sc: ['tv'] },
) {
  await vi.waitFor(() => expect(connections[index]?.remoteDescription).not.toBeNull());
  const connection = connections[index]!;
  connection.channel('pointer').open();
  connection.channel('input').open();
  await vi.waitFor(() => expect(connection.channel('input').last('auth')).toBeDefined());
  connection.channel('input').receive(ready);
  await vi.waitFor(() => expect(channel.mode()).toBe('direct'));
  return { connection, pointer: connection.channel('pointer'), input: connection.channel('input') };
}

async function openForTv(
  channel: DirectChannel,
  connections: FakeConnection[],
  target: DirectTvTarget = tvTarget(),
) {
  channel.setTvTarget(target);
  channel.start('tv');
  await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
  return finishOpening(channel, connections, 0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DirectChannel scopes', () => {
  it('opens for the TV alone, asking only for the tv scope and the chosen TV', async () => {
    const { channel, signaling, connections } = setup();
    await openForTv(channel, connections);

    expect(signaling.offer).toHaveBeenCalledWith(expect.stringContaining('a=fingerprint'), {
      scopes: ['tv'],
      tvId: 'tv-1',
    });
    expect(channel.scopes()).toEqual(['tv']);
  });

  it('keeps the offer of the PC alone as it always was', async () => {
    const { channel, signaling, connections } = setup(pcStatus());
    channel.start('pc');
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    await finishOpening(channel, connections, 0, { k: 'ready', life: 600, caps: [], sc: ['pc'] });

    expect(signaling.offer).toHaveBeenCalledWith(expect.any(String), { scopes: ['pc'], tvId: null });
  });

  it('asks for both scopes when both screens want the channel at the moment it opens', async () => {
    const { channel, signaling, connections, pc } = setup();
    channel.start('pc');
    channel.start('tv');
    await flush();
    expect(signaling.offer).not.toHaveBeenCalled();

    // O computador conecta e a TV fica usável ao mesmo tempo: um canal só, com os dois escopos.
    pc.set(pcStatus());
    channel.setTvTarget(tvTarget());
    await vi.waitFor(() => expect(signaling.offer).toHaveBeenCalled());

    expect(signaling.offer.mock.calls[0]![1]).toEqual({ scopes: ['pc', 'tv'], tvId: 'tv-1' });
    expect(connections).toHaveLength(1);
  });

  it('does not open for the TV when the TV is not usable, and opens when it becomes usable', async () => {
    const { channel, signaling, connections } = setup();
    channel.setTvTarget(tvTarget({ usable: false }));
    channel.start('tv');
    await flush();

    expect(signaling.offer).not.toHaveBeenCalled();

    channel.setTvTarget(tvTarget());
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    expect(signaling.offer).toHaveBeenCalledTimes(1);
  });

  it('reopens with the union when the PC screen opens over a channel that was only for the TV', async () => {
    const { channel, signaling, connections, pc } = setup();
    await openForTv(channel, connections);

    pc.set(pcStatus());
    channel.start('pc');
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    expect(connections[0]!.closed).toBe(true);
    expect(signaling.offer.mock.calls[1]![1]).toEqual({ scopes: ['pc', 'tv'], tvId: 'tv-1' });
  });

  it('does not reopen in a loop when the API granted less than it was asked', async () => {
    const { channel, signaling, connections, pc } = setup();
    signaling.offer.mockImplementationOnce(() =>
      Promise.resolve({ sessionId: 's0', sdp: 'ANSWER', token: 'tok-0', scopes: ['pc' as const] }),
    );
    channel.start('pc');
    channel.start('tv');
    pc.set(pcStatus());
    channel.setTvTarget(tvTarget());
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    await finishOpening(channel, connections, 0, { k: 'ready', life: 600, caps: [], sc: ['pc'] });
    await flush();
    await flush();

    expect(connections).toHaveLength(1);
    expect(channel.scopes()).toEqual(['pc']);
    expect(channel.canUseTv()).toBe(false);
  });

  it('reopens when the screen moves to another TV, and the old channel never carries the new TV', async () => {
    const { channel, signaling, connections } = setup();
    await openForTv(channel, connections);
    expect(channel.canUseTv()).toBe(true);

    channel.setTvTarget(tvTarget({ tvId: 'tv-2' }));
    expect(channel.canUseTv()).toBe(false);
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    expect(signaling.offer.mock.calls[1]![1]).toEqual({ scopes: ['tv'], tvId: 'tv-2' });
  });

  it('closes only when nobody wants the channel any more', async () => {
    const { channel, connections, pc } = setup();
    channel.start('pc');
    channel.start('tv');
    pc.set(pcStatus());
    channel.setTvTarget(tvTarget());
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    await finishOpening(channel, connections, 0, {
      k: 'ready',
      life: 600,
      caps: TV_MESSAGES,
      sc: ['pc', 'tv'],
    });

    channel.stop('tv');
    await flush();
    expect(channel.mode()).toBe('direct');

    channel.stop('pc');
    await flush();
    expect(channel.mode()).toBe('cloud');
    expect(connections[0]!.closed).toBe(true);
  });
});

describe('DirectChannel TV commands', () => {
  it('sends a key as the same cmd message of the PC, without the pointer total, and resolves on the ack', async () => {
    const { channel, connections } = setup();
    const { input } = await openForTv(channel, connections);

    const sending = channel.command('tv.key.v3', { key: 'RIGHT' });
    const message = input.last('cmd')!;
    expect(message).toMatchObject({ k: 'cmd', t: 'tv.key.v3', b: { key: 'RIGHT' } });
    expect(message['p']).toBeUndefined();
    expect(typeof message['ts']).toBe('number');
    input.receive({ k: 'ack', i: message['i'], ok: true });

    await expect(sending).resolves.toBeUndefined();
  });

  it('turns the refusal of the agent into the error shape of the cloud', async () => {
    const { channel, connections } = setup();
    const { input } = await openForTv(channel, connections);

    const sending = channel.command('tv.key.v3', { key: 'OK' });
    input.receive({ k: 'ack', i: input.last('cmd')!['i'], ok: false, c: 'TV_UNREACHABLE' });

    await expect(sending).rejects.toMatchObject({ status: 502, error: { agentError: 'TV_UNREACHABLE' } });
  });

  it.each(['busy', 'rate_limited'])(
    'asks for the cloud when the agent refused the key before delivering it (%s)',
    async (code) => {
      const { channel, connections } = setup();
      const { input } = await openForTv(channel, connections);

      const sending = channel.command('tv.key.v3', { key: 'OK' });
      input.receive({ k: 'ack', i: input.last('cmd')!['i'], ok: false, c: code });

      await expect(sending).rejects.toBeInstanceOf(DirectRetryCloud);
    },
  );

  it('keeps a failure after the delivery as the error of the cloud, never as a retry', async () => {
    const { channel, connections } = setup();
    const { input } = await openForTv(channel, connections);

    const sending = channel.command('tv.text.v1', { text: 'a' });
    input.receive({ k: 'ack', i: input.last('cmd')!['i'], ok: false, c: 'failed' });

    const error = await sending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DirectRetryCloud);
    expect(error).toMatchObject({ status: 502 });
  });

  it('lists the TV messages from the ready of the agent: an agent that did not list them gets nothing', async () => {
    const { channel, connections } = setup();
    channel.setTvTarget(tvTarget());
    channel.start('tv');
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    await finishOpening(channel, connections, 0, { k: 'ready', life: 600, sc: ['tv'] });

    expect(channel.accepts('tv.key.v3')).toBe(false);
    expect(channel.accepts('tv.text.v1')).toBe(false);
  });

  it('accepts the TV messages the agent listed', async () => {
    const { channel, connections } = setup();
    await openForTv(channel, connections);

    expect(channel.accepts('tv.key.v3')).toBe(true);
    expect(channel.accepts('tv.text.v1')).toBe(true);
  });

  it('only carries the TV with the session of the TV open', async () => {
    const { channel, connections } = setup();
    await openForTv(channel, connections);
    expect(channel.canUseTv()).toBe(true);

    channel.setTvTarget(tvTarget({ live: false }));
    expect(channel.canUseTv()).toBe(false);

    channel.setTvTarget(tvTarget({ live: true }));
    expect(channel.canUseTv()).toBe(true);
  });

  it('leaves the TV to the cloud while a request of the TV is in flight, and takes it back after', async () => {
    const { channel, connections } = setup();
    await openForTv(channel, connections);

    let finish: (value: string) => void = () => undefined;
    const inFlight = channel.trackTvCloud(new Promise<string>((resolve) => (finish = resolve)));
    expect(channel.canUseTv()).toBe(false);

    finish('ok');
    await inFlight;
    expect(channel.canUseTv()).toBe(true);
  });

  it('leaves the TV to the cloud when the channel is slower than the cloud floor', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    const { channel, connections } = setup();
    channel.setTvTarget(tvTarget());
    channel.start('tv');
    await vi.advanceTimersByTimeAsync(10);
    const { pointer } = await finishOpening(channel, connections, 0);

    // O agente demora a responder o sinal de vida: a ida e volta medida passa do piso da nuvem.
    pointer.send = (text: string) => {
      const ping = JSON.parse(text) as Record<string, unknown>;
      setTimeout(
        () => pointer.receive({ k: 'pong', n: ping['n'], c: true }),
        DIRECT_TV_MAX_RTT_MS + 100,
      );
    };
    await vi.advanceTimersByTimeAsync(3_000);

    expect(channel.rtt()).toBeGreaterThan(DIRECT_TV_MAX_RTT_MS);
    expect(channel.canUseTv()).toBe(false);
  });

  it('never sends when the channel is not open: nothing leaves and the caller goes to the cloud', async () => {
    const { channel } = setup();

    await expect(channel.command('tv.key.v3', { key: 'UP' })).rejects.toBeInstanceOf(DirectNotSent);
    expect(channel.canUseTv()).toBe(false);
  });

  it('marks an unanswered key as uncertain when the channel drops, never to be resent', async () => {
    const { channel, connections } = setup();
    const { input } = await openForTv(channel, connections);

    const sending = channel.command('tv.key.v3', { key: 'UP' });
    input.close();

    await expect(sending).rejects.toBeInstanceOf(HttpErrorResponse);
    await expect(sending).rejects.toMatchObject({ status: 504 });
  });
});

describe('DirectChannel scopes protect the agent from messages it would refuse', () => {
  it('never sends the PC over a channel that only carries the TV (each message would be a violation)', async () => {
    const { channel, connections } = setup();
    const { input, pointer } = await openForTv(channel, connections);

    expect(channel.canUse()).toBe(false);
    await expect(channel.command('pc.key.v1', { key: 'A' })).rejects.toBeInstanceOf(DirectNotSent);
    expect(() => channel.sendPointer(5, 5, 0, 0)).toThrow(DirectNotSent);
    expect(input.last('cmd')).toBeUndefined();
    expect(pointer.sent.filter((message) => message['k'] === 'ptr')).toEqual([]);
  });

  it('never sends the TV over a channel that only carries the PC', async () => {
    const { channel, connections } = setup(pcStatus());
    channel.start('pc');
    await vi.waitFor(() => expect(connections[0]?.channels).toHaveLength(2));
    const { input } = await finishOpening(channel, connections, 0, {
      k: 'ready',
      life: 600,
      caps: [],
      sc: ['pc'],
    });

    await expect(channel.command('tv.key.v3', { key: 'UP' })).rejects.toBeInstanceOf(DirectNotSent);
    expect(input.last('cmd')).toBeUndefined();
    expect(channel.canUse()).toBe(true);
  });
});

describe('DirectChannel closing for access reasons', () => {
  it('reopens at once when the agent says rescoped (a scope was lost, not the whole access)', async () => {
    const { channel, connections, signaling } = setup();
    const { input } = await openForTv(channel, connections);

    input.receive({ k: 'bye', r: 'rescoped' });
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    expect(signaling.offer).toHaveBeenCalledTimes(2);
  });

  it('does not try again by itself after revoked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { channel, connections } = setup();
    channel.setTvTarget(tvTarget());
    channel.start('tv');
    await vi.advanceTimersByTimeAsync(10);
    const { input } = await finishOpening(channel, connections, 0);

    input.receive({ k: 'bye', r: 'revoked' });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(connections).toHaveLength(1);
  });

  it('does not try again when the API says the person cannot use the channel (403)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { channel, signaling, connections } = setup();
    signaling.offer.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 403,
        error: { type: 'https://uniover.dev/problems/pc-direct-forbidden' },
      }),
    );
    channel.setTvTarget(tvTarget());
    channel.start('tv');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(signaling.offer).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
    expect(channel.mode()).toBe('cloud');
  });

  it('keeps going through the ordinary backoff when the computer is busy with another person (409)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { channel, signaling } = setup();
    signaling.offer.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { type: 'https://uniover.dev/problems/pc-direct-busy' },
      }),
    );
    channel.setTvTarget(tvTarget());
    channel.start('tv');
    await vi.advanceTimersByTimeAsync(10);
    expect(signaling.offer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(signaling.offer).toHaveBeenCalledTimes(2);
  });
});
