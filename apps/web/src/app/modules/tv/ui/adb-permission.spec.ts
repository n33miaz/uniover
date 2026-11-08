import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvApi } from '../data/tv-api';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, HOT, createFakeTvStore } from '../tv-test-kit';
import { AdbPermissionNotice } from './adb-permission';

function unauthorized() {
  return new HttpErrorResponse({
    status: 502,
    error: {
      type: 'https://uniover.app/problems/command-failed',
      status: 502,
      agentError: 'adb_unauthorized',
    },
  });
}

describe('AdbPermissionNotice', () => {
  let store: FakeTvStore;
  let permission: TvAdbPermission;
  let fixture: ReturnType<typeof TestBed.createComponent<AdbPermissionNotice>>;
  let root: HTMLElement;
  const api = {
    refreshShortcuts: vi.fn<() => Promise<void>>(),
    state: vi.fn(),
  };

  const sheet = () => root.querySelector<HTMLElement>('.sheet');
  const notice = () => root.querySelector<HTMLElement>('.notice');
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes(label),
    );

  beforeEach(() => {
    api.refreshShortcuts.mockReset().mockResolvedValue(undefined);
    api.state.mockReset().mockResolvedValue(HOT);
    store = createFakeTvStore();
    TestBed.configureTestingModule({
      providers: [
        { provide: TvStore, useValue: store },
        { provide: TvApi, useValue: api },
      ],
    });
    permission = TestBed.inject(TvAdbPermission);
    fixture = TestBed.createComponent(AdbPermissionNotice);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('draws nothing while the TV trusts the computer', () => {
    expect(sheet()).toBeNull();
    expect(notice()).toBeNull();
  });

  it('opens a short sheet with "Pedir na TV" and "Agora não" when an ADB action is refused', () => {
    permission.denied();
    fixture.detectChanges();
    expect(sheet()).not.toBeNull();
    expect(sheet()!.querySelector('h2')?.textContent?.trim()).toBe('Liberar na TV');
    expect(button('Pedir na TV')).toBeDefined();
    expect(button('Agora não')).toBeDefined();
  });

  it('does not block the remote: it is not a modal dialog and nothing is made inert', () => {
    permission.denied();
    fixture.detectChanges();
    expect(root.querySelector('dialog')).toBeNull();
    expect(sheet()!.getAttribute('aria-modal')).toBeNull();
    expect(sheet()!.closest('[inert]')).toBeNull();
    expect(document.body.hasAttribute('inert')).toBe(false);
    // O foco não é roubado: nada dentro da folha o recebe sozinho.
    expect(root.contains(document.activeElement)).toBe(false);
  });

  it('"Agora não" closes it and a later failure does not reopen it', () => {
    permission.denied();
    fixture.detectChanges();
    button('Agora não')!.click();
    fixture.detectChanges();
    expect(sheet()).toBeNull();
    expect(permission.denied()).toBe(false);
    fixture.detectChanges();
    expect(sheet()).toBeNull();
  });

  it('"Pedir na TV" shows the persistent notice for the accept, and the sheet leaves', async () => {
    permission.denied();
    fixture.detectChanges();
    api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
    button('Pedir na TV')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
    expect(notice()?.textContent).toContain('Aceite na TV e marque Sempre permitir');
  });

  it('shows the notice whenever the agent says the prompt is on the TV', () => {
    store.state.set({ ...HOT, adbPermission: 'pending' });
    fixture.detectChanges();
    expect(notice()?.textContent).toContain('Aceite na TV e marque Sempre permitir');
    store.state.set({ ...HOT, adbPermission: 'granted' });
    fixture.detectChanges();
    expect(notice()?.textContent).toContain('Pronto');
  });

  it('opens by itself when the agent says "missing", and only with a live connection', () => {
    store.link.set('offline');
    store.state.set({ ...HOT, adbPermission: 'missing' });
    fixture.detectChanges();
    expect(sheet()).toBeNull(); // estado guardado, sem rede: não diz o que a TV pensa agora
    store.link.set('ok');
    fixture.detectChanges();
    expect(sheet()).not.toBeNull();
  });

  it('ignores the state of an agent that is off', () => {
    store.state.set({ ...HOT, agentOnline: false, adbPermission: 'missing' });
    fixture.detectChanges();
    expect(sheet()).toBeNull();
  });

  it('tells an expired wait and offers to ask again', () => {
    store.state.set({ ...HOT, adbPermission: 'pending' });
    fixture.detectChanges();
    store.state.set({ ...HOT, adbPermission: 'missing' });
    fixture.detectChanges();
    expect(sheet()?.textContent).toContain('Ninguém aceitou na TV');
    expect(button('Pedir na TV')).toBeDefined();
  });
});
