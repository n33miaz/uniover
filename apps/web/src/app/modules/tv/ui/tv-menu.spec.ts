import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { TvMenu, TvMenuChoice } from './tv-menu';

describe('TvMenu', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TvMenu>>;
  let root: HTMLElement;
  let chosen: TvMenuChoice[];

  const GUEST_TV = ['module:tv', 'tv:control', 'tv:launch'];
  const rows = () =>
    [...root.querySelectorAll('.ui-row')].map((row) =>
      row.querySelector('.ui-row-title')?.textContent?.trim(),
    );

  const mount = (guest: readonly string[] | null = null) => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: TvStore, useValue: store }],
    });
    if (guest) {
      TestBed.inject(SessionState).setUser({
        id: 'g',
        email: 'g@example.com',
        displayName: 'Gi',
        role: 'guest',
        permissions: [...guest],
      });
    }
    fixture = TestBed.createComponent(TvMenu);
    fixture.componentRef.setInput('appsLabel', 'Apps da TV');
    chosen = [];
    fixture.componentInstance.choose.subscribe((choice) => chosen.push(choice));
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('gathers apps and customization for the person, and, apart, the one thing that affects everybody', () => {
    mount();
    expect(rows()).toEqual(['Apps da TV', 'Personalizar', 'Gerenciar TVs']);
    expect(root.querySelectorAll('.ui-group')).toHaveLength(2);
    const bind = root.querySelector<HTMLAnchorElement>('a.ui-row')!;
    expect(bind.getAttribute('href')).toBe('/ajustes/sistema');
    expect(bind.querySelector('.ui-chip')?.textContent?.trim()).toBe('Afeta todos');
  });

  it('asks the screen to open Apps or Customize, and leaves the closing to the screen', () => {
    mount();
    const [apps, customize] = [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')];
    apps!.click();
    customize!.click();
    expect(chosen).toEqual(['apps', 'customize']);
    expect(customize!.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('names the Apps row as the panel it opens, so it reads "Opções da TV" for who only controls', () => {
    mount();
    fixture.componentRef.setInput('appsLabel', 'Opções da TV');
    fixture.detectChanges();
    expect(rows()[0]).toBe('Opções da TV');
  });

  it('says "Configurar TV" while no computer controls the TV', () => {
    mount();
    store.status.set('unconfigured');
    fixture.detectChanges();
    expect(rows().at(-1)).toBe('Configurar TV');
  });

  it('never shows the guest what changes the TV for everybody', () => {
    mount(GUEST_TV);
    expect(rows()).toEqual(['Apps da TV', 'Personalizar']);
    expect(root.querySelector('a.ui-row')).toBeNull();
    expect(root.querySelector('.ui-chip')).toBeNull();
  });

  it('drops the rows the guest has no permission for, and the group that would be left empty', () => {
    mount(['module:tv']);
    expect(rows()).toEqual([]);
    expect(root.querySelector('.ui-group')).toBeNull();
  });

  it('brings back the removed suggestions only for who edits shortcuts, and only when there is one to bring back', () => {
    mount();
    expect(rows()).not.toContain('Mostrar sugestões de atalhos');
    TestBed.inject(TvPrefs).set({ dismissedSuggestions: ['netflix', 'max'] });
    fixture.detectChanges();
    const restore = [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')].find((row) =>
      row.textContent?.includes('Mostrar sugestões de atalhos'),
    )!;
    expect(restore).toBeDefined();
    restore.click();
    fixture.detectChanges();
    expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual([]);
    expect(rows()).not.toContain('Mostrar sugestões de atalhos');
  });
});
