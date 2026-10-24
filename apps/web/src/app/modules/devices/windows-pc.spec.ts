import { CONNECTOR_URL, isWindowsPc } from './windows-pc';

const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('isWindowsPc', () => {
  it('recognizes desktop browsers on Windows', () => {
    expect(isWindowsPc({ userAgent: WINDOWS_CHROME })).toBe(true);
    expect(
      isWindowsPc({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      }),
    ).toBe(true);
  });

  it.each([
    [
      'iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    ],
    [
      'Android',
      'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
    ],
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'],
    ['Windows Phone', 'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) Edge/15.15254'],
    ['empty', ''],
  ])('says no for %s', (_name, userAgent) => {
    expect(isWindowsPc({ userAgent })).toBe(false);
  });

  it('points at the connector the site serves', () => {
    expect(CONNECTOR_URL).toBe('/conectar/conectar-uniover.cmd');
  });
});
