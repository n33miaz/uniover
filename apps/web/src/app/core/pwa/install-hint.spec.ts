import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Navigation, Router } from '@angular/router';
import { EMPTY } from 'rxjs';
import { SessionState } from '../session/session-state';
import { InstallEnvInput } from './install-env';
import { INSTALL_HINT_DELAY_MS, INSTALL_HINT_MAX_ATTEMPTS, InstallHint } from './install-hint';
import { INSTALL_ENV, INSTALL_HINT_KEY, InstallHintService } from './install-hint.service';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const SAFARI = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Outro diálogo da tela (a passkey, os apps da TV...): enquanto estiver aberto, a dica não interrompe. */
@Component({ selector: 'app-other-dialog', template: '<dialog class="other"></dialog>' })
class OtherDialog {}

describe('InstallHint', () => {
  const navigation = signal<Navigation | null>(null);

  beforeEach(() => {
    localStorage.clear();
    navigation.set(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('dialog[open]').forEach((d) => d.remove());
    localStorage.clear();
  });

  function setup(env: InstallEnvInput = { userAgent: SAFARI }, signedIn = true) {
    TestBed.configureTestingModule({
      providers: [
        { provide: INSTALL_ENV, useValue: env },
        { provide: Router, useValue: { currentNavigation: navigation, events: EMPTY } },
      ],
    });
    const session = TestBed.inject(SessionState);
    if (signedIn) session.setToken('t', 600);
    const hint = TestBed.inject(InstallHintService);
    const fixture = TestBed.createComponent(InstallHint);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const sheet = () => el.querySelector('app-install-hint-sheet');
    const tick = async (ms: number) => {
      vi.advanceTimersByTime(ms);
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return { fixture, session, hint, el, sheet, tick };
  }

  /** Abre outro diálogo na tela (depois do setup, que configura o TestBed). */
  function openOtherDialog(): HTMLDialogElement {
    const other = TestBed.createComponent(OtherDialog);
    other.detectChanges();
    const dialog = other.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.setAttribute('open', '');
    return dialog;
  }

  it('com um pedido de espera (treino ao vivo), nem os 30 s de tentativas a abrem; ao soltar, o prazo recomeça', async () => {
    const { sheet, tick, hint } = setup();
    const release = hint.holdAuto();
    await tick(INSTALL_HINT_MAX_ATTEMPTS * INSTALL_HINT_DELAY_MS * 3);
    expect(sheet()).toBeNull();

    release();
    await tick(INSTALL_HINT_DELAY_MS - 1);
    expect(sheet()).toBeNull();
    await tick(1);
    expect(sheet()).not.toBeNull();
  });

  it('um pedido de espera que chega no meio do prazo cancela a abertura que estava armada', async () => {
    const { sheet, tick, hint } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 100);
    const release = hint.holdAuto();
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
    release();
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).not.toBeNull();
  });

  it('não desenha nada enquanto a folha está fechada (nenhum elemento fixo na tela)', () => {
    const { el } = setup();
    expect(el.children).toHaveLength(0);
    expect(el.querySelector('button, a, dialog')).toBeNull();
  });

  it('abre sozinha, uma vez, 3 s depois da tela pronta, com a sessão confirmada', async () => {
    const { sheet, tick, hint } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 1);
    expect(sheet()).toBeNull();
    await tick(1);
    expect(sheet()).not.toBeNull();
    expect(hint.sheet()).toBe('auto');
    // Fechada, não volta (mesmo sem armazenamento a folha aparece uma vez por página).
    hint.closeSheet();
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('só conta o prazo depois de a sessão estar confirmada', async () => {
    const { sheet, tick, session } = setup({ userAgent: SAFARI }, false);
    await tick(5 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
    session.setToken('t', 600);
    await tick(INSTALL_HINT_DELAY_MS - 1);
    expect(sheet()).toBeNull();
    await tick(1);
    expect(sheet()).not.toBeNull();
  });

  it('sair da sessão antes do prazo o cancela', async () => {
    const { sheet, tick, session } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 100);
    session.clear();
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('destruir a casca antes do prazo o cancela', async () => {
    const { fixture, hint, tick } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 100);
    fixture.destroy();
    vi.advanceTimersByTime(10 * INSTALL_HINT_DELAY_MS);
    expect(hint.sheet()).toBeNull();
  });

  it('não abre onde não há o que oferecer (computador)', async () => {
    const { sheet, tick } = setup({ userAgent: DESKTOP });
    await tick(5 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('respeita o "Agora não" e o "Não mostrar de novo"', async () => {
    localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ dismissedAt: Date.now() }));
    const snoozed = setup();
    await snoozed.tick(5 * INSTALL_HINT_DELAY_MS);
    expect(snoozed.sheet()).toBeNull();
    TestBed.resetTestingModule();

    localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ never: true }));
    const never = setup();
    await never.tick(5 * INSTALL_HINT_DELAY_MS);
    expect(never.sheet()).toBeNull();
  });

  it('com "Agora não" de mais de 14 dias, volta a abrir', async () => {
    localStorage.setItem(
      INSTALL_HINT_KEY,
      JSON.stringify({ dismissedAt: Date.now() - 15 * 24 * 60 * 60 * 1000 }),
    );
    const { sheet, tick } = setup();
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).not.toBeNull();
  });

  it('com outro diálogo aberto não interrompe: espera e abre quando ele sair', async () => {
    const { sheet, tick } = setup();
    const otherDialog = openOtherDialog();
    await tick(3 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();

    otherDialog.removeAttribute('open');
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).not.toBeNull();
  });

  it('desiste depois de várias tentativas com a tela ocupada', async () => {
    const { sheet, tick } = setup();
    const otherDialog = openOtherDialog();
    await tick((INSTALL_HINT_MAX_ATTEMPTS + 2) * INSTALL_HINT_DELAY_MS);
    otherDialog.removeAttribute('open');
    await tick(5 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('numa navegação em curso, ou com a página em segundo plano, espera', async () => {
    const { sheet, tick } = setup();
    navigation.set({} as Navigation);
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
    navigation.set(null);

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
    hidden.mockReturnValue('visible');
    await tick(INSTALL_HINT_DELAY_MS);
    expect(sheet()).not.toBeNull();
  });

  it('se a pessoa disser "nunca" (ou instalar) durante a espera, não abre', async () => {
    const { sheet, tick, hint } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 100);
    hint.never();
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('hospeda a abertura manual (as linhas de Ajustes e de Personalizar), sem prazo e ignorando "nunca"', async () => {
    localStorage.setItem(INSTALL_HINT_KEY, JSON.stringify({ never: true }));
    const { sheet, hint, fixture } = setup();
    hint.open();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(sheet()).not.toBeNull();
    expect(hint.sheet()).toBe('manual');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')).map((b) =>
      (b as HTMLElement).textContent?.trim(),
    );
    expect(buttons).toEqual(['Fechar']);
  });

  it('a automática não aparece logo depois de uma aberta pela pessoa', async () => {
    const { sheet, hint, tick } = setup();
    await tick(INSTALL_HINT_DELAY_MS - 100);
    hint.open();
    await tick(100);
    hint.closeSheet();
    await tick(10 * INSTALL_HINT_DELAY_MS);
    expect(sheet()).toBeNull();
  });

  it('liga o ouvinte do pedido de instalação assim que a casca existe', async () => {
    const { hint, tick } = setup({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.dispatchEvent(event);
    await tick(0);
    expect(hint.mode()).toBe('native');
  });
});
