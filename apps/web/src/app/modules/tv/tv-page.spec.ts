import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { collectShellData } from '../../core/layout/route-data';
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

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    fixture = TestBed.createComponent(TvPage);
    root = fixture.nativeElement;
    await render();
  });

  it('starts the store when it is created and stops it when it is destroyed', () => {
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.stop).not.toHaveBeenCalled();
    fixture.destroy();
    expect(store.stop).toHaveBeenCalledTimes(1);
  });

  describe('header', () => {
    it('has back to Início, the name TV as the h1, the state dot beside it and power', () => {
      expect(root.querySelector('a.back')?.textContent?.trim()).toBe('← Início');
      expect(root.querySelector('a.back')?.getAttribute('href')).toBe('/');
      const h1 = root.querySelector('h1')!;
      expect(h1.textContent?.trim()).toBe('TV');
      // O ponto fica ao lado do título (não dentro): o nome do botão não vira parte do nome do título.
      expect(h1.querySelector('app-status-indicator')).toBeNull();
      expect(h1.nextElementSibling?.matches('app-status-indicator')).toBe(true);
      expect(byLabel('Desligar a TV')).not.toBeNull();
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
      byLabel('Apps da TV').click();
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

    it('the Apps chip opens the Apps panel, which Fechar closes, giving the focus back to the chip', async () => {
      const chip = byLabel('Apps da TV');
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
      byLabel('Apps da TV').click();
      await render();
      dialogs()[0].dispatchEvent(new Event('cancel', { cancelable: true }));
      await render();
      expect(dialogs()).toHaveLength(0);
    });

    it('opening an app from the panel closes it, so the control is back at hand', async () => {
      byLabel('Apps da TV').click();
      await render();
      root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
      await render();
      expect(store.launch).toHaveBeenCalledTimes(1);
      expect(dialogs()).toHaveLength(0);
    });

    it('a failed launch keeps the panel open, where the error is shown', async () => {
      store.launch.mockResolvedValueOnce(false);
      byLabel('Apps da TV').click();
      await render();
      root.querySelector<HTMLButtonElement>('app-tv-apps .launch')!.click();
      await render();
      expect(dialogs()).toHaveLength(1);
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
