import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PcArmed } from './data/pc-armed';
import { PcStore } from './data/pc-store';
import { PcPage } from './pc-page';
import { FAILURE, FakePcStore, createFakePcStore } from './pc-test-kit';

describe('PcPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcPage>>;
  let root: HTMLElement;

  const status = () => root.querySelector<HTMLElement>('.status')!;

  function open(phase: Parameters<typeof createFakePcStore>[0]) {
    store = createFakePcStore(phase);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: PcStore, useValue: store }],
    });
    fixture = TestBed.createComponent(PcPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  }

  afterEach(() => fixture.destroy());

  it('starts watching the PC when it opens', () => {
    open('ready');
    expect(store.watch).toHaveBeenCalledTimes(1);
  });

  it('green first: a connected PC is the first thing on the screen, with the tab below it', () => {
    open('ready');
    expect(status().textContent?.trim()).toBe('Conectado');
    expect(status().getAttribute('role')).toBe('status');
    expect(status().dataset['phase']).toBe('ready');
    expect(root.querySelector('router-outlet')).not.toBeNull();
    expect(root.querySelector('.empty')).toBeNull();
  });

  it('draws its own skeleton while the first answer has not arrived', () => {
    open('loading');
    expect(status().textContent?.trim()).toBe('Conectando');
    expect(root.querySelector('.loading')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelectorAll('.loading .ui-skeleton').length).toBe(2);
    expect(root.querySelector('router-outlet')).toBeNull();
  });

  it('with no PC of the person own, says how to install the connector and turn the control on, instead of a dead pad', () => {
    open('unavailable');
    expect(status().textContent?.trim()).toBe('Sem PC');
    expect(root.querySelector('h2')?.textContent).toBe('Nenhum PC Seu Conectado');
    expect(root.querySelector('.empty a')?.getAttribute('href')).toBe('/conectar');
    expect(root.querySelector('code')?.textContent).toBe('uniover-agent pc-control on');
    expect(root.querySelector('router-outlet')).toBeNull();
  });

  it('with the PC disconnected, offers to try again', () => {
    open('offline');
    expect(status().textContent?.trim()).toBe('Sem Conexão');
    expect(root.querySelector('h2')?.textContent).toBe('PC Desconectado');
    root.querySelector<HTMLButtonElement>('.empty button')!.click();
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('follows the state as it changes', () => {
    open('ready');
    store.phase.set('offline');
    fixture.detectChanges();
    expect(status().dataset['phase']).toBe('offline');
    expect(root.querySelector('router-outlet')).toBeNull();
  });

  it('shows the failure of a movement without hiding the pad', () => {
    open('ready');
    store.notice.set(FAILURE);
    fixture.detectChanges();
    expect(root.querySelector('.notice.ui-notice.bad')?.getAttribute('role')).toBe('alert');
    expect(root.querySelector('.notice')?.textContent).toContain('O PC está desconectado.');
    expect(root.querySelector('router-outlet')).not.toBeNull();
  });

  it('one notice at a time: while the open tab shows its own notice in the same place, this one waits', () => {
    open('ready');
    const shown = signal(true);
    const page = fixture.componentInstance as unknown as {
      onActivate(page: object): void;
      onDeactivate(): void;
    };
    page.onActivate({ fillsScreen: true, toastShown: shown });
    store.notice.set(FAILURE);
    fixture.detectChanges();
    expect(root.querySelector('.notice')).toBeNull();
    shown.set(false); // o da aba saiu: o desta casca volta
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('O PC está desconectado.');
    shown.set(true);
    page.onDeactivate(); // outra aba: nada mais o esconde
    fixture.detectChanges();
    expect(root.querySelector('.notice')).not.toBeNull();
  });

  it('explains the PC confirmation and can ask for it again', () => {
    open('ready');
    store.notice.set({
      kind: 'device-pending',
      message:
        'Apareceu uma pergunta na tela do computador: clique em Sim para liberar este celular.',
    });
    fixture.detectChanges();
    const retry = root.querySelector<HTMLButtonElement>('.notice button');
    expect(root.querySelector('.notice')?.textContent).toContain('pergunta na tela do computador');
    expect(retry?.textContent?.trim()).toBe('Tentar de Novo');
    retry?.click();
    expect(store.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('a refused phone gets the explanation without a retry button (the computer keeps the answer for an hour)', () => {
    open('ready');
    store.notice.set({
      kind: 'device-denied',
      message: 'Alguém respondeu Não à pergunta no computador.',
    });
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.textContent).toContain('respondeu Não');
    expect(root.querySelector('.notice button')).toBeNull();
  });

  it('leaving the module lets go of the armed keys (a Win left armed cannot wait, unseen, for the next screen)', () => {
    open('ready');
    const armed = TestBed.inject(PcArmed);
    armed.toggle('WIN');
    armed.toggle('CTRL');
    fixture.destroy();
    expect(armed.armed().size).toBe(0);
  });

  it('the armed keys stay while the module is open (a change of tab keeps them)', () => {
    open('ready');
    const armed = TestBed.inject(PcArmed);
    armed.toggle('WIN');
    fixture.detectChanges();
    expect(armed.has('WIN')).toBe(true);
  });

  it('connected, the state is a dot with the word kept for the screen reader', () => {
    open('ready');
    expect(status().dataset['phase']).toBe('ready');
    expect(status().querySelector('.dot')).not.toBeNull();
    expect(status().querySelector('.label')?.textContent).toBe('Conectado');
  });

  it('measures the height that is left, so the screen never sits behind the tab bar', () => {
    open('ready');
    const section = root.querySelector<HTMLElement>('.pc')!;
    expect(section.style.getPropertyValue('--pc-h')).toMatch(/^[0-9]+px$/);
  });

  it('the mouse screen takes the whole height; other tabs grow with their content', () => {
    open('ready');
    const section = root.querySelector<HTMLElement>('.pc')!;
    const page = fixture.componentInstance as unknown as {
      onActivate(page: object): void;
    };
    expect(section.classList.contains('fill')).toBe(false);
    page.onActivate({ fillsScreen: true });
    fixture.detectChanges();
    expect(section.classList.contains('fill')).toBe(true);
    page.onActivate({});
    fixture.detectChanges();
    expect(section.classList.contains('fill')).toBe(false);
  });

  it('while loading, the skeleton also fills the height (the screen does not jump)', () => {
    open('loading');
    expect(root.querySelector('.pc')?.classList.contains('fill')).toBe(true);
  });

  it('floats the failure over the surface on the mouse screen instead of pushing the bar down', () => {
    open('ready');
    const page = fixture.componentInstance as unknown as { onActivate(page: object): void };
    page.onActivate({ fillsScreen: true });
    store.notice.set(FAILURE);
    fixture.detectChanges();
    expect(root.querySelector('.notice')?.classList.contains('float')).toBe(true);
  });
});
