import { TestBed } from '@angular/core/testing';
import { Navigation, Router } from '@angular/router';
import { EMPTY } from 'rxjs';
import { InstallHintAnswers, PreferencesApi } from '../modules/preferences-api';
import { SessionState } from '../session/session-state';
import { InstallEnvInput } from './install-env';
import { INSTALL_HINT_DELAY_MS, InstallHint } from './install-hint';
import { INSTALL_ENV, INSTALL_HINT_KEY, InstallHintService } from './install-hint.service';

/**
 * A folha hospedada na casca, com a conta no meio: espera a resposta da conta antes de abrir, nunca abre dentro do app
 * instalado e não volta quando a sessão renova o token ("atualizar a conta") nem a cada carga.
 */
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const SAFARI = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
const ACCOUNT = 'conta-da-alice';

/** Um JWT só com o `sub` (o app só lê o payload para saber de quem é o token). */
function jwtOf(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none' })}.${part({ sub })}.assinatura`;
}

describe('InstallHint com a conta', () => {
  let api: {
    getInstallHint: ReturnType<typeof vi.fn>;
    saveInstallHint: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api = {
      getInstallHint: vi.fn().mockResolvedValue({}),
      saveInstallHint: vi.fn().mockResolvedValue({}),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('dialog[open]').forEach((d) => d.remove());
    localStorage.clear();
    sessionStorage.clear();
  });

  function signIn(session: SessionState, token = jwtOf(ACCOUNT)): void {
    session.setToken(token, 600);
    session.setUser({
      id: ACCOUNT,
      email: 'alice@exemplo.com',
      displayName: 'Alice',
      role: 'guest',
    });
  }

  function setup(env: InstallEnvInput = { userAgent: SAFARI }) {
    TestBed.configureTestingModule({
      providers: [
        { provide: INSTALL_ENV, useValue: env },
        { provide: PreferencesApi, useValue: api },
        {
          provide: Router,
          useValue: { currentNavigation: () => null as Navigation | null, events: EMPTY },
        },
      ],
    });
    const session = TestBed.inject(SessionState);
    signIn(session);
    const hint = TestBed.inject(InstallHintService);
    const fixture = TestBed.createComponent(InstallHint);
    fixture.detectChanges();
    const sheet = () =>
      (fixture.nativeElement as HTMLElement).querySelector('app-install-hint-sheet');
    const count = () =>
      (fixture.nativeElement as HTMLElement).querySelectorAll('app-install-hint-sheet').length;
    const tick = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return { fixture, session, hint, sheet, count, tick };
  }

  function reloadApp() {
    TestBed.resetTestingModule();
  }

  it('espera a resposta da conta: com a resposta pendente nem os 3 s a abrem, e o "nunca" da conta a cancela de vez', async () => {
    let answer!: (value: InstallHintAnswers) => void;
    api.getInstallHint.mockReturnValue(
      new Promise<InstallHintAnswers>((resolve) => (answer = resolve)),
    );
    const { sheet, tick } = setup();
    await tick(INSTALL_HINT_DELAY_MS + 1000); // dentro do prazo de espera da conta
    expect(sheet()).toBeNull();

    answer({ root: { never: true } });
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('a conta sem resposta nenhuma deixa a folha abrir 3 s depois, uma vez', async () => {
    const { sheet, tick, hint } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 1);
    expect(sheet()).toBeNull();
    await tick(1);
    expect(sheet()).not.toBeNull();
    expect(api.getInstallHint).toHaveBeenCalledTimes(1);
    hint.closeSheet();
    await tick(20 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('renovar o token ou recarregar o usuário (atualizar a conta) não rearma a folha nem refaz a consulta', async () => {
    const { sheet, tick, session, hint } = setup();
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).not.toBeNull();
    hint.closeSheet();

    for (let i = 0; i < 3; i++) {
      session.setToken(jwtOf(ACCOUNT), 600);
      signIn(session, jwtOf(ACCOUNT));
      await tick(2 * INSTALL_HINT_DELAY_MS);
    }
    expect(sheet()).toBeNull();
    expect(api.getInstallHint).toHaveBeenCalledTimes(1);
  });

  it('a renovação no meio do prazo não dobra a folha: abre uma só vez', async () => {
    const { count, tick, session } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 500);
    session.setToken(jwtOf(ACCOUNT), 600);
    await tick(INSTALL_HINT_DELAY_MS);
    expect(count()).toBe(1);
  });

  it('já respondida antes (Agora não recente no aparelho), não abre, nem depois de recarregar o app várias vezes', async () => {
    localStorage.setItem(
      INSTALL_HINT_KEY,
      JSON.stringify({ dismissedAt: Date.now() - 86_400_000 }),
    );
    for (let i = 0; i < 3; i++) {
      const { sheet, tick } = setup();
      await tick(10 * INSTALL_HINT_DELAY_MS);
      expect(sheet()).toBeNull();
      reloadApp();
    }
  });

  it('a conta lembra o "Agora não" mesmo com a memória do Safari apagada', async () => {
    api.getInstallHint.mockResolvedValue({ root: { dismissedAt: Date.now() - 86_400_000 } });
    const { sheet, tick } = setup();
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('outra conta no mesmo aparelho não herda o "nunca" da anterior: a dela é perguntada, uma vez', async () => {
    api.getInstallHint.mockImplementation(async () => ({}));
    const first = setup();
    first.hint.never();
    await first.tick(10 * INSTALL_HINT_DELAY_MS);
    expect(first.sheet()).toBeNull();
    reloadApp();
    sessionStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        { provide: INSTALL_ENV, useValue: { userAgent: SAFARI } },
        { provide: PreferencesApi, useValue: api },
        {
          provide: Router,
          useValue: { currentNavigation: () => null as Navigation | null, events: EMPTY },
        },
      ],
    });
    const session = TestBed.inject(SessionState);
    session.setToken(jwtOf('conta-do-raphael'), 600);
    session.setUser({
      id: 'conta-do-raphael',
      email: 'raphael@exemplo.com',
      displayName: 'Raphael',
      role: 'guest',
    });
    const fixture = TestBed.createComponent(InstallHint);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(INSTALL_HINT_DELAY_MS);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('app-install-hint-sheet'),
    ).not.toBeNull();
  });

  it('dentro do app instalado nunca abre, nem com a conta sem resposta, nem depois de renovar a sessão', async () => {
    const { sheet, tick, session } = setup({ userAgent: SAFARI, standalone: true });
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
    session.setToken(jwtOf(ACCOUNT), 600);
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('a folha que abriu e foi ignorada (app fechado e reaberto na mesma sessão) não volta', async () => {
    const first = setup();
    await first.tick(INSTALL_HINT_DELAY_MS);
    expect(first.sheet()).not.toBeNull();
    reloadApp();

    const second = setup();
    await second.tick(20 * INSTALL_HINT_DELAY_MS);
    expect(second.sheet()).toBeNull();
  });
});
