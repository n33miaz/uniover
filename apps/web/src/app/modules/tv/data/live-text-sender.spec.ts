import { FullTextSender } from './live-text-sender';
import { TvFailure } from './tv-errors';

describe('FullTextSender', () => {
  it('sends the whole text through the store and returns what the store says', async () => {
    const failure: TvFailure = { kind: 'timeout', message: 'x', retryAfterSeconds: null };
    const sendText = vi.fn<(text: string) => Promise<TvFailure | null>>();
    sendText.mockResolvedValueOnce(null).mockResolvedValueOnce(failure);
    const sender = new FullTextSender({ sendText });
    expect(await sender.send('batman')).toBeNull();
    expect(await sender.send('batman 2')).toBe(failure);
    expect(sendText.mock.calls.map((call) => call[0])).toEqual(['batman', 'batman 2']);
  });

  it('accepts 1 to 200 characters without control characters, and nothing else', () => {
    const sender = new FullTextSender({ sendText: vi.fn() });
    expect(sender.isValid('bat')).toBe(true);
    expect(sender.isValid('😀'.repeat(200))).toBe(true);
    expect(sender.isValid('')).toBe(false);
    expect(sender.isValid('a'.repeat(201))).toBe(false);
    expect(sender.isValid('linha\noutra')).toBe(false);
  });
});
