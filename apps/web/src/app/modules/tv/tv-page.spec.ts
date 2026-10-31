import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { collectShellData } from '../../core/layout/route-data';
import { SessionState } from '../../core/session/session-state';
import { TvPrefs, tvPrefsStorageKey } from './data/tv-prefs';
import { TvSelection } from './data/tv-selection';
import { TvStore } from './data/tv-store';
import { TvPage } from './tv-page';
import { FakeTvStore, createFakeTvStore, makeTv } from './tv-test-kit';
import { TV_ROUTES } from './tv.routes';

describe('TvPage', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TvPage>>;
  let root: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const byLabel = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const dialogs = () => [...root.querySelectorAll<HTMLDialogElement>('app-tv-panel dialog')];
  /** Os três pontos do cabeçalho abrem o menu; o Apps da TV é uma linha dele. */
  const menuButton = () =>
    root.querySelector<HTMLButtonElement>('.head button[aria-label="Mais opções"]')!;
  const menuRow = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('app-tv-menu button.ui-row')].find((row) =>
      row.textContent?.includes(name),
    )!;
  /** O caminho de quem usa a tela: abre o menu e toca na linha. O menu sai antes de o painel abrir (um modal por vez). */
  const openApps = async () => {
    menuButton().click();
    await render();
    menuRow('Apps da TV').click();
    await render();
    await render();
  };
  const titleButton = () => root.querySelector<HTMLButtonElement>('h1 button')!;
  const customizeSheet = () => root.querySelector<HTMLElement>('app-tv-customize-sheet dialog');
  const prefsKey = () =>
    tvPrefsStorageKey(TestBed.inject(SessionState).accountId() ?? 'tv-page-user');

  beforeEach(async () => {
    localStorage.clear();
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    TestBed.inject(SessionState).setUser({
      id: 'tv-page-user',
      email: 'tv@example.com',
      displayName: 'TV',
    });
    fixture = TestBed.createComponent(TvPage);
    root = fixture.nativeElement;
    await render();
  });

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('starts the store when it is created and stops it when it is destroyed', () => {
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.stop).not.toHaveBeenCalled();
    fixture.destroy();
    expect(store.stop).toHaveBeenCalledTimes(1);
  });

  describe('header', () => {
    it('has back and menu on the left, the name TV as the h1 with the state dot beside it, and power on the right', () => {
      const back = root.querySelector('a.back')!;
      expect(back.getAttribute('href')).toBe('/');
      expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');
      const h1 = root.querySelector('h1')!;
      expect(h1.textContent?.trim()).toBe('TV');
      // O ponto fica ao lado do título (não dentro): o nome do botão não vira parte do nome do título.
      expect(h1.querySelector('app-status-indicator')).toBeNull();
      expect(h1.nextElementSibling?.matches('app-status-indicator')).toBe(true);
      expect(byLabel('Desligar a TV')).not.toBeNull();
      // O menu fica ao lado da saída, e o desligar fecha a navegação do cabeçalho à direita.
      expect(
        [...root.querySelectorAll('.head .actions button')].map((b) =>
          b.getAttribute('aria-label'),
        ),
      ).toEqual(['Desligar a TV']);
      expect(
        [...root.querySelectorAll('.head .lead > *')].map((b) => b.getAttribute('aria-label')),
      ).toEqual(['Voltar ao Início', 'Mais opções']);
    });

    it('lays the header out as the left group, the name and the right group, in that order', () => {
      const head = root.querySelector('.head')!;
      expect([...head.children].map((el) => el.className.split(' ')[0])).toEqual([
        'lead',
        'name',
        'actions',
      ]);
    });

    it('draws the menu as three dots in a column, with an accessible name that says it is a dialog', () => {
      const menu = menuButton();
      expect(menu.getAttribute('aria-label')).toBe('Mais opções');
      expect(menu.getAttribute('aria-haspopup')).toBe('dialog');
      expect(menu.classList.contains('circle')).toBe(true);
      expect(menu.textContent?.trim()).toBe('');
      // Três pontos, um sobre o outro (mesmo x, y diferentes): três círculos no traço do ícone.
      const path = menu.querySelector('app-tv-icon path')!.getAttribute('d')!;
      expect(path.match(/M/g)).toHaveLength(3);
      expect(path).toContain('a1.2 1.2');
      expect(path.match(/M10\.8 \d+/g)).toHaveLength(3);
    });

    it('shows the owner the arrow back, never a settings button', () => {
      expect(root.querySelector('.head a.settings')).toBeNull();
      expect(root.querySelector('.head a[href="/ajustes"]')).toBeNull();
    });

    it('draws back as a plain arrow in a 44 px circle, with no text beside it', () => {
      const back = root.querySelector('a.back')!;
      expect(back.classList.contains('circle')).toBe(true);
      expect(back.textContent?.trim()).toBe('');
      const svg = back.querySelector('svg')!;
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('width')).toBe('22');
      expect(svg.getAttribute('height')).toBe('22');
      expect(svg.getAttribute('stroke-width')).toBe('2.2');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([
        'M19 12H5',
        'M11 18l-6-6 6-6',
      ]);
    });

    it('gives back, the menu and power the same circle', () => {
      const circles = [...root.querySelectorAll('.head .circle')];
      expect(circles).toHaveLength(3);
      expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual([
        'Voltar ao Início',
        'Mais opções',
        'Desligar a TV',
      ]);
    });

    it('no longer has the connected and hibernation pills, nor any chip row', () => {
      expect(root.querySelector('.chips, .chip')).toBeNull();
      expect(root.textContent).not.toContain('hiberna em');
      expect(root.textContent).not.toMatch(/\bconectada\b/);
    });

    it('has no tab bar and no router outlet: the control is the only screen', () => {
      expect(root.querySelector('router-outlet')).toBeNull();
      expect(root.querySelector('nav, [role="tablist"]')).toBeNull();
      expect(root.querySelector('app-tv-control')).not.toBeNull();
    });

    it('shows the reason under the header when the buttons are off', async () => {
      store.canSend.set(false);
      store.disabledReason.set(
        'O agente da TV está desligado, então os botões não funcionam agora.',
      );
      await render();
      expect(root.querySelector('.reason')?.textContent).toContain('agente da TV está desligado');
      expect(root.querySelector<HTMLButtonElement>('.power')!.disabled).toBe(true);
    });
  });

  describe('notices', () => {
    it('shows an error as an alert and an info as a status', async () => {
      store.notice.set({ kind: 'error', text: 'A TV não respondeu a tempo.' });
      await render();
      expect(root.querySelector('.toast[role="alert"]')?.textContent).toBe(
        'A TV não respondeu a tempo.',
      );

      store.notice.set({ kind: 'info', text: 'Texto enviado para a TV.' });
      await render();
      expect(root.querySelector('.toast[role="alert"]')).toBeNull();
      expect(root.querySelector('.toast[role="status"]')?.textContent).toBe(
        'Texto enviado para a TV.',
      );

      store.notice.set(null);
      await render();
      expect(root.querySelector('.toast')).toBeNull();
    });

    it('hides its own toast while a panel is open, because the panel shows the notice inside', async () => {
      await openApps();
      store.notice.set({ kind: 'error', text: 'A TV não respondeu a tempo.' });
      await render();
      expect(root.querySelector('.toast')).toBeNull();
      expect(root.querySelector('app-tv-panel .notice[role="alert"]')?.textContent).toBe(
        'A TV não respondeu a tempo.',
      );
    });
  });

  describe('states of the TV', () => {
    const unconfigure = async () => {
      store.status.set('unconfigured');
      store.canSend.set(false);
      store.disabledReason.set('Nenhum agente foi configurado para controlar a TV.');
      await render();
    };

    it('without a TV configured, the owner gets an empty state with one action, "Configurar TV", in place of the control', async () => {
      await unconfigure();
      expect(root.querySelector('app-tv-control, app-tv-view-only')).toBeNull();
      expect(root.querySelector('.reason-row')).toBeNull();
      const empty = root.querySelector('.empty')!;
      expect(empty.querySelector('h2')?.textContent?.trim()).toBe('Nenhuma TV configurada');
      const actions = empty.querySelectorAll('a, button');
      expect(actions).toHaveLength(1);
      expect(actions[0].textContent?.trim()).toBe('Configurar TV');
      expect(actions[0].getAttribute('href')).toBe('/ajustes/sistema');
      // Nenhum botão de comando para parecer pronto: o que sobra na tela é a casca (voltar, desligar e o menu).
      expect(
        root.querySelectorAll('button.round, button.pill-btn, button.seg, button.num'),
      ).toHaveLength(0);
    });

    it('without a TV configured, whoever cannot choose the computer gets one sentence and no button', async () => {
      TestBed.inject(SessionState).setUser({
        id: 'g',
        email: 'g@example.com',
        displayName: 'Gi',
        role: 'guest',
        permissions: ['module:tv', 'tv:control'],
      });
      await unconfigure();
      const empty = root.querySelector('.empty')!;
      expect(empty.querySelector('h2')?.textContent?.trim()).toBe('Nenhuma TV configurada');
      expect(empty.textContent).toContain('Peça a quem administra o app para configurar a TV.');
      expect(empty.querySelector('a, button')).toBeNull();
    });

    it('the control comes back by itself when a TV is configured', async () => {
      await unconfigure();
      store.status.set('hot');
      store.canSend.set(true);
      store.disabledReason.set(null);
      await render();
      expect(root.querySelector('.empty')).toBeNull();
      expect(root.querySelector('app-tv-control')).not.toBeNull();
    });

    it('with the agent off the control stays, dimmed, and the one action is to try again', async () => {
      store.status.set('agent-off');
      store.canSend.set(false);
      store.disabledReason.set(
        'O agente da TV está desligado, então os botões não funcionam agora.',
      );
      await render();
      expect(root.querySelector('app-tv-control')).not.toBeNull();
      const row = root.querySelector('.reason-row')!;
      expect(row.querySelector('.reason')?.textContent).toContain('agente da TV está desligado');
      const retry = row.querySelector<HTMLButtonElement>('button.retry')!;
      expect(retry.textContent?.trim()).toBe('Tentar de novo');

      retry.click();
      await render();
      expect(store.refresh).toHaveBeenCalledTimes(1);
      expect(store.wake).toHaveBeenCalled();
    });

    it('offers no retry when the network or the server is the problem, which fix themselves', async () => {
      for (const status of ['offline', 'waking'] as const) {
        store.status.set(status);
        store.canSend.set(false);
        store.disabledReason.set('Sem rede: o controle precisa de internet.');
        await render();
        expect(root.querySelector('.reason-row'), status).not.toBeNull();
        expect(root.querySelector('.reason-row button'), status).toBeNull();
      }
    });

    it('dims every command while the remote cannot send, and keeps the menu, which sends nothing', async () => {
      store.status.set('agent-off');
      store.canSend.set(false);
      store.disabledReason.set(
        'O agente da TV está desligado, então os botões não funcionam agora.',
      );
      await render();
      expect(root.querySelector<HTMLButtonElement>('.power')!.disabled).toBe(true);
      expect(byLabel('Mudo').disabled).toBe(true);
      expect(byLabel('Teclado').classList.contains('off')).toBe(true);
      expect(menuButton().disabled).toBe(false);
    });
  });

  describe('suggested shortcuts', () => {
    const tapSuggestion = async (name: string) => {
      root.querySelector<HTMLButtonElement>(`.shortcut.suggestion[aria-label="${name}"]`)!.click();
      await render();
    };

    beforeEach(async () => {
      // A faixa só é medida depois de desenhada, e o jsdom não faz layout: a medida vem do dublê, e a tela nasce de novo.
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358);
      fixture.destroy();
      TestBed.resetTestingModule();
      store = createFakeTvStore();
      store.shortcuts.set([]);
      TestBed.configureTestingModule({
        providers: [provideRouter([]), { provide: TvStore, useValue: store }],
      });
      TestBed.inject(SessionState).setUser({
        id: 'tv-page-user',
        email: 'tv@example.com',
        displayName: 'TV',
      });
      fixture = TestBed.createComponent(TvPage);
      root = fixture.nativeElement;
      await render();
    });

    afterEach(() => vi.restoreAllMocks());

    it('a tap opens the panel of that suggestion, which Remover closes and remembers', async () => {
      await tapSuggestion('Sugestão: Netflix');
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Netflix');
      expect(root.querySelector('app-tv-suggestion')).not.toBeNull();

      [...root.querySelectorAll<HTMLButtonElement>('app-tv-suggestion button')]
        .find((b) => b.textContent?.trim() === 'Remover sugestão')!
        .click();
      await render();
      expect(root.querySelector('app-tv-panel')).toBeNull();
      expect(root.querySelector('.shortcut.suggestion[aria-label="Sugestão: Netflix"]')).toBeNull();
      expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual(['netflix']);
    });

    it('asking for the Apps panel closes the suggestion first and then opens Apps, one modal at a time', async () => {
      await tapSuggestion('Sugestão: YouTube');
      [...root.querySelectorAll<HTMLButtonElement>('app-tv-suggestion button')]
        .find((b) => b.textContent?.trim() === 'Atualizar a lista de apps')!
        .click();
      await render();
      await render();
      expect(root.querySelector('app-tv-suggestion')).toBeNull();
      expect(dialogs()).toHaveLength(1);
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Apps da TV');
    });

    it('hides the toast while the suggestion is open, as for any panel', async () => {
      await tapSuggestion('Sugestão: Max');
      store.notice.set({ kind: 'error', text: 'Falhou.' });
      await render();
      expect(root.querySelector('.toast')).toBeNull();
    });
  });

  describe('floating panels', () => {
    it('start closed', () => {
      expect(dialogs()).toHaveLength(0);
    });

    it('the Apps row of the menu opens the Apps panel, which Fechar closes, giving the focus back to the three dots', async () => {
      const dots = menuButton();
      dots.focus();
      await openApps();
      expect(dialogs()).toHaveLength(1);
      expect(dialogs()[0].hasAttribute('open')).toBe(true);
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Apps da TV');
      expect(root.querySelector('app-tv-apps')).not.toBeNull();
      expect(root.querySelector('app-tv-menu')).toBeNull();

      root.querySelector<HTMLButtonElement>('app-tv-panel .x')!.click();
      await render();
      expect(dialogs()).toHaveLength(0);
      expect(document.activeElement).toBe(dots);
    });

    it('the Mais botões row of the menu opens the panel with the keys left off the main screen', async () => {
      menuButton().click();
      await render();
      menuRow('Mais botões').click();
      await render();
      await render();
      expect(dialogs()).toHaveLength(1);
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Mais botões');
      expect(root.querySelector('app-tv-more-keys')).not.toBeNull();
      expect(root.querySelector('app-tv-menu')).toBeNull();
      root.querySelector<HTMLButtonElement>('app-tv-panel .x')!.click();
      await render();
      expect(dialogs()).toHaveLength(0);
    });

    it('the keyboard button opens the Keyboard panel at the top, with no header close (it has its own Fechar)', async () => {
      const button = byLabel('Teclado');
      button.focus();
      button.click();
      await render();
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Teclado');
      expect(dialogs()[0].getAttribute('data-placement')).toBe('top');
      expect(root.querySelector('app-tv-panel .x')).toBeNull();
      expect(root.querySelector('app-tv-keyboard input')).not.toBeNull();

      const close = [...root.querySelectorAll<HTMLButtonElement>('app-tv-keyboard button')].find(
        (b) => b.textContent?.trim() === 'Fechar',
      )!;
      close.click();
      await render();
      expect(dialogs()).toHaveLength(0);
      expect(document.activeElement).toBe(button);
    });

    it('Esc closes the open panel', async () => {
      await openApps();
      dialogs()[0].dispatchEvent(new Event('cancel', { cancelable: true }));
      await render();
      expect(dialogs()).toHaveLength(0);
    });

    it('opening an app from the panel closes it, so the control is back at hand', async () => {
      await openApps();
      root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
      await render();
      expect(store.launch).toHaveBeenCalledTimes(1);
      expect(dialogs()).toHaveLength(0);
    });

    it('a failed launch keeps the panel open, where the error is shown', async () => {
      store.launch.mockResolvedValueOnce(false);
      await openApps();
      root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
      await render();
      expect(dialogs()).toHaveLength(1);
    });

    describe('with the exit animation on', () => {
      const tick = async (ms = 0) => {
        fixture.detectChanges();
        await vi.advanceTimersByTimeAsync(ms);
        fixture.detectChanges();
      };

      beforeEach(() => {
        // O jsdom não tem `matchMedia`: com ele dizendo "movimento permitido" o painel espera a saída (até 300 ms).
        Object.defineProperty(window, 'matchMedia', {
          value: () => ({ matches: false }),
          configurable: true,
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });

      afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(window, 'matchMedia');
      });

      it('opening an app lets the panel finish its exit before it leaves the screen', async () => {
        menuButton().click();
        await tick();
        menuRow('Apps da TV').click();
        // O menu termina a saída antes de o painel dos apps abrir: nunca dois modais ao mesmo tempo.
        await tick();
        expect(dialogs()).toHaveLength(1);
        expect(dialogs()[0].classList.contains('leaving')).toBe(true);
        await tick(300);
        await tick();
        expect(root.querySelector('app-tv-menu')).toBeNull();
        expect(dialogs()).toHaveLength(1);
        expect(root.querySelector('app-tv-apps')).not.toBeNull();
        root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
        await tick();
        expect(store.launch).toHaveBeenCalledTimes(1);
        // A saída está rolando: o painel ainda está na tela, marcado como saindo.
        expect(dialogs()).toHaveLength(1);
        expect(dialogs()[0].classList.contains('leaving')).toBe(true);

        await tick(300);
        expect(dialogs()).toHaveLength(0);
      });

      it('Fechar of the keyboard goes through the same exit', async () => {
        root
          .querySelector<HTMLButtonElement>('app-tv-control button[aria-label="Teclado"]')!
          .click();
        await tick();
        const close = [...root.querySelectorAll<HTMLButtonElement>('app-tv-keyboard button')].find(
          (b) => b.textContent?.trim() === 'Fechar',
        )!;
        close.click();
        await tick();
        expect(dialogs()).toHaveLength(1);
        expect(dialogs()[0].classList.contains('leaving')).toBe(true);

        await tick(300);
        expect(dialogs()).toHaveLength(0);
      });
    });
  });

  describe('power', () => {
    const sheetButton = (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>('app-power-sheet button')].find(
        (b) => b.textContent?.trim() === name,
      )!;

    it('opens the sheet and only asks after the confirmation', async () => {
      expect(root.querySelector('app-power-sheet')).toBeNull();
      byLabel('Desligar a TV').click();
      await render();
      expect(root.querySelector('app-power-sheet')).not.toBeNull();
      expect(root.querySelector('app-power-sheet h2')?.textContent).toBe('Desligar a TV?');
      expect(store.powerOff).not.toHaveBeenCalled();

      sheetButton('Desligar').click();
      await render();
      expect(store.powerOff).toHaveBeenCalledTimes(1);
      expect(root.querySelector('app-power-sheet')).toBeNull();
    });

    it('Cancelar closes the sheet and sends nothing', async () => {
      byLabel('Desligar a TV').click();
      await render();
      sheetButton('Cancelar').click();
      await render();
      expect(root.querySelector('app-power-sheet')).toBeNull();
      expect(store.powerOff).not.toHaveBeenCalled();
    });
  });

  describe('menu', () => {
    const openMenu = async () => {
      menuButton().click();
      await render();
    };

    it('starts closed and opens as a panel named "Mais opções", with the same gestures as the other panels', async () => {
      expect(root.querySelector('app-tv-menu')).toBeNull();
      await openMenu();
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Mais opções');
      expect(dialogs()[0].getAttribute('data-placement')).toBe('bottom');
      expect(root.querySelector('app-tv-panel .grab')).not.toBeNull();
      expect(
        [...root.querySelectorAll('app-tv-menu .ui-row-title')].map((el) => el.textContent?.trim()),
      ).toEqual(['Apps da TV', 'Mais botões', 'Personalizar', 'Gerenciar TVs']);
    });

    it('closes with Esc and with its own close button, and gives the focus back to the three dots', async () => {
      const dots = menuButton();
      for (const close of [
        () => dialogs()[0].dispatchEvent(new Event('cancel', { cancelable: true })),
        () => root.querySelector<HTMLButtonElement>('app-tv-panel .x')!.click(),
      ]) {
        dots.focus();
        await openMenu();
        close();
        await render();
        expect(dialogs()).toHaveLength(0);
        expect(document.activeElement).toBe(dots);
      }
    });

    it('opens Personalizar from its row, one modal at a time, and the focus comes back to the three dots', async () => {
      const dots = menuButton();
      dots.focus();
      await openMenu();
      menuRow('Personalizar').click();
      await render();
      await render();
      expect(root.querySelector('app-tv-menu')).toBeNull();
      expect(customizeSheet()).not.toBeNull();
      root.querySelector<HTMLButtonElement>('app-tv-customize-sheet .footer .primary')!.click();
      await render();
      await render();
      expect(customizeSheet()).toBeNull();
      expect(document.activeElement).toBe(dots);
    });

    it('is there even without the agent, because nothing in it sends a command', async () => {
      store.canSend.set(false);
      await render();
      expect(menuButton().disabled).toBe(false);
      await openApps();
      expect(dialogs()).toHaveLength(1);
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Apps da TV');
    });
  });

  describe('name and Personalizar', () => {
    const typeName = async (text: string) => {
      const field = root.querySelector<HTMLInputElement>(
        'app-tv-customize-sheet input#tv-custom-name',
      )!;
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await render();
    };
    const saved = () => JSON.parse(localStorage.getItem(prefsKey()) ?? 'null');

    it('shows the nickname the owner chose, trimmed, in place of "TV"', async () => {
      TestBed.inject(TvPrefs).set({ name: '  Sala de estar ' });
      await render();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Sala de estar');
    });

    it.each([
      ['TV', 'short'],
      ['Sala 1', 'short'],
      ['Sala de TV', 'medium'],
      ['Quarto 12', 'medium'],
      ['Sala de estar', 'long'],
      ['Casa da praia - sala', 'long'],
    ])(
      'sets the size class of "%s" to %s, so the long names shrink instead of being cut',
      async (name, size) => {
        TestBed.inject(TvPrefs).set({ name });
        await render();
        expect(root.querySelector('.name')?.getAttribute('data-size')).toBe(size);
      },
    );

    it('falls back to "TV" when the nickname is empty', async () => {
      TestBed.inject(TvPrefs).set({ name: 'Sala' });
      await render();
      TestBed.inject(TvPrefs).set({ name: '   ' });
      await render();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV');
    });

    it('names the title button after the nickname and what the touch does', async () => {
      expect(titleButton().getAttribute('aria-label')).toBe('TV, personalizar');
      expect(titleButton().getAttribute('aria-haspopup')).toBe('dialog');
      TestBed.inject(TvPrefs).set({ name: 'Quarto' });
      await render();
      expect(titleButton().getAttribute('aria-label')).toBe('Quarto, personalizar');
      // O texto visível é só o nome: o que o toque faz vai no nome acessível.
      expect(titleButton().textContent?.trim()).toBe('Quarto');
    });

    it('opens the sheet on the title, which changes the name as it is typed and keeps it', async () => {
      expect(customizeSheet()).toBeNull();
      titleButton().click();
      await render();
      expect(customizeSheet()?.hasAttribute('open')).toBe(true);
      expect(root.querySelector('app-tv-customize-sheet h2')?.textContent).toBe('Personalizar');

      await typeName('TV da sala');
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV da sala');
      expect(saved().name).toBe('TV da sala');
      expect(TestBed.inject(TvPrefs).title()).toBe('TV da sala');
    });

    it('lets a space be typed in the middle of the name', async () => {
      titleButton().click();
      await render();
      await typeName('TV ');
      expect(
        root.querySelector<HTMLInputElement>('app-tv-customize-sheet input#tv-custom-name')!.value,
      ).toBe('TV ');
      await typeName('TV d');
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV d');
    });

    it('closes with Concluir and gives the focus back to the title', async () => {
      titleButton().focus();
      titleButton().click();
      await render();
      const done = [
        ...root.querySelectorAll<HTMLButtonElement>('app-tv-customize-sheet button'),
      ].find((b) => b.textContent?.trim() === 'Concluir')!;
      done.click();
      await render();
      expect(customizeSheet()).toBeNull();
      expect(document.activeElement).toBe(titleButton());
    });

    it('Esc closes it too, and the nickname stays', async () => {
      titleButton().click();
      await render();
      await typeName('Sala');
      customizeSheet()!.dispatchEvent(new Event('cancel', { cancelable: true }));
      await render();
      expect(customizeSheet()).toBeNull();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Sala');
    });

    it('hides the toast while the sheet is open', async () => {
      titleButton().click();
      await render();
      store.notice.set({ kind: 'info', text: 'Texto enviado para a TV.' });
      await render();
      expect(root.querySelector('.toast')).toBeNull();
    });

    it('the controls behind the sheet follow the choices at once', async () => {
      titleButton().click();
      await render();
      const choice = (label: string) =>
        [...root.querySelectorAll<HTMLButtonElement>('app-tv-customize-sheet .choice')].find(
          (b) => b.textContent?.trim() === label,
        )!;
      choice('Grande').click();
      await render();
      expect(
        root
          .querySelector<HTMLElement>('app-tv-control .remote')!
          .style.getPropertyValue('--key-scale'),
      ).toBe('1.15');
    });
  });

  describe('several TVs', () => {
    const CASA = makeTv('casa', { name: 'Casa', isDefault: true });
    const AMIGO = makeTv('amigo', { name: 'Raphael', kind: 'samsung', online: false });
    const showTvs = async (list = [CASA, AMIGO]) => {
      store.tvs.set(list);
      const selection = TestBed.inject(TvSelection);
      selection.setTvs(list);
      // O store de mentira troca a TV dele; a escolha de verdade (nome, preferências) é a do TvSelection.
      store.selectTv.mockImplementation((id) => selection.select(id));
      await render();
    };
    const switchSheet = () => root.querySelector<HTMLElement>('app-tv-switcher');
    const rows = () => [
      ...root.querySelectorAll<HTMLButtonElement>('app-tv-switcher button.ui-row'),
    ];

    afterEach(() => localStorage.clear());

    it('with a single TV the name is exactly what it always was: no arrow, and it opens Personalizar', async () => {
      await showTvs([CASA]);
      expect(root.querySelector('h1 .chevron')).toBeNull();
      expect(titleButton().getAttribute('aria-label')).toBe('TV, personalizar');
      titleButton().click();
      await render();
      expect(customizeSheet()).not.toBeNull();
      expect(switchSheet()).toBeNull();
    });

    it('with two TVs the name becomes the selector: the name of the TV, a discreet arrow and a name that says what it does', async () => {
      await showTvs();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Casa');
      expect(titleButton().classList.contains('switcher')).toBe(true);
      expect(titleButton().querySelector('.chevron')).not.toBeNull();
      expect(titleButton().getAttribute('aria-label')).toBe('Casa, trocar de TV');
      expect(titleButton().getAttribute('aria-haspopup')).toBe('dialog');
    });

    it('opens a sheet that lists the TVs, with the one in use marked, and leaves Personalizar to the menu', async () => {
      await showTvs();
      titleButton().click();
      await render();
      expect(customizeSheet()).toBeNull();
      expect(switchSheet()).not.toBeNull();
      expect(root.querySelector('app-tv-panel h2')?.textContent?.trim()).toBe('Escolher a TV');
      expect(rows().map((row) => row.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
        'Casa',
        'Raphael',
      ]);
      expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual(['true', null]);
    });

    it('switches to the TV that was touched and closes the sheet', async () => {
      await showTvs();
      titleButton().click();
      await render();
      rows()[1].click();
      await render();
      expect(store.selectTv).toHaveBeenCalledWith('amigo');
      expect(switchSheet()).toBeNull();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Raphael');
    });

    it('gives the name back to the person: a nickname wins over the name of the TV', async () => {
      await showTvs();
      TestBed.inject(TvPrefs).set({ name: 'Sala' });
      await render();
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Sala');
      expect(titleButton().getAttribute('aria-label')).toBe('Sala, trocar de TV');
    });

    it('closes the sheet if the account stops having more than one TV', async () => {
      await showTvs();
      titleButton().click();
      await render();
      expect(switchSheet()).not.toBeNull();
      await showTvs([CASA]);
      expect(switchSheet()).toBeNull();
      expect(root.querySelector('h1 .chevron')).toBeNull();
    });
  });
});

