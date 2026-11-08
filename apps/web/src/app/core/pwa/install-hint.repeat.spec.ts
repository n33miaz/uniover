import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { PreferencesApi } from '../modules/preferences-api';
import { InstallEnvInput } from './install-env';
import {
  INSTALL_ENV,
  INSTALL_HINT_KEY,
  INSTALL_HINT_SESSION_KEY,
  INSTALL_HINT_SNOOZE_MS,
  INSTALL_HINT_SYNC_TIMEOUT_MS,
  InstallHintService,
  installHintKey,
} from './install-hint.service';

/**
 * A dica "adicionar à tela de início" não pode voltar para quem já instalou ou já respondeu (o relato da Alice, que usa o app
 * instalado no iPhone havia muito tempo e via a pergunta de novo). Cada teste é uma das formas de ela voltar.
 */
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT}`;
const SAFARI = `${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`;
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;

/** O que a memória do aparelho guarda de um app para uma conta (nulo se nada). */
function inAccount(scope: 'root' | 'tv' | 'treino', account: string): unknown {
  return JSON.parse(localStorage.getItem(installHintKey(scope, account)) ?? 'null');
}

describe('a dica de instalação não volta para quem já respondeu', () => {
  let api: {
    getInstallHint: ReturnType<typeof vi.fn>;
    saveInstallHint: ReturnType<typeof vi.fn>;
  };
  let events: Subject<unknown>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
    api = {
      getInstallHint: vi.fn().mockResolvedValue({}),
      saveInstallHint: vi.fn().mockResolvedValue({}),
    };
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
    localStorage.clear();
    sessionStorage.clear();
  });

  function create(env: InstallEnvInput, loadedAt = '/'): InstallHintService {
    history.replaceState(null, '', loadedAt);
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        { provide: INSTALL_ENV, useValue: env },
        { provide: PreferencesApi, useValue: api },
        { provide: Router, useValue: { events } },
      ],
    });
    const service = TestBed.inject(InstallHintService);
    service.start();
    return service;
  }
  /** O jsdom não tem `matchMedia`: o navegador de verdade passa a ter um, que responde como o teste mandar. */
  const fakeMatchMedia = (answer: (query: string) => object) =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => answer(query),
    });
  const goTo = (url: string) => events.next(new NavigationEnd(1, url, url));
  const reload = (env: InstallEnvInput, loadedAt = '/') => {
    TestBed.resetTestingModule();
    return create(env, loadedAt);
  };

  describe('dentro do app instalado nunca abre sozinha', () => {
    it.each<[string, InstallEnvInput]>([
      ['iPhone (navigator.standalone)', { userAgent: SAFARI, standalone: true }],
      [
        'iPhone (display-mode: standalone)',
        { userAgent: SAFARI, matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) },
      ],
      [
        'iPhone (WebKit informa fullscreen)',
        { userAgent: SAFARI, matchMedia: (q) => ({ matches: q === '(display-mode: fullscreen)' }) },
      ],
      [
        'Android (display-mode: standalone)',
        { userAgent: ANDROID, matchMedia: () => ({ matches: true }) },
      ],
    ])('%s, com a memória vazia', (_name, env) => {
      const service = create(env);
      expect(service.autoEligible()).toBe(false);
      expect(service.autoOpenAllowed()).toBe(false);
      expect(service.autoOpenAllowed(Date.now() + 365 * DAY)).toBe(false);
    });

    it('o atalho da raiz aberto em /treino ou /tv (outro app para o navegador) também não abre sozinha', () => {
      const service = create({ userAgent: SAFARI, standalone: true }, '/?uniover_app=root');
      for (const url of ['/treino/hoje', '/tv']) {
        goTo(url);
        expect(service.foreignAppWindow()).toBe(true);
        expect(service.mode()).toBe('ios-in-app');
        expect(service.autoEligible()).toBe(false);
        expect(service.autoOpenAllowed()).toBe(false);
      }
    });

    it('depois de atualizar e recarregar dentro do atalho, continua sem abrir', () => {
      for (let i = 0; i < 3; i++) {
        const service = reload({ userAgent: SAFARI, standalone: true });
        expect(service.autoOpenAllowed(Date.now() + 365 * DAY)).toBe(false);
      }
    });

    it('relê a janela de verdade na hora de abrir: um ambiente guardado desatualizado não deixa passar', () => {
      const service = create({ userAgent: SAFARI });
      expect(service.autoOpenAllowed()).toBe(true);
      fakeMatchMedia((query) => ({ matches: query === '(display-mode: standalone)' }));
      expect(service.autoOpenAllowed()).toBe(false);
    });

    it('virar app instalado sem recarregar (a media query muda) a desliga na hora', () => {
      let listener: (() => void) | undefined;
      const mql = {
        matches: false,
        addEventListener: (_: string, fn: () => void) => (listener = fn),
        removeEventListener: () => undefined,
      };
      fakeMatchMedia(() => mql);
      const service = create({ userAgent: SAFARI });
      expect(service.autoEligible()).toBe(true);
      mql.matches = true;
      listener?.();
      expect(service.autoEligible()).toBe(false);
    });

    it('a janela instalada guarda "instalado" só no aparelho (no balde da conta) e nunca o envia à conta', async () => {
      const service = create({ userAgent: SAFARI, standalone: true });
      // Antes de a sessão ser confirmada ainda não há de quem seja: fica no balde do aparelho.
      expect(JSON.parse(localStorage.getItem(INSTALL_HINT_KEY)!)).toEqual({ installed: true });
      await service.syncAccount(ACCOUNT);
      expect(inAccount('root', ACCOUNT)).toEqual({ installed: true });
      // As chaves antigas ficam onde estão: um pacote antigo (ou um recuo de versão) ainda acha a memória.
      expect(JSON.parse(localStorage.getItem(INSTALL_HINT_KEY)!)).toEqual({ installed: true });
      expect(api.saveInstallHint).not.toHaveBeenCalled();
      service.never();
      expect(api.saveInstallHint).toHaveBeenCalledWith({ root: { never: true } });
    });

    it.each<[string, string, 'root' | 'tv' | 'treino' | null]>([
      ['a raiz aberta no endereço de partida', '/', 'root'],
      ['o Treino aberto no endereço de partida', '/treino/', 'treino'],
      ['a TV aberta no endereço de partida (sem a barra final)', '/tv', 'tv'],
      ['um link fundo dentro do app (pode ser de outro atalho)', '/treino/hoje', null],
      ['uma tela da raiz que não é a de partida', '/ajustes/aparencia', null],
    ])('iOS sem marcador de lançamento: %s', (_name, path, marked) => {
      create({ userAgent: SAFARI, standalone: true }, path);
      const stored = {
        root: localStorage.getItem(installHintKey('root')),
        tv: localStorage.getItem(installHintKey('tv')),
        treino: localStorage.getItem(installHintKey('treino')),
      };
      for (const scope of ['root', 'tv', 'treino'] as const) {
        expect(stored[scope] === null ? null : JSON.parse(stored[scope])).toEqual(
          scope === marked ? { installed: true } : null,
        );
      }
    });
  });

  describe('o que já foi respondido fica respondido', () => {
    it('"Agora não" vale 30 dias, e só no navegador', () => {
      const service = create({ userAgent: SAFARI });
      const t0 = Date.UTC(2026, 10, 1);
      service.dismiss(t0);
      expect(INSTALL_HINT_SNOOZE_MS).toBe(30 * DAY);
      expect(service.autoOpenAllowed(t0 + 29 * DAY)).toBe(false);
      expect(service.autoOpenAllowed(t0 + 30 * DAY)).toBe(true);
    });

    it('"já instalei" e "nunca" valem para sempre, para o app em que foram ditos', () => {
      const first = create({ userAgent: SAFARI });
      first.acknowledgeInstalled();
      expect(first.autoOpenAllowed(Date.now() + 5 * 365 * DAY)).toBe(false);
      expect(reload({ userAgent: SAFARI }).autoOpenAllowed(Date.now() + 5 * 365 * DAY)).toBe(false);
    });

    it('a folha que abriu e nunca foi respondida (o iOS matou a página, a atualização recarregou) não volta na carga seguinte', () => {
      const service = create({ userAgent: SAFARI });
      service.openAuto(Date.UTC(2026, 10, 1));
      expect(JSON.parse(localStorage.getItem(INSTALL_HINT_KEY)!)).toEqual({
        dismissedAt: Date.UTC(2026, 10, 1),
      });
      sessionStorage.clear(); // o app foi fechado de vez: só a memória do aparelho resta
      const next = reload({ userAgent: SAFARI });
      expect(next.autoOpenAllowed(Date.UTC(2026, 10, 1) + 29 * DAY)).toBe(false);
      expect(next.autoOpenAllowed(Date.UTC(2026, 10, 1) + 30 * DAY)).toBe(true);
    });

    it('no máximo uma vez por sessão, mesmo sem nada gravado no aparelho', () => {
      const service = create({ userAgent: SAFARI });
      service.openAuto();
      service.closeSheet();
      expect(sessionStorage.getItem(INSTALL_HINT_SESSION_KEY)).toBe('1');
      localStorage.clear(); // o Safari apagou os dados do site no meio da sessão
      const next = reload({ userAgent: SAFARI });
      expect(next.autoEligible()).toBe(false);
      expect(next.autoOpenAllowed(Date.now() + 365 * DAY)).toBe(false);
    });

    it('o "Agora não" dado num app adia os outros: um pedido só a cada 30 dias, não um por app', () => {
      const service = create({ userAgent: SAFARI });
      service.dismiss(Date.UTC(2026, 10, 1));
      sessionStorage.clear();
      const next = reload({ userAgent: SAFARI }, '/treino/');
      expect(next.autoOpenAllowed(Date.UTC(2026, 10, 2))).toBe(false);
      expect(next.autoOpenAllowed(Date.UTC(2026, 10, 1) + 30 * DAY)).toBe(true);
      expect(localStorage.getItem(installHintKey('treino'))).toBeNull();
    });

    it('sem nenhum armazenamento, a resposta vale pelo menos na página', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('bloqueado', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('bloqueado', 'SecurityError');
      });
      const service = create({ userAgent: SAFARI });
      service.openAuto();
      service.closeSheet();
      expect(service.autoEligible()).toBe(false);
    });
  });

  describe('a conta lembra por quem teve a memória do Safari apagada', () => {
    it('a conta que disse "nunca": nada de pergunta, e o aparelho guarda a resposta', async () => {
      api.getInstallHint.mockResolvedValue({ root: { never: true } });
      const service = create({ userAgent: SAFARI });
      expect(service.autoEligible()).toBe(true); // antes de a conta responder só há o aparelho

      await service.syncAccount(ACCOUNT);

      expect(service.syncedFor()).toBe(ACCOUNT);
      expect(service.autoEligible()).toBe(false);
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      expect(api.saveInstallHint).not.toHaveBeenCalled(); // a conta já sabia: nada a subir
    });

    it('"instalado" é do aparelho: se a conta o trouxer, é ignorado', async () => {
      api.getInstallHint.mockResolvedValue({ root: { installed: true }, tv: { installed: true } });
      const service = create({ userAgent: SAFARI });

      await service.syncAccount(ACCOUNT);

      expect(service.autoEligible()).toBe(true);
      expect(inAccount('root', ACCOUNT)).toBeNull();
      expect(api.saveInstallHint).not.toHaveBeenCalled();
    });

    it('"nunca" e "Agora não" da conta valem no aparelho, cada um no seu app', async () => {
      const t0 = Date.UTC(2026, 10, 1);
      api.getInstallHint.mockResolvedValue({ tv: { never: true }, treino: { dismissedAt: t0 } });
      const service = create({ userAgent: SAFARI });

      await service.syncAccount(ACCOUNT);

      // O "Agora não" do Treino adia a folha automática de todos; o "nunca" da TV fica só na TV.
      expect(service.autoOpenAllowed(t0 + DAY)).toBe(false);
      expect(service.autoOpenAllowed(t0 + 30 * DAY)).toBe(true);
      expect(inAccount('tv', ACCOUNT)).toEqual({ never: true });
      expect(inAccount('treino', ACCOUNT)).toEqual({ dismissedAt: t0 });
    });

    it('funde sem desfazer: o instante mais novo e os "sim" de cada lado, e "instalado" fica no aparelho', async () => {
      const t = Date.UTC(2026, 10, 1);
      localStorage.setItem(
        INSTALL_HINT_KEY,
        JSON.stringify({ dismissedAt: t + 5, never: true, installed: true }),
      );
      api.getInstallHint.mockResolvedValue({ root: { dismissedAt: t } });
      const service = create({ userAgent: SAFARI });

      await service.syncAccount(ACCOUNT);

      expect(inAccount('root', ACCOUNT)).toEqual({
        dismissedAt: t + 5,
        never: true,
        installed: true,
      });
      // Falta na conta o "nunca" e o instante mais novo: sobem juntos, sem o "instalado".
      expect(api.saveInstallHint).toHaveBeenCalledWith({
        root: { dismissedAt: t + 5, never: true },
      });
    });

    it('o que o aparelho sabia e a conta não: sobe uma vez; depois cada resposta nova sobe na hora', async () => {
      localStorage.setItem(installHintKey('tv'), JSON.stringify({ never: true }));
      const service = create({ userAgent: SAFARI });

      await service.syncAccount(ACCOUNT);
      expect(api.saveInstallHint).toHaveBeenCalledTimes(1);
      expect(api.saveInstallHint).toHaveBeenCalledWith({ tv: { never: true } });

      service.dismiss(Date.UTC(2026, 10, 2));
      expect(api.saveInstallHint).toHaveBeenLastCalledWith({
        root: { dismissedAt: Date.UTC(2026, 10, 2) },
      });
    });

    it('antes de a conta ser casada nada sobe (a resposta de outra conta nunca vai para esta)', () => {
      const service = create({ userAgent: SAFARI });
      service.dismiss();
      expect(api.saveInstallHint).not.toHaveBeenCalled();
    });

    it('a conta que não responde (falha ou demora) não trava nem derruba: segue com o aparelho', async () => {
      api.getInstallHint.mockRejectedValue(new Error('sem rede'));
      const offline = create({ userAgent: SAFARI });
      await expect(offline.syncAccount(ACCOUNT)).resolves.toBeUndefined();
      expect(offline.syncedFor()).toBe(ACCOUNT);
      expect(offline.autoEligible()).toBe(true);

      vi.useFakeTimers();
      api.getInstallHint.mockReturnValue(new Promise(() => undefined));
      const slow = reload({ userAgent: SAFARI });
      const done = slow.syncAccount(ACCOUNT);
      expect(slow.syncedFor()).toBeNull();
      await vi.advanceTimersByTimeAsync(INSTALL_HINT_SYNC_TIMEOUT_MS);
      await done;
      expect(slow.syncedFor()).toBe(ACCOUNT);
    });

    it('a conta que nunca respondeu (objeto vazio) vale como "nada respondido" e não sobe nada', async () => {
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      expect(api.saveInstallHint).not.toHaveBeenCalled();
      expect(service.autoEligible()).toBe(true);
    });

    it('se a leitura da conta falhou, o que ficou para trás sobe na próxima leitura bem-sucedida', async () => {
      api.getInstallHint.mockRejectedValueOnce(new Error('sem rede'));
      api.saveInstallHint.mockRejectedValue(new Error('sem rede'));
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      service.never(); // o envio falha: fica só no aparelho
      expect(api.saveInstallHint).toHaveBeenCalledTimes(1);

      api.saveInstallHint.mockResolvedValue({});
      await service.syncAccount(ACCOUNT); // outra chamada (a sessão mudou de novo): lê a conta de novo
      expect(api.getInstallHint).toHaveBeenCalledTimes(2);
      expect(api.saveInstallHint).toHaveBeenCalledTimes(2);
      expect(api.saveInstallHint).toHaveBeenLastCalledWith({ root: { never: true } });

      await service.syncAccount(ACCOUNT); // já casada: não lê nem envia de novo
      expect(api.getInstallHint).toHaveBeenCalledTimes(2);
    });

    it('renovar o token (a sessão piscar) não pergunta de novo à conta nem refaz a espera', async () => {
      const service = create({ userAgent: SAFARI });
      await Promise.all([service.syncAccount(ACCOUNT), service.syncAccount(ACCOUNT)]);
      await service.syncAccount(ACCOUNT);
      expect(api.getInstallHint).toHaveBeenCalledTimes(1);
    });

    it('se a sessão virou outra conta enquanto a resposta vinha, ela é descartada', async () => {
      api.getInstallHint.mockResolvedValue({ root: { installed: true } });
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT, () => false);
      expect(service.syncedFor()).toBeNull();
      expect(inAccount('root', ACCOUNT)).toBeNull();
      expect(localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
      expect(service.autoEligible()).toBe(true);
    });
  });

  describe('"Agora não" nunca vale mais que agora + 1 dia', () => {
    const future = () => Date.now() + 400 * DAY;

    it('um valor futuro no aparelho não vale: vale o da conta, que é menor', async () => {
      const serverValue = Date.now() - 2 * DAY;
      localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ dismissedAt: future() }));
      api.getInstallHint.mockResolvedValue({ root: { dismissedAt: serverValue } });
      const service = create({ userAgent: SAFARI });
      expect(service.autoOpenAllowed(Date.now() + 400 * DAY)).toBe(true);

      await service.syncAccount(ACCOUNT);

      expect(inAccount('root', ACCOUNT)).toEqual({ dismissedAt: serverValue });
      expect(service.autoOpenAllowed(Date.now() + 31 * DAY)).toBe(true);
      expect(service.autoOpenAllowed(Date.now())).toBe(false);
    });

    it('um valor futuro vindo da conta é ignorado, e um dado agora (dentro de 1 dia de folga) vale', async () => {
      api.getInstallHint.mockResolvedValue({ root: { dismissedAt: future() } });
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      expect(inAccount('root', ACCOUNT)).toBeNull();

      const edge = Date.now() + DAY / 2;
      service.dismiss(edge);
      expect(inAccount('root', ACCOUNT)).toEqual({ dismissedAt: edge });
    });

    it('dismiss e a abertura automática com um relógio errado não gravam o futuro', async () => {
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      service.dismiss(future());
      expect(inAccount('root', ACCOUNT)).toEqual({});
      service.openAuto(future());
      expect(inAccount('root', ACCOUNT)).toEqual({});
      expect(api.saveInstallHint).not.toHaveBeenCalled();
    });
  });

  describe('"já instalei" soma, não apaga', () => {
    it('acknowledgeInstalled guarda junto com o "Agora não" e o "nunca" que já havia', async () => {
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      service.dismiss(Date.UTC(2026, 10, 1));
      service.never();
      service.acknowledgeInstalled();
      expect(inAccount('root', ACCOUNT)).toEqual({
        dismissedAt: Date.UTC(2026, 10, 1),
        never: true,
        installed: true,
      });
    });
  });

  describe('a memória do aparelho é por conta', () => {
    it('o "nunca" de uma conta não vale nem sobe para outra no mesmo aparelho', async () => {
      const first = create({ userAgent: SAFARI });
      await first.syncAccount(ACCOUNT);
      first.never();
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      api.saveInstallHint.mockClear();

      // A outra pessoa entra no mesmo aparelho (a página recarrega): a conta dela começa limpa.
      const second = reload({ userAgent: SAFARI });
      await second.syncAccount(OTHER);
      expect(second.autoEligible()).toBe(true);
      expect(inAccount('root', OTHER)).toBeNull();
      expect(api.saveInstallHint).not.toHaveBeenCalled();
      // E a da primeira segue intacta.
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
    });

    it('trocar de conta sem recarregar a página também não vaza: a nova não herda a anterior, e o que ela diz vai só para ela', async () => {
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      service.never();
      expect(service.autoEligible()).toBe(false);
      api.saveInstallHint.mockClear();

      const other = service.syncAccount(OTHER);
      await other;
      expect(service.syncedFor()).toBe(OTHER);
      expect(service.autoEligible()).toBe(true);
      service.dismiss(Date.UTC(2026, 10, 3));
      expect(inAccount('root', OTHER)).toEqual({ dismissedAt: Date.UTC(2026, 10, 3) });
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      expect(api.saveInstallHint).toHaveBeenCalledTimes(1);
      expect(api.saveInstallHint).toHaveBeenCalledWith({
        root: { dismissedAt: Date.UTC(2026, 10, 3) },
      });
    });

    it('o que o aparelho guardava sem conta (versões antigas) vai para a primeira conta que se confirma, e só para ela', async () => {
      localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ never: true }));
      localStorage.setItem(installHintKey('tv'), JSON.stringify({ installed: true }));
      const first = create({ userAgent: SAFARI });
      await first.syncAccount(ACCOUNT);

      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      expect(inAccount('tv', ACCOUNT)).toEqual({ installed: true });
      // As chaves antigas ficam onde estão (um pacote antigo ainda as acha), mas só a primeira conta as herda.
      expect(JSON.parse(localStorage.getItem(INSTALL_HINT_KEY)!)).toEqual({ never: true });
      expect(JSON.parse(localStorage.getItem(installHintKey('tv'))!)).toEqual({ installed: true });
      expect(api.saveInstallHint).toHaveBeenCalledTimes(1);
      expect(api.saveInstallHint).toHaveBeenCalledWith({ root: { never: true } });

      api.saveInstallHint.mockClear();
      const second = reload({ userAgent: SAFARI });
      await second.syncAccount(OTHER);
      expect(second.autoEligible()).toBe(true);
      expect(api.saveInstallHint).not.toHaveBeenCalled();
    });

    it('uma resposta dada enquanto a conta troca (a anterior saiu, a nova não se confirmou) não cai no balde do aparelho nem no da anterior', async () => {
      const service = create({ userAgent: SAFARI });
      await service.syncAccount(ACCOUNT);
      service.never();
      let answer!: (value: object) => void;
      api.getInstallHint.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      api.saveInstallHint.mockClear();

      const switching = service.syncAccount(OTHER);
      service.dismiss(Date.UTC(2026, 10, 3)); // no meio da troca
      expect(localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
      expect(inAccount('root', OTHER)).toBeNull();
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      expect(api.saveInstallHint).not.toHaveBeenCalled();

      answer({});
      await switching;
      // Confirmada a conta nova, o que foi dito no meio entra no balde dela, e só nele.
      expect(inAccount('root', OTHER)).toEqual({ dismissedAt: Date.UTC(2026, 10, 3) });
      expect(inAccount('root', ACCOUNT)).toEqual({ never: true });
      expect(localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
      expect(api.saveInstallHint).toHaveBeenCalledWith({
        root: { dismissedAt: Date.UTC(2026, 10, 3) },
      });
    });

    it('a chave por conta tem o formato uniover.install-hint.v2.<conta>.<app>', () => {
      expect(installHintKey('root', ACCOUNT)).toBe(`uniover.install-hint.v2.${ACCOUNT}.root`);
      expect(installHintKey('treino', 'a/b c')).toBe('uniover.install-hint.v2.a%2Fb%20c.treino');
      expect(installHintKey('tv')).toBe('uniover.install-hint.v1.tv');
    });
  });
});
