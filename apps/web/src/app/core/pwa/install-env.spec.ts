import {
  InstallEnvInput,
  IosBrowser,
  iosBrowser,
  isAndroid,
  isIos,
  isMobileDevice,
  isStandalone,
  readInstallEnv,
} from './install-env';

// Agentes de usuário representativos dos formatos documentados (não são capturas de aparelhos reais).
const IPHONE = 'iPhone; CPU iPhone OS 17_5 like Mac OS X';
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const UA = {
  safari17: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`,
  safari18: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ${WEBKIT} Version/18.0 Mobile/15E148 Safari/604.1`,
  chromeIos: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1`,
  firefoxIos: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} FxiOS/127.0 Mobile/15E148 Safari/605.1.15`,
  edgeIos: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} Version/17.0 EdgiOS/126.2592.87 Mobile/15E148 Safari/605.1.15`,
  instagram: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} Mobile/21F90 Instagram 340.0.0.28.101 (iPhone14,5; iOS 17_5; pt_BR; pt-BR; scale=3.00; 1170x2532; 600000000)`,
  facebook: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} Mobile/21F90 [FBAN/FBIOS;FBAV/460.0.0.34.108;FBBV/588456789;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/pt_BR;FBOP/5]`,
  googleApp: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} GSA/320.0.644 Mobile/15E148 Safari/604.1`,
  genericWebView: `Mozilla/5.0 (${IPHONE}) ${WEBKIT} Mobile/15E148`,
  ipad: `Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`,
  ipadAsMac: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.5 Safari/605.1.15`,
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopSafari: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.5 Safari/605.1.15`,
};

const env = (userAgent: string, rest: Partial<InstallEnvInput> = {}): InstallEnvInput => ({
  userAgent,
  ...rest,
});