describe('TV_ROUTES', () => {
  let store: FakeTvStore;

  beforeEach(() => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'tv', children: TV_ROUTES }]),
        { provide: TvStore, useValue: store },
      ],
    });
  });

  const open = async (url: string) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness;
  };
  const root = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;

  it('/tv renders the TV page with the control and no panel open', async () => {
    const harness = await open('/tv');
    expect(root(harness).matches('app-tv-page')).toBe(true);
    expect(root(harness).querySelector('app-tv-control')).not.toBeNull();
    expect(root(harness).querySelector('app-tv-panel')).toBeNull();
  });

  it('/tv/apps goes to the control and opens the Apps panel, taking the parameter off the address', async () => {
    const harness = await open('/tv/apps');
    expect(root(harness).matches('app-tv-page')).toBe(true);
    expect(root(harness).querySelector('app-tv-panel app-tv-apps')).not.toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('/tv/teclado goes to the control and opens the Keyboard panel', async () => {
    const harness = await open('/tv/teclado');
    expect(root(harness).querySelector('app-tv-panel app-tv-keyboard')).not.toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('an unknown panel name opens nothing', async () => {
    const harness = await open('/tv?painel=outro');
    expect(root(harness).querySelector('app-tv-panel')).toBeNull();
  });

  it('declares no tabs, so the shell draws no bottom bar, and takes over the header from the shell', async () => {
    await open('/tv');
    const data = collectShellData(TestBed.inject(Router).routerState.snapshot.root);
    expect(data.tabs ?? []).toEqual([]);
    // O título vazio vence o "TV" do módulo na casca: o cabeçalho é o da própria tela.
    expect(data.title).toBe('');
  });

  it('starts the store once, even after the redirect', async () => {
    await open('/tv/apps');
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.stop).not.toHaveBeenCalled();
  });
});

describe('TvPage for a guest', () => {
  let root: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<TvPage>>;

  const open = async () => {
    const store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
    });
    fixture = TestBed.createComponent(TvPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('gives the guest the same way back to Início, while keeping name, state, menu and power', async () => {
    await open();
    expect(root.querySelector('a.back')?.getAttribute('href')).toBe('/');
    expect(root.querySelector('a.back')?.getAttribute('aria-label')).toBe('Voltar ao Início');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV');
    expect(root.querySelector('button[aria-label="Desligar a TV"]')).not.toBeNull();
    expect(root.querySelector('.head button[aria-label="Mais opções"]')).not.toBeNull();
    expect(root.querySelector('app-tv-control')).not.toBeNull();
  });

  it('keeps the menu beside the arrow back, on the left, and only power on the right', async () => {
    await open();
    expect(
      [...root.querySelectorAll('.head .lead > *')].map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Voltar ao Início', 'Mais opções']);
    expect(
      [...root.querySelectorAll('.head .actions > *')].map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Desligar a TV']);
  });

  it('shows the guest the menu without the one thing that changes the TV for everybody', async () => {
    await open();
    root.querySelector<HTMLButtonElement>('.head button[aria-label="Mais opções"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      [...root.querySelectorAll('app-tv-menu .ui-row-title')].map((el) => el.textContent?.trim()),
    ).toEqual(['Apps da TV', 'Mais botões', 'Personalizar']);
    expect(root.querySelector('app-tv-menu a')).toBeNull();
    expect(root.querySelector('app-tv-menu .ui-chip')).toBeNull();
  });

  it('keeps the back button alone before the name, with no settings button even for the guest', async () => {
    await open();
    const head = root.querySelector('.head')!;
    expect(head.children).toHaveLength(3);
    expect(head.children[0].classList.contains('lead')).toBe(true);
    const back = head.children[0].children[0];
    expect(back.getAttribute('href')).toBe('/');
    expect(head.querySelector('a[href="/ajustes"]')).toBeNull();
    expect(head.querySelector('a.settings')).toBeNull();
    expect(head.children[1].classList.contains('name')).toBe(true);
    expect(head.children[2].classList.contains('actions')).toBe(true);
  });

  it('can name the TV for itself: the nickname is kept on this device, with no server involved', async () => {
    await open();
    TestBed.inject(TvPrefs).set({ name: 'Quarto da Alice' });
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Quarto da Alice');
    expect(JSON.parse(localStorage.getItem(tvPrefsStorageKey('1')) ?? 'null').name).toBe(
      'Quarto da Alice',
    );
  });
});

describe('TvPage by permission', () => {
  let store: FakeTvStore;
  let root: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<TvPage>>;

  const ALL = [
    'module:tv',
    'tv:control',
    'tv:power',
    'tv:launch',
    'tv:edit-shortcuts',
    'tv:history',
    'module:training',
  ];
  const grant = (role: 'guest' | 'owner', ...permissions: string[]) =>
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role,
      permissions,
    });
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const open = async (role: 'guest' | 'owner', ...permissions: string[]) => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    grant(role, ...permissions);
    fixture = TestBed.createComponent(TvPage);
    root = fixture.nativeElement as HTMLElement;
    await render();
  };
  const head = () => [...root.querySelectorAll('.head .lead > *, .head .actions > *')];
  const labels = () => head().map((el) => el.getAttribute('aria-label'));
  const titleButton = () => root.querySelector('h1 button');
  const message = () => root.querySelector('app-tv-view-only .message')?.textContent?.trim();
  const buttonLabels = () =>
    [...root.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('control only: the whole control and the name opens Personalizar; the menu holds only the options and Personalizar, and there is no power', async () => {
    await open('guest', 'module:tv', 'tv:control');
    expect(labels()).toEqual(['Voltar ao Início', 'Mais opções']);
    expect(root.querySelector('app-tv-control')).not.toBeNull();
    expect(root.querySelector('app-tv-view-only')).toBeNull();
    expect(titleButton()?.getAttribute('aria-label')).toBe('TV, personalizar');
    expect(root.querySelector('app-status-indicator')).not.toBeNull();
    // Os atalhos de cima são figuras (sem tv:launch), e o resto do controle segue inteiro.
    expect(root.querySelectorAll('button.shortcut')).toHaveLength(0);
    expect(root.querySelector('button[aria-label="Mudo"]')).not.toBeNull();
  });

  it('control only: the menu leads to a short panel with the cleaning and nothing of the app list', async () => {
    await open('guest', 'module:tv', 'tv:control');
    root.querySelector<HTMLButtonElement>('.head button[aria-label="Mais opções"]')!.click();
    await render();
    expect(
      [...root.querySelectorAll('app-tv-menu .ui-row-title')].map((el) => el.textContent?.trim()),
    ).toEqual(['Opções da TV', 'Mais botões', 'Personalizar']);
    [...root.querySelectorAll<HTMLButtonElement>('app-tv-menu button.ui-row')]
      .find((row) => row.textContent?.includes('Opções da TV'))!
      .click();
    await render();
    await render();
    expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Opções da TV');
    const panel = root.querySelector('app-tv-panel')!;
    expect(panel.querySelector('button.clean')?.textContent?.trim()).toBe('Limpar a TV');
    for (const selector of [
      '.grid',
      '.launch',
      'input[type="search"]',
      'button.refresh',
      '.edit-toggle',
      '.empty',
    ]) {
      expect(panel.querySelector(selector), selector).toBeNull();
    }
    // O botão limpa de verdade: abre a folha de confirmação.
    panel.querySelector<HTMLButtonElement>('button.clean')!.click();
    await render();
    expect(root.querySelector('app-tv-cleanup-sheet')).not.toBeNull();
  });

  it('launch and edit, no control: the message and the shortcuts, the menu, no power, the name is only text', async () => {
    await open('guest', 'module:tv', 'tv:launch', 'tv:edit-shortcuts');
    expect(labels()).toEqual(['Voltar ao Início', 'Mais opções']);
    expect(root.querySelector('app-tv-control')).toBeNull();
    expect(message()).toBe('Você pode ver a TV, mas não controlá-la.');
    expect(root.querySelectorAll('button.shortcut')).toHaveLength(3);
    // O nome é só o nome: sem botão, sem "personalizar" no nome acessível, e a mesma caixa para a altura não mudar.
    expect(titleButton()).toBeNull();
    const h1 = root.querySelector('h1')!;
    expect(h1.textContent?.trim()).toBe('TV');
    expect(h1.querySelector('.title.plain')).not.toBeNull();
    expect(h1.querySelector('[aria-haspopup]')).toBeNull();
  });

  it('view only: the state, the name and a single sentence; nothing to tap but the state dot', async () => {
    await open('guest', 'module:tv');
    expect(labels()).toEqual(['Voltar ao Início']);
    expect(message()).toBe('Você pode ver a TV, mas não controlá-la.');
    expect(root.querySelector('app-tv-control')).toBeNull();
    expect(root.querySelectorAll('.shortcut.still')).toHaveLength(3);
    expect(buttonLabels()).toEqual(['Estado do controle: Conectada']);
    expect(root.querySelector('.reason')).toBeNull();
  });

  it('everything, as the owner: the same page as always', async () => {
    await open('owner', ...ALL);
    expect(labels()).toEqual(['Voltar ao Início', 'Mais opções', 'Desligar a TV']);
    expect(root.querySelector('app-tv-control')).not.toBeNull();
    expect(root.querySelector('app-tv-view-only')).toBeNull();
    expect(titleButton()?.getAttribute('aria-label')).toBe('TV, personalizar');
    expect(root.querySelectorAll('button.shortcut')).toHaveLength(3);
  });

  it('the owner whose response carries no list is not locked out of anything', async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Dono',
      role: 'owner',
    });
    fixture = TestBed.createComponent(TvPage);
    root = fixture.nativeElement as HTMLElement;
    await render();
    expect(labels()).toEqual(['Voltar ao Início', 'Mais opções', 'Desligar a TV']);
  });

  it('power alone shows the power button, and the header keeps its three groups', async () => {
    await open('guest', 'module:tv', 'tv:power');
    expect(labels()).toEqual(['Voltar ao Início', 'Desligar a TV']);
    expect(root.querySelector('.head')!.children).toHaveLength(3);
  });

  it('no module:tv: a short sentence instead of the control, no state dot, no Apps, no power', async () => {
    await open('guest', 'module:training');
    expect(root.querySelector('.blocked')?.textContent?.trim()).toBe(
      'Esta conta não tem acesso à TV.',
    );
    expect(root.querySelector('app-tv-control, app-tv-view-only')).toBeNull();
    expect(root.querySelector('app-status-indicator')).toBeNull();
    expect(labels()).toEqual(['Voltar ao Início']);
  });

  it('keeps the header in three groups whatever the buttons, so the name never leaves the middle', async () => {
    for (const permissions of [['module:tv'], ['module:tv', 'tv:control', 'tv:power'], ALL]) {
      TestBed.resetTestingModule();
      await open('guest', ...permissions);
      const header = root.querySelector('.head')!;
      expect([...header.children].map((el) => el.className.split(' ')[0])).toEqual([
        'lead',
        'name',
        'actions',
      ]);
    }
  });

  it('follows the session: the control, power and the menu appear and go away with the permissions', async () => {
    await open('guest', 'module:tv');
    expect(root.querySelector('app-tv-control')).toBeNull();

    grant('guest', 'module:tv', 'tv:control', 'tv:power', 'tv:launch');
    await render();
    expect(root.querySelector('app-tv-control')).not.toBeNull();
    expect(root.querySelector('app-tv-view-only')).toBeNull();
    expect(labels()).toEqual(['Voltar ao Início', 'Mais opções', 'Desligar a TV']);

    grant('guest', 'module:tv');
    await render();
    expect(root.querySelector('app-tv-control')).toBeNull();
    expect(message()).toBe('Você pode ver a TV, mas não controlá-la.');
    expect(labels()).toEqual(['Voltar ao Início']);
  });

  it('closes a sheet or panel that was open when the permission to use it goes away', async () => {
    await open('guest', ...ALL);
    root.querySelector<HTMLButtonElement>('button[aria-label="Desligar a TV"]')!.click();
    await render();
    expect(root.querySelector('app-power-sheet')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('h1 button')!.click();
    await render();

    grant('guest', 'module:tv', 'tv:launch');
    await render();
    expect(root.querySelector('app-power-sheet')).toBeNull();
    expect(root.querySelector('app-tv-customize-sheet')).toBeNull();

    // E não volta sozinho se a permissão voltar.
    grant('guest', ...ALL);
    await render();
    expect(root.querySelector('app-power-sheet')).toBeNull();
    expect(root.querySelector('app-tv-customize-sheet')).toBeNull();
  });

  it('closes the keyboard panel when the control goes away', async () => {
    await open('guest', 'module:tv', 'tv:control');
    expect(root.querySelector('button[aria-label="Apps da TV"]')).toBeNull();
    expect(root.querySelector('button[aria-label="Mais opções"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('button[aria-label="Teclado"]')!.click();
    await render();
    expect(root.querySelector('app-tv-keyboard')).not.toBeNull();
    grant('guest', 'module:tv');
    await render();
    expect(root.querySelector('app-tv-keyboard')).toBeNull();
  });

  it('the "reason" line goes to whoever still has a button that goes dim, and not to a viewer, who has none', async () => {
    await open('guest', 'module:tv', 'tv:control');
    store.canSend.set(false);
    store.disabledReason.set('O agente da TV está desligado, então os botões não funcionam agora.');
    await render();
    expect(root.querySelector('.reason')).not.toBeNull();

    // O desligar apaga sem o controle: o motivo continua à vista.
    grant('guest', 'module:tv', 'tv:power');
    await render();
    expect(root.querySelector('.reason')).not.toBeNull();

    // Os atalhos que abrem apps apagam sem o controle: idem.
    grant('guest', 'module:tv', 'tv:launch');
    await render();
    expect(root.querySelector('.reason')).not.toBeNull();

    // Só ver: nenhum botão para explicar.
    grant('guest', 'module:tv');
    await render();
    expect(root.querySelector('.reason')).toBeNull();
    grant('guest', 'module:tv', 'tv:edit-shortcuts');
    await render();
    expect(root.querySelector('.reason')).toBeNull();
  });
});

describe('TV_ROUTES by permission', () => {
  let store: FakeTvStore;

  const open = async (url: string, ...permissions: string[]) => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'tv', children: TV_ROUTES }]),
        { provide: TvStore, useValue: store },
      ],
    });
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
      permissions,
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('the old Apps address opens nothing for who has no way to use it, and still leaves the address clean', async () => {
    const root = await open('/tv/apps', 'module:tv', 'tv:power');
    expect(root.querySelector('app-tv-panel')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('the old Apps address opens the short panel of options for who only controls', async () => {
    const root = await open('/tv/apps', 'module:tv', 'tv:control');
    expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Opções da TV');
    expect(root.querySelector('app-tv-panel .grid')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('the old Apps address opens it for who can open apps', async () => {
    const root = await open('/tv/apps', 'module:tv', 'tv:launch');
    expect(root.querySelector('app-tv-panel app-tv-apps')).not.toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('the old keyboard address opens nothing for who cannot control', async () => {
    const root = await open('/tv/teclado', 'module:tv', 'tv:launch');
    expect(root.querySelector('app-tv-panel')).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/tv');
  });

  it('the old keyboard address opens the keyboard for who can control', async () => {
    const root = await open('/tv/teclado', 'module:tv', 'tv:control');
    expect(root.querySelector('app-tv-panel app-tv-keyboard')).not.toBeNull();
  });
});
