import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { InstallEnvInput } from './install-env';
import {
  INSTALL_ENV,
  INSTALL_HINT_KEY,
  INSTALL_HINT_SNOOZE_MS,
  INSTALL_INTENT_KEY,
  INSTALL_NAVIGATE,
  INSTALL_OFFER_WAIT_MS,
  InstallHintService,
  InstallMode,
} from './install-hint.service';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT}`;
const UA = {
  safari: `${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`,
  chrome: `${IPHONE} CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1`,
  firefox: `${IPHONE} FxiOS/127.0 Mobile/15E148 Safari/605.1.15`,
  edge: `${IPHONE} Version/17.0 EdgiOS/126.2592.87 Mobile/15E148 Safari/605.1.15`,
  instagram: `${IPHONE} Mobile/21F90 Instagram 340.0.0.28.101 (iPhone14,5; iOS 17_5; pt_BR)`,
  android:
    'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

type PromptEvent = Event & {
  prompt: ReturnType<typeof vi.fn<() => Promise<void>>>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** O pedido de instalação do Chromium, no formato que o navegador entrega. */
function installPromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): PromptEvent {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as PromptEvent;
  event.prompt = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

const stored = () => JSON.parse(localStorage.getItem(INSTALL_HINT_KEY) ?? 'null');

describe('InstallHintService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function create(env: InstallEnvInput): InstallHintService {
    TestBed.configureTestingModule({ providers: [{ provide: INSTALL_ENV, useValue: env }] });
    const service = TestBed.inject(InstallHintService);
    service.start();
    return service;
  }

  describe('mode', () => {
    it.each<[string, InstallEnvInput, InstallMode]>([
      ['iPhone Safari', { userAgent: UA.safari }, 'ios-safari'],
      ['Chrome no iPhone', { userAgent: UA.chrome }, 'ios-other'],
      ['Firefox no iPhone', { userAgent: UA.firefox }, 'ios-other'],
      ['Edge no iPhone', { userAgent: UA.edge }, 'ios-other'],
      ['Instagram no iPhone', { userAgent: UA.instagram }, 'ios-in-app'],
      ['Android sem o pedido do navegador', { userAgent: UA.android }, 'android-manual'],
      ['computador', { userAgent: UA.desktop }, 'none'],
      [
        'iPhone já na tela de início (navigator.standalone)',
        { userAgent: UA.safari, standalone: true },
        'none',
      ],
      [
        'Android já instalado (display-mode)',
        { userAgent: UA.android, matchMedia: () => ({ matches: true }) },
        'none',
      ],
    ])('%s', (_name, env, expected) => {
      expect(create(env).mode()).toBe(expected);
    });

    it('vira native quando o navegador entrega o pedido de instalação, e o guarda sem mostrar o do navegador', () => {
      const service = create({ userAgent: UA.android });
      expect(service.mode()).toBe('android-manual');
      const event = installPromptEvent();
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(service.mode()).toBe('native');
    });

    it('chamar start duas vezes não liga o ouvinte duas vezes', () => {
      const add = vi.spyOn(window, 'addEventListener');
      const service = create({ userAgent: UA.android });
      service.start();
      const listened = add.mock.calls.filter(([type]) => type === 'beforeinstallprompt');
      expect(listened).toHaveLength(1);
    });

    it('depois de destruído, não escuta mais o navegador', () => {
      const service = create({ userAgent: UA.android });
      TestBed.resetTestingModule();
      window.dispatchEvent(installPromptEvent());
      expect(service.mode()).toBe('android-manual');
    });
  });

  describe('instalação nativa', () => {
    it('prompt() mostra o pedido, devolve accepted e o pedido (que vale uma vez) sai', async () => {
      const service = create({ userAgent: UA.android });
      const event = installPromptEvent('accepted');
      window.dispatchEvent(event);
      expect(await service.prompt()).toBe('accepted');
      expect(event.prompt).toHaveBeenCalledTimes(1);
      expect(service.mode()).toBe('none');
      expect(await service.prompt()).toBe('unavailable');
      expect(stored()).toEqual({ installed: true });

      TestBed.resetTestingModule();
      expect(create({ userAgent: UA.android }).autoOpenAllowed()).toBe(false);
    });

    it('recusar o pedido conta como "Agora não": a folha não volta sozinha por 14 dias', async () => {
      const service = create({ userAgent: UA.android });
      window.dispatchEvent(installPromptEvent('dismissed'));
      expect(await service.prompt()).toBe('dismissed');
      expect(stored().dismissedAt).toEqual(expect.any(Number));
      window.dispatchEvent(installPromptEvent()); // o Chromium entrega outro depois
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('sem pedido guardado, ou com o navegador recusando mostrá-lo, devolve unavailable', async () => {
      const service = create({ userAgent: UA.android });
      expect(await service.prompt()).toBe('unavailable');
      const event = installPromptEvent();
      event.prompt.mockRejectedValue(new Error('já usado'));
      window.dispatchEvent(event);
      expect(await service.prompt()).toBe('unavailable');
    });

    it('appinstalled: não há mais o que oferecer e a confirmação fica salva', () => {
      localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ dismissedAt: 1 }));
      const service = create({ userAgent: UA.android });
      window.dispatchEvent(installPromptEvent());
      expect(service.mode()).toBe('native');
      window.dispatchEvent(new Event('appinstalled'));
      expect(service.mode()).toBe('none');
      expect(stored()).toEqual({ installed: true });
    });
  });

  describe('quando a folha pode abrir sozinha', () => {
    it('abre num celular com o que oferecer, e só uma vez por página', () => {
      const service = create({ userAgent: UA.safari });
      expect(service.autoOpenAllowed()).toBe(true);
      service.openAuto();
      expect(service.sheet()).toBe('auto');
      service.closeSheet();
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('não abre sozinha no computador, mesmo com o pedido nativo (as linhas valem em qualquer aparelho)', () => {
      const service = create({ userAgent: UA.desktop });
      window.dispatchEvent(installPromptEvent());
      expect(service.mode()).toBe('native');
      expect(service.autoOpenAllowed()).toBe(false);
      service.open();
      expect(service.sheet()).toBe('manual');
    });

    it('não abre quando não há o que oferecer', () => {
      expect(create({ userAgent: UA.desktop }).autoOpenAllowed()).toBe(false);
    });

    it('"Agora não" adia por 14 dias, e só então volta', () => {
      const service = create({ userAgent: UA.safari });
      const t0 = Date.UTC(2026, 9, 20);
      service.dismiss(t0);
      expect(stored()).toEqual({ dismissedAt: t0 });
      expect(service.autoOpenAllowed(t0 + 1000)).toBe(false);
      expect(service.autoOpenAllowed(t0 + INSTALL_HINT_SNOOZE_MS - 1)).toBe(false);
      expect(service.autoOpenAllowed(t0 + INSTALL_HINT_SNOOZE_MS)).toBe(true);
    });

    it('com o relógio andando para trás, na dúvida não insiste', () => {
      const service = create({ userAgent: UA.safari });
      service.dismiss(Date.UTC(2026, 9, 20));
      expect(service.autoOpenAllowed(Date.UTC(2026, 8, 1))).toBe(false);
    });

    it('"Não mostrar de novo" vale para sempre, e é lembrado ao recarregar', () => {
      const service = create({ userAgent: UA.safari });
      service.never();
      expect(stored()).toEqual({ never: true });
      expect(service.autoOpenAllowed(Date.now() + 10 * INSTALL_HINT_SNOOZE_MS)).toBe(false);

      TestBed.resetTestingModule();
      expect(create({ userAgent: UA.safari }).autoOpenAllowed()).toBe(false);
    });

    it('lembra o "Agora não" ao recarregar', () => {
      const first = create({ userAgent: UA.safari });
      first.dismiss();
      TestBed.resetTestingModule();
      expect(create({ userAgent: UA.safari }).autoOpenAllowed()).toBe(false);
    });

    it('rodando como app instalado, salva a confirmação para evitar nova dica automática', () => {
      localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ never: true, dismissedAt: 5 }));
      create({ userAgent: UA.safari, standalone: true });
      expect(stored()).toEqual({ installed: true });
    });

    it('no iOS, a inicialização standalone confirma instalação sem depender de appinstalled', () => {
      create({ userAgent: UA.safari, standalone: true });
      expect(stored()).toEqual({ installed: true });

      TestBed.resetTestingModule();
      const browser = create({ userAgent: UA.safari });
      expect(browser.mode()).toBe('ios-safari');
      expect(browser.autoOpenAllowed()).toBe(false);
    });

    it('memória ilegível (texto solto, tipos errados) é ignorada', () => {
      for (const junk of [
        'isso não é json',
        '"texto"',
        '[1,2]',
        '{"never":"sim","dismissedAt":"ontem"}',
      ]) {
        localStorage.setItem(INSTALL_HINT_KEY, junk);
        TestBed.resetTestingModule();
        expect(create({ userAgent: UA.safari }).autoOpenAllowed()).toBe(true);
      }
    });
  });

  describe('sem armazenamento (modo privado, dados bloqueados)', () => {
    beforeEach(() => {
      const blocked = () => {
        throw new DOMException('bloqueado', 'SecurityError');
      };
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    });

    it('nada lança, e o que foi dito vale até recarregar a página', () => {
      const service = create({ userAgent: UA.safari });
      expect(service.autoOpenAllowed()).toBe(true);
      expect(() => service.dismiss()).not.toThrow();
      expect(service.autoOpenAllowed()).toBe(false);
      expect(() => service.never()).not.toThrow();
    });

    it('a folha automática aparece no máximo uma vez por página', () => {
      const service = create({ userAgent: UA.safari });
      service.openAuto();
      service.closeSheet();
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('instalado: não tenta persistir o que não consegue ler', () => {
      expect(() => create({ userAgent: UA.safari, standalone: true })).not.toThrow();
    });
  });

  describe('pedido de espera (o treino ao vivo)', () => {
    it('com o pedido de pé, a folha não abre sozinha; solto, volta a poder abrir', () => {
      const service = create({ userAgent: UA.safari });
      const release = service.holdAuto();
      expect(service.autoHeld()).toBe(true);
      expect(service.autoEligible()).toBe(false);
      expect(service.autoOpenAllowed()).toBe(false);
      release();
      expect(service.autoHeld()).toBe(false);
      expect(service.autoEligible()).toBe(true);
      expect(service.autoOpenAllowed()).toBe(true);
    });

    it('soltar duas vezes não solta o pedido de outra tela', () => {
      const service = create({ userAgent: UA.safari });
      const first = service.holdAuto();
      const second = service.holdAuto();
      first();
      first();
      expect(service.autoHeld()).toBe(true);
      second();
      expect(service.autoHeld()).toBe(false);
    });

    it('não impede a folha pedida pela pessoa', () => {
      const service = create({ userAgent: UA.safari });
      service.holdAuto();
      service.open();
      expect(service.sheet()).toBe('manual');
    });
  });

  describe('iosNotInstalled (onde o iOS apaga os dados do site sem uso)', () => {
    it.each<[string, InstallEnvInput, boolean]>([
      ['iPhone Safari', { userAgent: UA.safari }, true],
      ['Chrome no iPhone', { userAgent: UA.chrome }, true],
      ['Instagram no iPhone', { userAgent: UA.instagram }, true],
      ['iPhone na tela de início', { userAgent: UA.safari, standalone: true }, false],
      ['Android', { userAgent: UA.android }, false],
      ['computador', { userAgent: UA.desktop }, false],
    ])('%s', (_name, env, expected) => {
      expect(create(env).iosNotInstalled()).toBe(expected);
    });

    it('vale ao instalar sem recarregar: o app abre da tela de início e o aviso some', () => {
      const service = create({ userAgent: UA.safari });
      expect(service.iosNotInstalled()).toBe(true);
      service.acknowledgeInstalled();
      expect(service.iosNotInstalled()).toBe(false);
    });
  });

  describe('abertura manual (as linhas de Ajustes e de Personalizar)', () => {
    it('abre mesmo depois de "Agora não" e de "Não mostrar de novo"', () => {
      const service = create({ userAgent: UA.safari });
      service.never();
      service.dismiss();
      service.open();
      expect(service.sheet()).toBe('manual');
      service.closeSheet();
      expect(service.sheet()).toBeNull();
    });

    it('não abre quando não há o que oferecer', () => {
      const service = create({ userAgent: UA.desktop });
      service.open();
      expect(service.sheet()).toBeNull();
    });

    it('depois de aberta pela pessoa, a automática não aparece logo atrás', () => {
      const service = create({ userAgent: UA.safari });
      service.open();
      service.closeSheet();
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('com a folha aberta, outro pedido de abrir é ignorado', () => {
      const service = create({ userAgent: UA.safari });
      service.openAuto();
      service.open();
      expect(service.sheet()).toBe('auto');
    });
  });

  describe('por módulo', () => {
    const navigations: string[] = [];
    let events: Subject<unknown>;

    /** Cria o serviço com o documento carregado em `loadedAt`, e um roteador falso para navegar por dentro. */
    function createAt(loadedAt: string, env: InstallEnvInput): InstallHintService {
      history.replaceState(null, '', loadedAt);
      events = new Subject();
      TestBed.configureTestingModule({
        providers: [
          { provide: INSTALL_ENV, useValue: env },
          { provide: Router, useValue: { events } },
          { provide: INSTALL_NAVIGATE, useValue: (url: string) => navigations.push(url) },
        ],
      });
      const service = TestBed.inject(InstallHintService);
      service.start();
      return service;
    }
    const goTo = (url: string) => events.next(new NavigationEnd(1, url, url));

    beforeEach(() => navigations.splice(0));
    afterEach(() => {
      history.replaceState(null, '', '/');
      sessionStorage.removeItem(INSTALL_INTENT_KEY);
    });

    it('a raiz instalada não suprime a dica do Treino', () => {
      localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ installed: true, never: true }));
      const service = createAt('/', { userAgent: UA.safari });
      expect(service.autoEligible()).toBe(false);
      goTo('/treino/hoje');
      expect(service.autoEligible()).toBe(true);
    });

    it('"nunca" e "agora não" de um módulo não valem para a raiz', () => {
      const service = createAt('/treino/', { userAgent: UA.safari });
      service.never();
      expect(JSON.parse(localStorage.getItem(`${INSTALL_HINT_KEY}.treino`)!)).toEqual({
        never: true,
      });
      expect(localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
      goTo('/');
      expect(service.autoEligible()).toBe(true);
    });

    it('instalar marca só o app do documento', () => {
      const service = createAt('/treino/', { userAgent: UA.safari });
      service.acknowledgeInstalled();
      expect(localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
      expect(JSON.parse(localStorage.getItem(`${INSTALL_HINT_KEY}.treino`)!)).toEqual({
        installed: true,
      });
    });

    it('aberto como app instalado (standalone) a folha nunca abre sozinha, com a memória vazia', () => {
      const service = createAt('/treino/', { userAgent: UA.safari, standalone: true });
      expect(service.mode()).toBe('none');
      expect(service.autoEligible()).toBe(false);
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('o pedido guardado no documento da raiz não instala o Treino: faz carga completa em /treino/', async () => {
      const service = createAt('/', { userAgent: UA.android });
      const event = installPromptEvent();
      window.dispatchEvent(event);
      expect(service.mode()).toBe('native');
      goTo('/treino/hoje');
      expect(service.mode()).toBe('native');
      expect(await service.prompt()).toBe('reloading');
      expect(event.prompt).not.toHaveBeenCalled();
      expect(navigations).toEqual([
        `/treino/?instalar=${sessionStorage.getItem(INSTALL_INTENT_KEY)}`,
      ]);
      expect(sessionStorage.getItem(INSTALL_INTENT_KEY)).toBeTruthy();
    });

    it('no escopo do próprio documento usa o pedido nativo', async () => {
      const service = createAt('/treino/', { userAgent: UA.android });
      window.dispatchEvent(installPromptEvent());
      goTo('/treino/historico');
      expect(await service.prompt()).toBe('accepted');
      expect(navigations).toEqual([]);
    });

    it('pedido para a raiz, vindo de um documento do Treino, recarrega o endereço atual da raiz, com busca e fragmento', async () => {
      const service = createAt('/treino/', { userAgent: UA.android });
      window.dispatchEvent(installPromptEvent());
      history.replaceState(null, '', '/ajustes/aparencia?aba=2#topo');
      goTo('/ajustes/aparencia?aba=2#topo');
      expect(await service.prompt()).toBe('reloading');
      const token = sessionStorage.getItem(INSTALL_INTENT_KEY);
      expect(navigations).toEqual([`/ajustes/aparencia?aba=2&instalar=${token}#topo`]);
    });

    it('marcador de um link externo (sem o código gravado pelo botão) é só tirado do endereço: a folha não abre', () => {
      vi.useFakeTimers();
      try {
        const service = createAt('/treino/?instalar=1&x=1#a', { userAgent: UA.android });
        expect(location.pathname + location.search + location.hash).toBe('/treino/?x=1#a');
        window.dispatchEvent(installPromptEvent());
        vi.advanceTimersByTime(INSTALL_OFFER_WAIT_MS);
        expect(service.sheet()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('o código é de uso único: o de outra carga, ou o já usado, não vale', () => {
      sessionStorage.setItem(INSTALL_INTENT_KEY, 'abc');
      const first = createAt('/treino/?instalar=abc', { userAgent: UA.android });
      window.dispatchEvent(installPromptEvent());
      expect(first.sheet()).toBe('manual');
      expect(sessionStorage.getItem(INSTALL_INTENT_KEY)).toBeNull();
      TestBed.resetTestingModule();
      const second = createAt('/treino/?instalar=abc', { userAgent: UA.android });
      window.dispatchEvent(installPromptEvent());
      expect(second.sheet()).toBeNull();
    });

    it('depois da carga com marcador: tira o marcador do endereço e abre a folha quando o pedido chega', () => {
      sessionStorage.setItem(INSTALL_INTENT_KEY, 'tok');
      const service = createAt('/treino/?instalar=tok&x=1#a', { userAgent: UA.android });
      expect(location.pathname + location.search + location.hash).toBe('/treino/?x=1#a');
      expect(service.sheet()).toBeNull();
      window.dispatchEvent(installPromptEvent());
      expect(service.sheet()).toBe('manual');
    });

    it('com marcador mas sem pedido do navegador, abre a folha depois da espera', () => {
      vi.useFakeTimers();
      try {
        sessionStorage.setItem(INSTALL_INTENT_KEY, 'tok');
        const service = createAt('/treino/?instalar=tok', { userAgent: UA.android });
        vi.advanceTimersByTime(INSTALL_OFFER_WAIT_MS);
        expect(service.sheet()).toBe('manual');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a folha automática abre uma vez por app: depois da raiz, o Treino ganha a sua vez', () => {
      const service = createAt('/', { userAgent: UA.safari });
      service.openAuto();
      service.closeSheet();
      expect(service.autoEligible()).toBe(false);
      goTo('/treino');
      expect(service.autoEligible()).toBe(true);
    });

    it('navegar entre módulos continua sendo navegação interna (sem recarregar)', () => {
      const service = createAt('/', { userAgent: UA.android });
      goTo('/tv');
      goTo('/treino');
      expect(navigations).toEqual([]);
      expect(service.sheet()).toBeNull();
    });
  });
});
