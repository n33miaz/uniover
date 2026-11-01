import { clientEnvHeaderValue, clientPlatform, currentClientEnvHeader } from './client-env';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
const IPAD = `Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
const IPAD_AS_MAC = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.5 Safari/605.1.15`;
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const media = (matching: string[]) => (query: string) => ({ matches: matching.includes(query) });

describe('client-env', () => {
  it('tells the device apart: iPhone, iPad (also posing as a Mac), Android and PC', () => {
    expect(clientPlatform({ userAgent: IPHONE })).toBe('iphone');
    expect(clientPlatform({ userAgent: IPAD })).toBe('ipad');
    expect(
      clientPlatform({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 5 }),
    ).toBe('ipad');
    expect(clientPlatform({ userAgent: ANDROID })).toBe('android');
    expect(clientPlatform({ userAgent: WINDOWS })).toBe('pc');
    expect(
      clientPlatform({ userAgent: IPAD_AS_MAC, platform: 'MacIntel', maxTouchPoints: 0 }),
    ).toBe('pc');
  });

  it('reports the installed app on iOS through navigator.standalone', () => {
    expect(clientEnvHeaderValue({ userAgent: IPHONE, standalone: true })).toBe('iphone;standalone');
    expect(clientEnvHeaderValue({ userAgent: IPHONE, standalone: false })).toBe('iphone;browser');
    expect(clientEnvHeaderValue({ userAgent: IPHONE })).toBe('iphone;browser');
  });

  it('reports the installed app through display-mode, and fullscreen only on iOS', () => {
    const standalone = media(['(display-mode: standalone)']);
    const fullscreen = media(['(display-mode: fullscreen)']);
    expect(clientEnvHeaderValue({ userAgent: ANDROID, matchMedia: standalone })).toBe(
      'android;standalone',
    );
    expect(clientEnvHeaderValue({ userAgent: WINDOWS, matchMedia: standalone })).toBe(
      'pc;standalone',
    );
    expect(clientEnvHeaderValue({ userAgent: IPHONE, matchMedia: fullscreen })).toBe(
      'iphone;standalone',
    );
    expect(clientEnvHeaderValue({ userAgent: ANDROID, matchMedia: fullscreen })).toBe(
      'android;browser',
    );
  });

  it('has nothing to report without a window', () => {
    expect(currentClientEnvHeader(null)).toBeNull();
  });

  it('reads the real window (jsdom is a browser tab on a computer)', () => {
    expect(currentClientEnvHeader(window)).toBe('pc;browser');
  });
});
