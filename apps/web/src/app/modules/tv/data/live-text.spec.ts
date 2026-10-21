import { LiveTextOptions, LiveTextSync } from './live-text';
import { TvFailure } from './tv-errors';
import { isValidTvText } from './tv-store';

const TAIL = 100;
const MAX_REQUESTS = 40;
const WINDOW = 10_000;

interface Deferred {
  readonly text: string;
  readonly at: number;
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
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  /** Um sender que fica pendurado até o teste mandar terminar. */
  const pending = (): LiveTextOptions['sender'] => ({
    isValid: isValidTvText,
    send: (text) =>
      new Promise<TvFailure | null>((resolve) => {
        calls.push({ text, at: Date.now(), resolve: (result = null) => resolve(result) });
      }),
  });
  const make = (overrides: Partial<LiveTextOptions> = {}) =>
    new LiveTextSync({
      tailMs: TAIL,
      maxRequests: MAX_REQUESTS,
      windowMs: WINDOW,
      sender: pending(),
      ...overrides,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 19, 14, 30));
    calls = [];
    sync = make();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('first change goes right away, then the tail gathers the rest', () => {
    it('sends the first change of a burst at once, with no pause', () => {
      type('b');
      expect(sentTexts()).toEqual(['b']);
      expect(sync.status()).toBe('sending');
    });

    it('sends the first change at once even after a long idle time', async () => {
      type('b');
      await finish();
      await wait(60_000);
      type('ba');
      expect(sentTexts()).toEqual(['b', 'ba']);
    });

    it('gathers what is typed during the tail into one send with the newest text', async () => {
      type('b');
      await finish();
      await wait(10);
      type('ba');
      await wait(30);
      type('bat');
      await wait(30);
      type('batm');
      // Ainda dentro da cauda (100 ms desde o início do primeiro envio): nada novo.
      expect(sentTexts()).toEqual(['b']);
      await wait(TAIL);
      expect(sentTexts()).toEqual(['b', 'batm']);
    });

    it('never starts two sends closer than the tail', async () => {
      type('a');
      await finish();
      type('ab');
      await wait(TAIL - 1);
      expect(sentTexts()).toEqual(['a']);
      await wait(1);
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('does not push the tail back while typing goes on', async () => {
      type('a');
      await finish();
      // Uma letra a cada 40 ms: a cauda é um relógio só, não uma pausa que se renova.
      for (const text of ['ab', 'abc', 'abcd']) {
        await wait(30);
        type(text);
      }
      await wait(TAIL);
      expect(sentTexts()).toEqual(['a', 'abcd']);
    });
  });

  describe('one request in flight', () => {
    it('has only one request in flight and sends just the latest text afterwards', async () => {
      type('a');
      expect(sentTexts()).toEqual(['a']);

      // Muda três vezes enquanto o primeiro ainda não voltou: nenhum envio novo.
      type('ab');
      await wait(TAIL);
      type('abc');
      await wait(TAIL);
      type('abcd');
      await wait(TAIL * 5);
      expect(sentTexts()).toEqual(['a']);

      await finish();
      // Só o valor mais recente vai, sem passar por 'ab' nem 'abc', e já (a cauda passou durante o envio).
      expect(sentTexts()).toEqual(['a', 'abcd']);
      expect(sync.status()).toBe('sending');
      await finish();
      expect(sync.status()).toBe('sent');
      expect(calls).toHaveLength(2);
    });

    it('waits for the rest of the tail when the answer comes back fast', async () => {
      type('a');
      type('ab');
      await wait(20);
      await finish();
      expect(sentTexts()).toEqual(['a']);
      await wait(TAIL - 21);
      expect(sentTexts()).toEqual(['a']);
      await wait(1);
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('does not resend what the TV already has', async () => {
      type('batman');
      await finish();
      // Dentro da cauda: o campo vai e volta para o que a TV já tem, então nada sai.
      type('batmanx');
      type('batman');
      await wait(TAIL * 3);
      expect(sentTexts()).toEqual(['batman']);
    });

    it('accepts exactly 200 characters, counting an emoji as one', () => {
      type('😀'.repeat(200));
      expect(calls).toHaveLength(1);
    });
  });

  describe('empty text', () => {
    it('sends the empty text when the field is erased down to nothing', async () => {
      type('abc');
      await finish();
      await wait(TAIL);
      type('');
      expect(sentTexts()).toEqual(['abc', '']);
      await finish();
      expect(sync.status()).toBe('sent');
    });

    it('erasing letter by letter ends with the empty text, in few requests, the last one empty', async () => {
      type('abc');
      await finish();
      await wait(TAIL);
      type('ab');
      type('a');
      type('');
      expect(sentTexts()).toEqual(['abc', 'ab']);
      await finish();
      await wait(TAIL);
      expect(sentTexts()).toEqual(['abc', 'ab', '']);
    });

    it('sends nothing when the panel opens and closes without typing', () => {
      sync.flush();
      type('');
      sync.flush();
      expect(calls).toHaveLength(0);
    });

    it('does not send empty again when the TV already has nothing', async () => {
      type('a');
      await finish();
      await wait(TAIL);
      type('');
      await finish();
      await wait(TAIL);
      type('');
      sync.flush();
      expect(sentTexts()).toEqual(['a', '']);
    });

    it('"Limpar" (empty plus flush) goes out at once, before the tail ends', async () => {
      type('abc');
      await finish();
      type('');
      sync.flush();
      expect(sentTexts()).toEqual(['abc', '']);
    });

    it('"Limpar" while a request is in flight sends the empty text right after it', async () => {
      type('abc');
      expect(sentTexts()).toEqual(['abc']);
      type('');
      sync.flush();
      expect(sentTexts()).toEqual(['abc']);
      await finish();
      expect(sentTexts()).toEqual(['abc', '']);
      await finish();
      expect(sync.status()).toBe('sent');
    });

    it('typing the same text again after "Limpar" sends it again', async () => {
      type('abc');
      await finish();
      type('');
      sync.flush();
      await finish();
      await wait(TAIL);
      type('abc');
      expect(sentTexts()).toEqual(['abc', '', 'abc']);
    });
  });

  describe('invalid text', () => {
    it('never sends control characters or more than 200 characters', async () => {
      type('batman');
      await finish();
      await wait(TAIL);
      type('a\nb');
      await wait(1000);
      type('a'.repeat(201));
      await wait(1000);
      expect(sentTexts()).toEqual(['batman']);
    });

    it('stops a pending send when the text becomes invalid before the tail ends', async () => {
      type('a');
      await finish();
      type('ab');
      type('a'.repeat(201));
      await wait(1000);
      expect(sentTexts()).toEqual(['a']);
    });

    it('does not stay on "sending" when the field goes over 200 characters during the request', async () => {
      type('abc');
      expect(sync.status()).toBe('sending');
      type('a'.repeat(201));
      await finish();
      expect(sync.status()).toBe('idle');
      await wait(2000);
      expect(sentTexts()).toEqual(['abc']);
    });
  });

  describe('failure', () => {
    it('keeps the text and tries again on the next change after a failure, with no loop', async () => {
      type('bat');
      await finish(failure('network'));
      expect(sync.status()).toBe('error');
      expect(sync.failure()?.kind).toBe('network');
      // Nada de novo sozinho.
      await wait(10_000);
      expect(sentTexts()).toEqual(['bat']);

      type('batm');
      expect(sentTexts()).toEqual(['bat', 'batm']);
      await finish();
      expect(sync.status()).toBe('sent');
      expect(sync.failure()).toBeNull();
    });

    it('sends the same text again after a failure if the next change comes back to it', async () => {
      type('bat');
      await finish(failure('timeout'));
      await wait(TAIL);
      type('batx');
      await finish();
      await wait(TAIL);
      type('bat');
      expect(sentTexts()).toEqual(['bat', 'batx', 'bat']);
    });

    it('retries a queued text once after a failure and stops there', async () => {
      type('a');
      type('ab');
      await finish(failure('network'));
      await wait(TAIL);
      expect(sentTexts()).toEqual(['a', 'ab']);
      await finish(failure('network'));
      await wait(60_000);
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('waits for the Retry-After after a rate limit, even for a change that would go at once', async () => {
      type('bat');
      await finish(failure('rate-limited', 7));
      await wait(TAIL * 10);
      type('batm');
      expect(sentTexts()).toEqual(['bat']);
      // 7 s depois da falha (1 s já passou): só então sai.
      await wait(5_000);
      expect(sentTexts()).toEqual(['bat']);
      await wait(999);
      expect(sentTexts()).toEqual(['bat']);
      await wait(1);
      expect(sentTexts()).toEqual(['bat', 'batm']);
    });

    it('a value queued behind a rate-limited request is also held by the Retry-After', async () => {
      type('a');
      type('ab');
      await finish(failure('rate-limited', 5));
      expect(sentTexts()).toEqual(['a']);
      await wait(4_999);
      expect(sentTexts()).toEqual(['a']);
      await wait(1);
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('turns an unexpected throw into an error status instead of an unhandled rejection', async () => {
      const throwing = make({
        sender: { isValid: isValidTvText, send: () => Promise.reject(new Error('boom')) },
      });
      throwing.change('abc');
      await wait(0);
      expect(throwing.status()).toBe('error');
    });
  });

  describe('flush', () => {
    it('sends the pending text now, without waiting for the tail', async () => {
      type('a');
      await finish();
      type('ab');
      expect(sentTexts()).toEqual(['a']);
      sync.flush();
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('keeps the one-in-flight rule', async () => {
      type('abc');
      sync.flush();
      expect(sentTexts()).toEqual(['abc']);
      type('abcd');
      sync.flush();
      expect(sentTexts()).toEqual(['abc']);
      await finish();
      expect(sentTexts()).toEqual(['abc', 'abcd']);
    });

    it('still waits for the Retry-After', async () => {
      type('a');
      await finish(failure('rate-limited', 3));
      type('ab');
      sync.flush();
      expect(sentTexts()).toEqual(['a']);
      await wait(3_000);
      expect(sentTexts()).toEqual(['a', 'ab']);
    });

    it('with nothing new, or only the empty text, sends nothing', async () => {
      sync.flush();
      type('abc');
      await finish();
      sync.flush();
      expect(sentTexts()).toEqual(['abc']);
    });
  });

  describe('request budget', () => {
    it('never starts more than the budget inside the sliding window', async () => {
      const small = make({ maxRequests: 3, windowMs: 1_000 });
      const typeSmall = (text: string) => small.change(text);
      const answer = async () => {
        calls[calls.length - 1].resolve(null);
        await wait(0);
      };
      // Uma letra a cada 150 ms, resposta na hora: sem o freio sairia um envio por letra.
      typeSmall('a');
      await answer();
      for (const text of ['ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
        await wait(150);
        typeSmall(text);
        await answer();
      }
      // 3 envios cabem na janela de 1 s; os outros esperam.
      expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 150, 300]);
      await wait(1_000);
      expect(calls.at(-1)?.text).toBe('abcdef');
    });

    it('keeps text under 300 per minute, and under the budget in every window, typing nonstop with instant answers', async () => {
      const stamps: number[] = [];
      const fast = make({
        sender: {
          isValid: isValidTvText,
          send: () => {
            stamps.push(Date.now());
            return Promise.resolve<TvFailure | null>(null);
          },
        },
      });
      // Pior caso: uma letra nova a cada 20 ms, durante 70 s, com a TV respondendo na hora.
      let text = '';
      const total = 70_000;
      for (let t = 0; t < total; t += 20) {
        text = text.length >= 190 ? 'a' : text + 'a';
        fast.change(text);
        await wait(20);
      }
      await wait(WINDOW);
      let worstWindow = 0;
      let worstMinute = 0;
      for (const [index, start] of stamps.entries()) {
        const inWindow = stamps.filter((at, i) => i >= index && at < start + WINDOW).length;
        const inMinute = stamps.filter((at, i) => i >= index && at < start + 60_000).length;
        worstWindow = Math.max(worstWindow, inWindow);
        worstMinute = Math.max(worstMinute, inMinute);
      }
      expect(worstWindow).toBeLessThanOrEqual(MAX_REQUESTS);
      expect(worstMinute).toBeLessThanOrEqual(240);
      // O freio só aperta depois da rajada: nos 70 s saem quase 4 por segundo, não um punhado.
      expect(stamps.length).toBeGreaterThan(250);
    });
  });

  describe('status', () => {
    it('typing again after "sent" drops the status back to idle', async () => {
      type('abc');
      await finish();
      expect(sync.status()).toBe('sent');
      type('abcd');
      expect(sync.status()).toBe('idle');
    });

    it('goes back to "sending" by itself when the changed text still has to be sent', async () => {
      type('a');
      type('ab');
      await finish();
      expect(sync.status()).toBe('idle');
      await wait(TAIL);
      expect(sync.status()).toBe('sending');
    });
  });
});
