import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import type { TvState } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, makeTv } from '../tv-test-kit';
import { AppsUnavailable } from './apps-unavailable';

describe('AppsUnavailable', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<AppsUnavailable>>;
  let root: HTMLElement;

  const mount = (permissions?: string[]) => {
    store = createFakeTvStore();
    store.shortcuts.set([]);
    store.tvs.set([makeTv('a')]);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    if (permissions) {
      TestBed.inject(SessionState).setUser({
        id: 'g',
        email: 'g@example.com',
        displayName: 'Gi',
        role: 'guest',
        permissions,
      });
    }
    fixture = TestBed.createComponent(AppsUnavailable);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };
  const setState = (change: Partial<TvState>) => {
    store.state.set({ ...store.state()!, ...change });
    fixture.detectChanges();
  };
  const text = () => root.querySelector('.why')?.textContent?.replace(/\s+/g, ' ').trim();
  const fix = () => root.querySelector<HTMLButtonElement>('button.fix');

  afterEach(() => localStorage.clear());

  it('says nothing when the list has apps', () => {
    mount();
    store.shortcuts.set([makeShortcut(1)]);
    fixture.detectChanges();
    expect(root.querySelector('.why')).toBeNull();
  });

  it('an empty list says so in a status region and offers to ask the TV', async () => {
    mount();
    expect(root.querySelector('[role="status"]')).not.toBeNull();
    expect(text()).toContain('A TV ainda não informou os apps instalados.');
    expect(fix()!.textContent?.trim()).toBe('Buscar apps da TV');
    fix()!.click();
    await fixture.whenStable();
    expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
  });

  it('a missing ADB permission offers the one-tap request (the same as Atualizar lista)', () => {
    mount();
    setState({ adbPermission: 'missing' });
    expect(text()).toContain('A TV ainda não liberou o UniOver');
    expect(fix()!.textContent?.trim()).toBe('Pedir permissão na TV');
    fix()!.click();
    expect(store.refreshShortcuts).toHaveBeenCalledTimes(1);
  });

  it('a pending permission tells what to do on the TV', () => {
    mount();
    setState({ adbPermission: 'pending' });
    expect(text()).toContain('Sempre permitir');
    expect(fix()!.textContent?.trim()).toBe('Já aceitei');
  });

  it('a computer without the ADB says that reopening the connector installs it, and rechecks', () => {
    mount();
    store.tvs.set([makeTv('a', { capabilities: ['tv.remote', 'tv.kind.android'] })]);
    fixture.detectChanges();
    expect(text()).toContain('Abra o conector UniOver de novo no computador');
    expect(fix()!.textContent?.trim()).toBe('Verificar de novo');
    // Conferir de novo não depende do agente.
    store.canSend.set(false);
    fixture.detectChanges();
    expect(fix()!.hasAttribute('aria-disabled')).toBe(false);
    fix()!.click();
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('a TV that is off offers to turn it on', () => {
    mount();
    setState({ power: 'off' });
    expect(text()).toContain('Ligue a TV');
    fix()!.click();
    expect(store.wake).toHaveBeenCalledTimes(1);
  });

  it('dims the fix (still focusable) and does nothing while the agent cannot be reached', () => {
    mount();
    store.canSend.set(false);
    fixture.detectChanges();
    expect(fix()!.getAttribute('aria-disabled')).toBe('true');
    expect(fix()!.disabled).toBe(false);
    fix()!.click();
    expect(store.refreshShortcuts).not.toHaveBeenCalled();
  });

  it('who cannot ask the TV only learns whom to ask', () => {
    mount(['module:tv', 'tv:edit-shortcuts']);
    expect(fix()).toBeNull();
    expect(text()).toContain('Peça a quem cuida da TV');
  });
});
