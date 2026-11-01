import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SessionState, SessionUser } from '../session/session-state';
import { TvPermissionHost } from './tv-permission-host';
import { TV_PERMISSION_DISMISSED_KEY, TvPermissionService } from './tv-permission.service';

const RAPHAEL: SessionUser = {
  id: '0192f1e4-7b3a-7c2e-9d11-5a4b6c7d8e9f',
  email: 'r@exemplo.com',
  displayName: 'Raphael',
  role: 'guest',
  permissions: ['module:tv', 'tv:control'],
};

describe('TvPermissionHost', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.removeItem(TV_PERMISSION_DISMISSED_KEY);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    document.querySelectorAll('dialog[open]').forEach((d) => d.remove());
    sessionStorage.removeItem(TV_PERMISSION_DISMISSED_KEY);
    http.verify();
  });

  function mount(user: SessionUser | null) {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    if (user) session.setUser(user);
    const fixture = TestBed.createComponent(TvPermissionHost);
    fixture.detectChanges();
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, el: fixture.nativeElement as HTMLElement, session, settle };
  }

  it('opens the sheet right away when a TV of the account needs the accept', async () => {
    const { el, settle } = mount(RAPHAEL);
    http.expectOne('/api/v1/tv/permission').flush({ items: [{ tvId: 'tv-2', name: 'Raphael' }] });
    await settle();
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Permissão da TV');
  });

  it('draws nothing when no TV needs the accept', async () => {
    const { el, settle } = mount(RAPHAEL);
    http.expectOne('/api/v1/tv/permission').flush({ items: [] });
    await settle();
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('does not even ask for an account without the TV module', async () => {
    const { el, settle } = mount({ ...RAPHAEL, permissions: ['module:training'] });
    await settle();
    http.expectNone('/api/v1/tv/permission');
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('does not ask before the session is confirmed', async () => {
    const fixture = TestBed.createComponent(TvPermissionHost);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectNone('/api/v1/tv/permission');
  });

  it('a server error never traps the person', async () => {
    const { el, settle } = mount(RAPHAEL);
    http.expectOne('/api/v1/tv/permission').flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('Depois hides it for this visit and does not ask again on its own', async () => {
    const { el, settle } = mount(RAPHAEL);
    http.expectOne('/api/v1/tv/permission').flush({ items: [{ tvId: 'tv-2', name: 'Raphael' }] });
    await settle();
    const later = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Depois',
    )!;
    later.click();
    await settle();
    expect(el.querySelector('dialog')).toBeNull();
    http.expectNone('/api/v1/tv/permission');
    expect(TestBed.inject(TvPermissionService).current()).toBeNull();
  });

  it('reads once per account, not on every change of the session', async () => {
    const { session, settle } = mount(RAPHAEL);
    http.expectOne('/api/v1/tv/permission').flush({ items: [] });
    await settle();
    session.setUser({ ...RAPHAEL, displayName: 'Raphael M.' });
    await settle();
    http.expectNone('/api/v1/tv/permission');
  });
});
