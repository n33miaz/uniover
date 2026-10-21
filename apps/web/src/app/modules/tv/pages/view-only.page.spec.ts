import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeShortcut } from '../tv-test-kit';
import { ViewOnlyPage } from './view-only.page';

describe('ViewOnlyPage', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ViewOnlyPage>>;
  let root: HTMLElement;

  const grant = (...permissions: string[]) =>
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'Alice',
      role: 'guest',
      permissions,
    });
  const render = () => fixture.detectChanges();
  const open = (...permissions: string[]) => {
    grant(...permissions);
    fixture = TestBed.createComponent(ViewOnlyPage);
    root = fixture.nativeElement;
    render();
  };

  beforeEach(() => {
    localStorage.clear();
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
  });
  afterEach(() => localStorage.clear());

  it('says in one plain sentence that the TV can be seen but not controlled', () => {
    open('module:tv');
    expect(root.querySelector('.message')?.textContent?.trim()).toBe(
      'Você pode ver a TV, mas não controlá-la.',
    );
    // Não é um erro nem um aviso para o leitor de tela: é o estado normal desta conta.
    expect(root.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });

  it('has none of the control: no ring, pad, touchpad, pills, round buttons, dots or keyboard', () => {
    open('module:tv', 'tv:launch');
    for (const selector of [
      '.stage',
      '.pager',
      '.bottom',
      '.pill',
      '.round',
      'app-directional-ring',
      'app-number-pad',
      'app-touchpad-surface',
      'app-page-dots',
      'button[aria-label="Teclado"]',
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
  });

  it('only viewing: the shortcuts are figures, with no button at all and nothing sent to the TV', () => {
    open('module:tv');
    expect(root.querySelectorAll('button')).toHaveLength(0);
    const figures = root.querySelectorAll<HTMLElement>('.shortcut.still');
    expect(figures).toHaveLength(3);
    figures[0].click();
    expect(store.launch).not.toHaveBeenCalled();
  });

  it('with tv:launch the shortcuts open the apps, when the remote can send', () => {
    open('module:tv', 'tv:launch');
    expect(root.querySelectorAll('.shortcut.still')).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('button.shortcut')!.click();
    expect(store.launch).toHaveBeenCalledTimes(1);
    expect(store.launch).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));

    store.canSend.set(false);
    root.querySelector<HTMLButtonElement>('button.shortcut')!.click();
    expect(store.launch).toHaveBeenCalledTimes(1);
  });

  it('shows only the shortcuts that are in the control, in order', () => {
    store.shortcuts.set([
      makeShortcut(1, { tvLabel: 'Spotify' }),
      makeShortcut(2, { enabled: false }),
      makeShortcut(3, { customLabel: 'Sala' }),
    ]);
    open('module:tv');
    expect(
      [...root.querySelectorAll('.shortcut')].map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Spotify', 'Sala']);
  });

  it('follows the permission: the shortcuts turn into buttons when tv:launch arrives', () => {
    open('module:tv');
    expect(root.querySelectorAll('button')).toHaveLength(0);
    grant('module:tv', 'tv:launch');
    render();
    expect(root.querySelectorAll('button.shortcut')).toHaveLength(3);
  });
});
