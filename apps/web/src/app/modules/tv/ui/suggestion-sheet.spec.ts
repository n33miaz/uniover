import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TV_SUGGESTED_APPS } from '../data/tv-suggestions';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { SuggestionSheet } from './suggestion-sheet';

describe('SuggestionSheet', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<SuggestionSheet>>;
  let root: HTMLElement;
  let done: ReturnType<typeof vi.fn<() => void>>;
  let openApps: ReturnType<typeof vi.fn<() => void>>;

  const netflix = TV_SUGGESTED_APPS.find((app) => app.key === 'netflix')!;
  const buttons = () =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim());
  const click = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === text)!
      .click();

  const mount = (list: TvShortcut[], guestPermissions?: string[]) => {
    store = createFakeTvStore();
    store.shortcuts.set(list);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    if (guestPermissions) {
      TestBed.inject(SessionState).setUser({
        id: 'g',
        email: 'g@example.com',
        displayName: 'Gi',
        role: 'guest',
        permissions: guestPermissions,
      });
    }
    fixture = TestBed.createComponent(SuggestionSheet);
    fixture.componentRef.setInput('app', netflix);
    done = vi.fn<() => void>();
    openApps = vi.fn<() => void>();
    fixture.componentInstance.done.subscribe(done);
    fixture.componentInstance.openApps.subscribe(openApps);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('pins the shortcut the TV already listed for the app, with its real icon, and closes', async () => {
    const listed = makeShortcut(4, {
      package: 'com.netflix.ninja',
      enabled: false,
      iconDataUri: pngIcon(96, 96),
    });
    mount([makeShortcut(1, { enabled: false }), listed]);
    expect(root.querySelector('.ui-chip')?.textContent?.trim()).toBe('Sugestão');
    expect(root.querySelector('app-tv-app-icon img')).not.toBeNull();
    expect(buttons()).toEqual(['Fixar no controle', 'Remover sugestão']);
    click('Fixar no controle');
    await fixture.whenStable();
    expect(store.setShortcutEnabled).toHaveBeenCalledWith(listed.id, true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('stays open and pins nothing when the server refuses', async () => {
    mount([makeShortcut(4, { package: 'com.netflix.ninja', enabled: false })]);
    store.setShortcutEnabled.mockResolvedValue(false);
    click('Fixar no controle');
    await fixture.whenStable();
    expect(done).not.toHaveBeenCalled();
  });

  it('does not pretend the app is on the TV: without it on the list there is nothing to pin, only the way to refresh the list', () => {
    mount([makeShortcut(1, { enabled: false })]);
    expect(buttons()).toEqual(['Atualizar a lista de apps', 'Remover sugestão']);
    expect(root.textContent).toContain('A lista da TV ainda não traz este app.');
    click('Atualizar a lista de apps');
    expect(openApps).toHaveBeenCalledTimes(1);
    expect(store.setShortcutEnabled).not.toHaveBeenCalled();
    // Sem o ícone do app, a inicial do nome sobre a cor do pacote.
    expect(root.querySelector('app-tv-app-icon .fallback')?.textContent?.trim()).toBe('N');
  });

  it('removes the suggestion for this account and closes', () => {
    mount([]);
    click('Remover sugestão');
    expect(TestBed.inject(TvPrefs).dismissedSuggestions()).toEqual(['netflix']);
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.setShortcutEnabled).not.toHaveBeenCalled();
  });

  it('offers the way to refresh the app list only to who can ask the TV for it', () => {
    mount([], ['module:tv', 'tv:edit-shortcuts']);
    expect(buttons()).toEqual(['Remover sugestão']);
  });

  it('dims the way to refresh the list while the agent cannot be reached, and says why', () => {
    mount([]);
    store.canSend.set(false);
    store.disabledReason.set('O agente da TV está desligado, então os botões não funcionam agora.');
    fixture.detectChanges();
    const refresh = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Atualizar a lista de apps',
    )!;
    expect(refresh.disabled).toBe(true);
    expect(root.querySelector('.note + button + .note, button + .note')?.textContent).toContain(
      'agente da TV está desligado',
    );
    refresh.click();
    expect(openApps).not.toHaveBeenCalled();
  });
});