describe('install-env', () => {
  describe('isIos', () => {
    it.each([
      ['iPhone Safari 17', env(UA.safari17)],
      ['iPhone Safari 18', env(UA.safari18)],
      ['iPhone Chrome', env(UA.chromeIos)],
      ['iPhone Firefox', env(UA.firefoxIos)],
      ['iPhone Edge', env(UA.edgeIos)],
      ['iPhone Instagram', env(UA.instagram)],
      ['iPad com o agente de iPad', env(UA.ipad)],
      [
        'iPad que se diz Mac, com toque',
        env(UA.ipadAsMac, { platform: 'MacIntel', maxTouchPoints: 5 }),
      ],
    ])('reconhece %s', (_name, input) => {
      expect(isIos(input)).toBe(true);
    });

    it.each([
      ['Android Chrome', env(UA.androidChrome, { maxTouchPoints: 5 })],
      ['Chrome no computador', env(UA.desktopChrome)],
      [
        'Safari de um Mac de verdade (sem toque)',
        env(UA.desktopSafari, { platform: 'MacIntel', maxTouchPoints: 0 }),
      ],
      ['Mac sem informar toque', env(UA.desktopSafari, { platform: 'MacIntel' })],
      ['agente vazio', env('')],
    ])('não confunde %s', (_name, input) => {
      expect(isIos(input)).toBe(false);
    });

    it('um Mac com um único ponto de toque não é iPad', () => {
      expect(isIos(env(UA.desktopSafari, { maxTouchPoints: 1 }))).toBe(false);
    });
  });

  describe('isAndroid e isMobileDevice', () => {
    it('Android Chrome é Android e celular; iPhone é celular mas não Android', () => {
      expect(isAndroid(env(UA.androidChrome))).toBe(true);
      expect(isMobileDevice(env(UA.androidChrome))).toBe(true);
      expect(isAndroid(env(UA.safari17))).toBe(false);
      expect(isMobileDevice(env(UA.safari17))).toBe(true);
    });

    it('computador não é celular', () => {
      expect(isMobileDevice(env(UA.desktopChrome))).toBe(false);
      expect(isMobileDevice(env(UA.desktopSafari, { maxTouchPoints: 0 }))).toBe(false);
    });
  });

  describe('isStandalone', () => {
    it('navigator.standalone verdadeiro vale', () => {
      expect(isStandalone(env(UA.safari17, { standalone: true }))).toBe(true);
    });

    it('a media query display-mode standalone vale', () => {
      const asked: string[] = [];
      const matchMedia = (query: string) => {
        asked.push(query);
        return { matches: true };
      };
      expect(isStandalone(env(UA.androidChrome, { matchMedia }))).toBe(true);
      expect(asked).toEqual(['(display-mode: standalone)']);
    });

    it('standalone falso e media query falsa: está no navegador', () => {
      expect(
        isStandalone(
          env(UA.safari17, { standalone: false, matchMedia: () => ({ matches: false }) }),
        ),
      ).toBe(false);
      expect(isStandalone(env(UA.safari17))).toBe(false);
    });

    it('um matchMedia que lança não derruba a detecção', () => {
      const matchMedia = () => {
        throw new Error('sem suporte');
      };
      expect(isStandalone(env(UA.safari17, { matchMedia }))).toBe(false);
    });
  });

  describe('iosBrowser', () => {
    const cases: readonly [string, InstallEnvInput, IosBrowser][] = [
      ['Safari 17', env(UA.safari17), 'safari'],
      ['Safari 18', env(UA.safari18), 'safari'],
      ['Chrome', env(UA.chromeIos), 'chrome-ios'],
      ['Firefox', env(UA.firefoxIos), 'firefox-ios'],
      ['Edge (que também manda Version e Safari)', env(UA.edgeIos), 'edge-ios'],
      ['Instagram', env(UA.instagram), 'in-app'],
      ['Facebook', env(UA.facebook), 'in-app'],
      ['app do Google (manda Safari/, mas é embutido)', env(UA.googleApp), 'in-app'],
      ['visualizador genérico, sem o token Safari/', env(UA.genericWebView), 'in-app'],
      ['iPad com agente de iPad', env(UA.ipad), 'safari'],
      [
        'iPad que se diz Mac',
        env(UA.ipadAsMac, { platform: 'MacIntel', maxTouchPoints: 5 }),
        'safari',
      ],
    ];

    it.each(cases)('%s', (_name, input, expected) => {
      expect(iosBrowser(input)).toBe(expected);
    });

    it('com Safari/ e sem Version/ e sem ficha conhecida é "other"', () => {
      expect(iosBrowser(env(`Mozilla/5.0 (${IPHONE}) ${WEBKIT} Mobile/15E148 Safari/604.1`))).toBe(
        'other',
      );
    });

    it('fora do iOS devolve "other", mesmo com ficha de app embutido', () => {
      expect(iosBrowser(env(UA.androidChrome))).toBe('other');
      expect(iosBrowser(env(`${UA.desktopChrome} Instagram`))).toBe('other');
    });
  });

  describe('readInstallEnv', () => {
    it('sem window devolve um ambiente vazio', () => {
      expect(readInstallEnv(null)).toEqual({ userAgent: '' });
      expect(readInstallEnv(undefined)).toEqual({ userAgent: '' });
    });

    it('lê o navegador e liga o matchMedia só se ele existir', () => {
      const fake = {
        navigator: {
          userAgent: UA.safari17,
          platform: 'iPhone',
          maxTouchPoints: 5,
          standalone: true,
        },
        matchMedia: (query: string) => ({ matches: query.includes('standalone') }),
      } as unknown as Window;
      const read = readInstallEnv(fake);
      expect(read.userAgent).toBe(UA.safari17);
      expect(read.maxTouchPoints).toBe(5);
      expect(read.standalone).toBe(true);
      expect(read.matchMedia?.('(display-mode: standalone)').matches).toBe(true);

      const without = readInstallEnv({ navigator: { userAgent: 'x' } } as unknown as Window);
      expect(without.matchMedia).toBeUndefined();
    });
  });
});
