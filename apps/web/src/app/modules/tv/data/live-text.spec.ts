import { LiveTextSync } from './live-text';
import { TvFailure } from './tv-errors';
import { isValidTvText } from './tv-store';

const DEBOUNCE = 250;

interface Deferred {
  readonly text: string;
  resolve(failure?: TvFailure | null): void;
}

describe('LiveTextSync', () => {
  let calls: Deferred[];
  let sync: LiveTextSync;

  const failure = (
    kind: TvFailure['kind'],
    retryAfterSeconds: number | null = null,
  ): TvFailure => ({ kind, message: kind, retryAfterSeconds });
  const sentTexts = () => calls.map((call) => call.text);
  /** Deixa o envio (por padrão o mais recente) terminar. */
  const finish = async (result: TvFailure | null = null, index = calls.length - 1) => {
    calls[index].resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  const type = (text: string) => sync.change(text);
  const pause = (ms = DEBOUNCE) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 19, 14, 30));
    calls = [];
    sync = new LiveTextSync({
      debounceMs: DEBOUNCE,
      sender: {
        isValid: isValidTvText,
        send: (text) =>
          new Promise<TvFailure | null>((resolve) => {
            calls.push({ text, resolve: (result = null) => resolve(result) });
          }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a pause in typing and then sends the whole text, once', async () => {
    type('b');
    await pause(100);
    type('ba');
    await pause(100);
    type('bat');
    await pause(DEBOUNCE - 1);
    expect(calls).toHaveLength(0);
    await pause(1);
    expect(sentTexts()).toEqual(['bat']);
    expect(sync.status()).toBe('sending');
    await finish();
    expect(sync.status()).toBe('sent');
    expect(sync.failure()).toBeNull();
  });

  it('has only one request in flight and sends just the latest text afterwards', async () => {
    type('a');
    await pause();
    expect(sentTexts()).toEqual(['a']);

    // Muda três vezes enquanto o primeiro ainda não voltou: nenhum envio novo.
    type('ab');
    await pause();
    type('abc');
    await pause();
    type('abcd');
    await pause();
    expect(sentTexts()).toEqual(['a']);

    await finish();
    // Só o valor mais recente vai, sem passar por 'ab' nem 'abc'.
    expect(sentTexts()).toEqual(['a', 'abcd']);
    expect(sync.status()).toBe('sending');
    await finish();
    expect(sync.status()).toBe('sent');
    expect(calls).toHaveLength(2);
  });

  it('a change that arrives while sending, before its own pause, goes out once by the pause', async () => {
    type('a');
    await pause();
    type('ab');
    await finish();
    expect(sentTexts()).toEqual(['a']);
    await pause();
    expect(sentTexts()).toEqual(['a', 'ab']);
  });

  it('does not resend what the TV already has', async () => {
    type('batman');
    await pause();
    await finish();
    type('batmanx');
    type('batman');
    await pause();
    expect(sentTexts()).toEqual(['batman']);
  });

  it('never sends empty or invalid text and does not touch what was sent', async () => {
    type('batman');
    await pause();
    await finish();
    type('');
    await pause(1000);
    type('a\nb');
    await pause(1000);
    type('a'.repeat(201));
    await pause(1000);
    expect(sentTexts()).toEqual(['batman']);
  });

  it('stops a pending send when the text becomes empty before the pause', async () => {
    type('abc');
    await pause(100);
    type('');
    await pause(1000);
    expect(calls).toHaveLength(0);
  });

  it('accepts exactly 200 characters, counting an emoji as one', async () => {
    type('😀'.repeat(200));
    await pause();
    expect(calls).toHaveLength(1);
  });

  it('keeps the text and tries again on the next change after a failure, with no loop', async () => {
    type('bat');
    await pause();
    await finish(failure('network'));
    expect(sync.status()).toBe('error');
    expect(sync.failure()?.kind).toBe('network');
    // Nada de novo sozinho.
    await pause(10_000);
    expect(sentTexts()).toEqual(['bat']);

    type('batm');
    await pause();
    expect(sentTexts()).toEqual(['bat', 'batm']);
    await finish();
    expect(sync.status()).toBe('sent');
    expect(sync.failure()).toBeNull();
  });

  it('sends the same text again after a failure if the next change comes back to it', async () => {
    type('bat');
    await pause();
    await finish(failure('timeout'));
    type('batx');
    type('bat');
    await pause();
    expect(sentTexts()).toEqual(['bat', 'bat']);
  });

  it('waits for the Retry-After after a rate limit before the next try', async () => {
    type('bat');
    await pause();
    await finish(failure('rate-limited', 7));
    type('batm');
    await pause();
    expect(sentTexts()).toEqual(['bat']);
    await pause(6_000);
    expect(sentTexts()).toEqual(['bat']);
    await pause(1_000);
    expect(sentTexts()).toEqual(['bat', 'batm']);
  });

  it('a value queued behind a rate-limited request is also held by the Retry-After', async () => {
    type('a');
    await pause();
    type('ab');
    await pause();
    await finish(failure('rate-limited', 5));
    expect(sentTexts()).toEqual(['a']);
    await pause(5_000);
    expect(sentTexts()).toEqual(['a', 'ab']);
  });

  it('flush sends the pending text now and keeps the one-in-flight rule', async () => {
    type('abc');
    sync.flush();
    expect(sentTexts()).toEqual(['abc']);
    type('abcd');
    sync.flush();
    expect(sentTexts()).toEqual(['abc']);
    await finish();
    expect(sentTexts()).toEqual(['abc', 'abcd']);
  });

  it('flush with nothing new, or with empty text, sends nothing', async () => {
    sync.flush();
    type('abc');
    await pause();
    await finish();
    sync.flush();
    type('');
    sync.flush();
    expect(sentTexts()).toEqual(['abc']);
  });

  it('reset forgets what was pending and what was sent, so the same text can go again', async () => {
    type('abc');
    await pause();
    await finish();
    type('abcd');
    sync.reset();
    await pause(1000);
    expect(sentTexts()).toEqual(['abc']);
    expect(sync.status()).toBe('idle');

    type('abc');
    await pause();
    expect(sentTexts()).toEqual(['abc', 'abc']);
  });

  it('ignores the answer of a request that was already in flight when reset was called', async () => {
    type('abc');
    await pause();
    sync.reset();
    await finish(failure('network'));
    expect(sync.status()).toBe('idle');
    expect(sync.failure()).toBeNull();
  });

  it('turns an unexpected throw into an error status instead of an unhandled rejection', async () => {
    const throwing = new LiveTextSync({
      debounceMs: DEBOUNCE,
      sender: { isValid: isValidTvText, send: () => Promise.reject(new Error('boom')) },
    });
    throwing.change('abc');
    await pause();
    expect(throwing.status()).toBe('error');
  });

  it('typing again after "sent" drops the status back to idle', async () => {
    type('abc');
    await pause();
    await finish();
    expect(sync.status()).toBe('sent');
    type('abcd');
    expect(sync.status()).toBe('idle');
  });

  it.each([
    ['empty', ''],
    ['over 200 characters', 'a'.repeat(201)],
  ])(
    'does not stay on "sending" when the field becomes %s during the request',
    async (_name, next) => {
      type('abc');
      await pause();
      expect(sync.status()).toBe('sending');
      type(next);
      await finish();
      expect(sync.status()).toBe('idle');
      await pause(2000);
      expect(sentTexts()).toEqual(['abc']);
    },
  );

  it('goes back to "sending" by itself when the changed text still has to be sent', async () => {
    type('a');
    await pause();
    type('ab');
    await finish();
    expect(sync.status()).toBe('idle');
    await pause();
    expect(sync.status()).toBe('sending');
  });
});
