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
  const chips = () => [...root.querySelectorAll('.chip')].map((el) => el.textContent?.trim());

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

  it('draws its own header: back to Início, the name TV as the h1 with the dot, and power', () => {
    expect(root.querySelector('a.back')?.textContent?.trim()).toBe('← Início');
    expect(root.querySelector('a.back')?.getAttribute('href')).toBe('/');
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('TV');
    expect(root.querySelector('h1 .dot')?.getAttribute('data-tone')).toBe('ok');
    expect(root.querySelector('.power')?.getAttribute('aria-label')).toBe('Desligar a TV');
  });

  describe('state chips', () => {
    it('connected shows "conectada" and "hiberna em 5 min"', () => {
      expect(chips()).toEqual(['conectada', 'hiberna em 5 min']);
    });

    it('hibernating says "controle dormindo", never "TV desligada", and drops the hibernation timer', async () => {
      store.status.set('hibernating');
      await render();
      expect(chips()).toEqual(['controle dormindo']);
      expect(root.textContent).not.toMatch(/tv desligada/i);
      expect(root.querySelector('.dot')?.getAttribute('data-tone')).toBe('warn');
    });

    it('agent off says "agente desligado" with the reason under the chips', async () => {
      store.status.set('agent-off');
      store.canSend.set(false);
      store.disabledReason.set(
        'O agente da TV está desligado, então os botões não funcionam agora.',
      );
      await render();
      expect(chips()).toEqual(['agente desligado']);
      expect(root.querySelector('.reason')?.textContent).toContain('agente da TV está desligado');
      expect(root.querySelector('.dot')?.getAttribute('data-tone')).toBe('bad');
      expect(root.querySelector<HTMLButtonElement>('.power')!.disabled).toBe(true);
    });

    it('offline shows the last known state with the time it was seen', async () => {
      store.status.set('offline');
      store.lastKnownStatus.set('hibernating');
      store.seenAtText.set('13:07');
      store.canSend.set(false);
      await render();
      expect(chips()).toEqual(['sem rede', 'visto às 13:07 · controle dormindo']);
    });

    it('offline without any state seen shows only "sem rede"', async () => {
      store.status.set('offline');
      store.lastKnownStatus.set(null);
      await render();
      expect(chips()).toEqual(['sem rede']);
    });

    it('shows the watchdog note and the reconnecting notice', async () => {
      store.watchdogNote.set('controle religado às 14:02');
      store.streamStatus.set('reconnecting');
      await render();
      expect(chips()).toEqual([
        'conectada',
        'hiberna em 5 min',
        'controle religado às 14:02',
        'reconectando…',
      ]);
    });

    it('does not say "reconectando" when the whole network is down', async () => {
      store.streamStatus.set('reconnecting');
      store.link.set('offline');
      store.status.set('offline');
      await render();
      expect(chips()).not.toContain('reconectando…');
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
  });

  describe('power', () => {
    it('opens the sheet and only asks after the confirmation', async () => {
      expect(root.querySelector('app-power-sheet')).toBeNull();
      root.querySelector<HTMLButtonElement>('.power')!.click();
      await render();
      expect(root.querySelector('app-power-sheet')).not.toBeNull();
      expect(root.querySelector('dialog h2')?.textContent).toBe('Desligar a TV?');
      expect(store.powerOff).not.toHaveBeenCalled();

      const buttons = [...root.querySelectorAll<HTMLButtonElement>('dialog button')];
      buttons.find((b) => b.textContent?.trim() === 'Desligar')!.click();
      await render();
      expect(store.powerOff).toHaveBeenCalledTimes(1);
      expect(root.querySelector('app-power-sheet')).toBeNull();
    });

    it('Cancelar closes the sheet and sends nothing', async () => {
      root.querySelector<HTMLButtonElement>('.power')!.click();
      await render();
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('dialog button')];
      buttons.find((b) => b.textContent?.trim() === 'Cancelar')!.click();
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
      providers: [provideRouter(TV_ROUTES), { provide: TvStore, useValue: store }],
    });
  });

  it.each([
    ['/', 'app-tv-control'],
    ['/apps', 'app-tv-apps'],
    ['/teclado', 'app-tv-keyboard'],
  ])('%s renders %s inside the TV page', async (url, selector) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-tv-page')).toBe(true);
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it.each([
    ['/', true],
    ['/apps', false],
    ['/teclado', false],
  ])('%s fills the height only on the Controle tab (%s)', async (url, fills) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('.tv')?.classList.contains('fill')).toBe(fills);
  });

  it('declares the three tabs and takes over the header from the shell', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    const data = collectShellData(TestBed.inject(Router).routerState.snapshot.root);
    expect(data.tabs?.map((tab) => [tab.link, tab.label])).toEqual([
      ['/tv', 'Controle'],
      ['/tv/apps', 'Apps'],
      ['/tv/teclado', 'Teclado'],
    ]);
    // O título vazio vence o "TV" do módulo na casca: o cabeçalho é o da própria tela.
    expect(data.title).toBe('');
  });

  it('shares one store across the tabs (the page starts it once)', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    await harness.navigateByUrl('/apps');
    await harness.navigateByUrl('/teclado');
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.stop).not.toHaveBeenCalled();
  });
});
