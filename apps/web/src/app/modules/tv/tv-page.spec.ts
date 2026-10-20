import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { collectShellData } from '../../core/layout/route-data';
import { SessionState } from '../../core/session/session-state';
import { TV_PREFS_KEY, TvPrefs } from './data/tv-prefs';
import { TvStore } from './data/tv-store';
import { TvPage } from './tv-page';
import { FakeTvStore, createFakeTvStore } from './tv-test-kit';
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
  /** O botão Apps mora no cabeçalho (o chip da fileira de atalhos tem o mesmo nome até sair de lá). */
  const appsButton = () =>
    root.querySelector<HTMLButtonElement>('.head button[aria-label="Apps da TV"]')!;
  const titleButton = () => root.querySelector<HTMLButtonElement>('h1 button')!;
  const customizeSheet = () => root.querySelector<HTMLElement>('app-tv-customize-sheet dialog');

  beforeEach(async () => {
    localStorage.clear();
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
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
    it('has back to Início, the name TV as the h1, the state dot beside it, Apps and power', () => {
      const back = root.querySelector('a.back')!;
      expect(back.getAttribute('href')).toBe('/');
      expect(back.getAttribute('aria-label')).toBe('Voltar ao Início');
      const h1 = root.querySelector('h1')!;
      expect(h1.textContent?.trim()).toBe('TV');
      // O ponto fica ao lado do título (não dentro): o nome do botão não vira parte do nome do título.
      expect(h1.querySelector('app-status-indicator')).toBeNull();
      expect(h1.nextElementSibling?.matches('app-status-indicator')).toBe(true);
      expect(byLabel('Desligar a TV')).not.toBeNull();
      expect(
        [...root.querySelectorAll('.head .actions button')].map((b) =>
          b.getAttribute('aria-label'),
        ),
      ).toEqual(['Apps da TV', 'Desligar a TV']);
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

    it('gives back, Apps and power the same circle', () => {
      const circles = [...root.querySelectorAll('.head .circle')];
      expect(circles).toHaveLength(3);
      expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual([
        'Voltar ao Início',
        'Apps da TV',
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
      appsButton().click();
      await render();
      store.notice.set({ kind: 'error', text: 'A TV não respondeu a tempo.' });
      await render();
      expect(root.querySelector('.toast')).toBeNull();
      expect(root.querySelector('app-tv-panel .notice[role="alert"]')?.textContent).toBe(
        'A TV não respondeu a tempo.',
      );
    });
  });

  describe('floating panels', () => {
    it('start closed', () => {
      expect(dialogs()).toHaveLength(0);
    });

    it('the Apps button in the header opens the Apps panel, which Fechar closes, giving the focus back to it', async () => {
      const chip = appsButton();
      expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
      chip.focus();
      chip.click();
      await render();
      expect(dialogs()).toHaveLength(1);
      expect(dialogs()[0].hasAttribute('open')).toBe(true);
      expect(root.querySelector('app-tv-panel h2')?.textContent).toBe('Apps da TV');
      expect(root.querySelector('app-tv-apps')).not.toBeNull();

      root.querySelector<HTMLButtonElement>('app-tv-panel .x')!.click();
      await render();
      expect(dialogs()).toHaveLength(0);
      expect(document.activeElement).toBe(chip);
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
      appsButton().click();
      await render();
      dialogs()[0].dispatchEvent(new Event('cancel', { cancelable: true }));
      await render();
      expect(dialogs()).toHaveLength(0);
    });

    it('opening an app from the panel closes it, so the control is back at hand', async () => {
      appsButton().click();
      await render();
      root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
      await render();
      expect(store.launch).toHaveBeenCalledTimes(1);
      expect(dialogs()).toHaveLength(0);
    });

    it('a failed launch keeps the panel open, where the error is shown', async () => {
      store.launch.mockResolvedValueOnce(false);
      appsButton().click();
      await render();
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
        appsButton().click();
        await tick();
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

  describe('Apps in the header', () => {
    it('is enabled even without the agent: the panel reads the saved list', async () => {
      store.canSend.set(false);
      await render();
      expect(appsButton().disabled).toBe(false);
      appsButton().click();
      await render();
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
    const saved = () => JSON.parse(localStorage.getItem(TV_PREFS_KEY) ?? 'null');

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

  it('has no way back to Início (single view of the control), but keeps name, state, Apps and power', async () => {
    await open();
    expect(root.querySelector('a.back')).toBeNull();
    expect(root.querySelector('a[href="/"]')).toBeNull();
    expect(root.textContent).not.toContain('Início');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV');
    expect(root.querySelector('button[aria-label="Desligar a TV"]')).not.toBeNull();
    expect(root.querySelector('.head button[aria-label="Apps da TV"]')).not.toBeNull();
    expect(root.querySelector('app-tv-control')).not.toBeNull();
  });

  it('keeps an empty cell where back was, so the name stays in the middle', async () => {
    await open();
    const head = root.querySelector('.head')!;
    expect(head.children).toHaveLength(3);
    expect(head.children[0].getAttribute('aria-hidden')).toBe('true');
    expect(head.children[1].classList.contains('name')).toBe(true);
    expect(head.children[2].classList.contains('actions')).toBe(true);
  });

  it('can name the TV for itself: the nickname is kept on this device, with no server involved', async () => {
    await open();
    TestBed.inject(TvPrefs).set({ name: 'Quarto da Alice' });
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Quarto da Alice');
    expect(JSON.parse(localStorage.getItem(TV_PREFS_KEY) ?? 'null').name).toBe('Quarto da Alice');
  });
});
