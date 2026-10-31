import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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

  it('with no PC set up, says how to turn the control on instead of showing a dead pad', () => {
    open('unavailable');
    expect(status().textContent?.trim()).toBe('Sem PC');
    expect(root.querySelector('h2')?.textContent).toBe('Nenhum PC Ligado');
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
    expect(root.querySelector('.notice')?.getAttribute('role')).toBe('alert');
    expect(root.querySelector('.notice')?.textContent).toContain('O PC está desconectado.');
    expect(root.querySelector('router-outlet')).not.toBeNull();
  });
});
