import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subscription } from 'rxjs';
import { AuthApi } from '../auth/auth-api';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../session/session-state';
import { EVENT_SOURCE_FACTORY, StreamEvent, StreamService } from './stream.service';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data = ''): void {
    const event = Object.assign(new Event(type), { data, lastEventId: '7' });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('StreamService', () => {
  const status = signal<SessionStatus>('authenticated');
  const streamTicket = vi.fn();
  const sources = () => FakeEventSource.instances;
  const latest = () => sources().at(-1)!;
  let subscription: Subscription | undefined;
  let events: StreamEvent[];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    FakeEventSource.instances = [];
    events = [];
    status.set('authenticated');
    streamTicket.mockReset().mockResolvedValue({ expiresIn: 120 });
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthApi, useValue: { streamTicket } },
        {
          provide: AuthService,
          useValue: {
            status,
            authorized: (call: (token: string) => Promise<unknown>) => call('jwt-secreto'),
          },
        },
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => new FakeEventSource(url) as unknown as EventSource,
        },
      ],
    });
  });

  afterEach(() => {
    subscription?.unsubscribe();
    vi.useRealTimers();
  });

  const open = async (path = '/api/v1/devices/stream', types?: string[]) => {
    subscription = TestBed.inject(StreamService)
      .open(path, types)
      .subscribe((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(0);
  };
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('asks for a ticket first and opens the EventSource on the plain path, with no token in the URL', async () => {
    await open();
    expect(streamTicket).toHaveBeenCalledWith('jwt-secreto');
    expect(sources()).toHaveLength(1);
    expect(latest().url).toBe('/api/v1/devices/stream');
    for (const source of sources()) {
      expect(source.url).not.toContain('jwt-secreto');
      expect(source.url).not.toContain('?');
    }
  });

  it('rejects a path that carries a token', () => {
    const service = TestBed.inject(StreamService);
    expect(() => service.open('/api/v1/stream?token=abc')).toThrow();
    expect(() => service.open('/api/v1/stream?x=1&access_token=abc')).toThrow();
    expect(() => service.open('https://outro.com/stream')).toThrow();
  });

  it('exposes the named events', async () => {
    await open('/api/v1/devices/stream', ['message', 'agent.state']);
    latest().emit('message', 'um');
    latest().emit('agent.state', '{"online":true}');
    expect(events).toEqual([
      { type: 'message', data: 'um', lastEventId: '7' },
      { type: 'agent.state', data: '{"online":true}', lastEventId: '7' },
    ]);
  });

  it('on error closes and retries with a fresh ticket after 1, 2, 4 ... up to 30 s', async () => {
    await open();
    const waits: number[] = [];
    let previous = Date.now();
    for (let i = 0; i < 7; i++) {
      const count = streamTicket.mock.calls.length;
      latest().emit('error');
      expect(latest().closed).toBe(true);
      while (streamTicket.mock.calls.length === count) {
        await vi.advanceTimersByTimeAsync(500);
      }
      waits.push(Math.round((Date.now() - previous) / 500) * 500);
      previous = Date.now();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(sources().length).toBe(8);
  });

  it('a successful open resets the backoff', async () => {
    await open();
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(1_000);
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sources()).toHaveLength(3);
    latest().emit('open');
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources()).toHaveLength(4);
  });

  it('retries with backoff when the ticket cannot be obtained', async () => {
    streamTicket.mockRejectedValueOnce(new Error('rede')).mockResolvedValue({ expiresIn: 120 });
    await open();
    expect(sources()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources()).toHaveLength(1);
  });

  it('reopens proactively at 9 minutes with a new ticket', async () => {
    await open();
    const first = latest();
    await vi.advanceTimersByTimeAsync(9 * 60_000 - 1);
    expect(sources()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(sources()).toHaveLength(2);
    expect(streamTicket).toHaveBeenCalledTimes(2);
  });

  it('closes after 2 minutes hidden and reopens when the tab is visible again', async () => {
    await open();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(latest().closed).toBe(true);
    expect(sources()).toHaveLength(1);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(sources()).toHaveLength(2);
    expect(latest().closed).toBe(false);
  });

  it('keeps the connection when the tab is hidden for less than 2 minutes', async () => {
    await open();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sources()).toHaveLength(1);
    expect(latest().closed).toBe(false);
  });

  it('closes when the session ends and reopens when it comes back', async () => {
    await open();
    status.set('anonymous');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources()).toHaveLength(1);

    status.set('authenticated');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(sources()).toHaveLength(2);
    expect(latest().closed).toBe(false);
  });

  it('does not even ask for a ticket while there is no session', async () => {
    status.set('anonymous');
    await open();
    expect(streamTicket).not.toHaveBeenCalled();
    expect(sources()).toHaveLength(0);
  });

  it('coming back online wakes a connection that is waiting to retry', async () => {
    await open();
    for (let i = 0; i < 3; i++) {
      latest().emit('error');
      await vi.advanceTimersByTimeAsync(0);
    }
    const before = sources().length;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sources().length).toBe(before + 1);
  });

  it('unsubscribing closes the connection and cancels every timer', async () => {
    await open();
    const source = latest();
    subscription?.unsubscribe();
    expect(source.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(sources()).toHaveLength(1);
  });
});
