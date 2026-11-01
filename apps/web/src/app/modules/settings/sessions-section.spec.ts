import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthApi, LoginSession } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { SessionsSection } from './sessions-section';

const own: LoginSession = {
  id: 'own',
  userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/605.1.15',
  ip: '192.0.2.0/24',
  createdAt: '2026-10-25T10:00:00Z',
  lastUsedAt: '2026-10-26T10:00:00Z',
  isCurrent: true,
};
const other: LoginSession = {
  ...own,
  id: 'other',
  userAgent: 'Mozilla/5.0 (Windows) Chrome/120',
  isCurrent: false,
};

describe('SessionsSection', () => {
  const status = signal<'authenticated' | 'pending'>('authenticated');
  const role = signal<'owner' | 'guest'>('owner');
  const api = { sessions: vi.fn(), revokeSession: vi.fn(), revokeOtherSessions: vi.fn() };
  const auth = {
    authorized: vi.fn((call: (token: string) => Promise<unknown>) => call('jwt')),
    logout: vi.fn(),
  };

  beforeEach(() => {
    status.set('authenticated');
    role.set('owner');
    for (const fn of Object.values(api)) fn.mockReset();
    auth.authorized.mockClear();
    auth.logout.mockReset().mockResolvedValue(true);
    api.sessions.mockResolvedValue([own, other]);
    api.revokeSession.mockResolvedValue(undefined);
    api.revokeOtherSessions.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthApi, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: SessionState, useValue: { status, role } },
      ],
    });
  });

  async function render(guestId: string | null = null) {
    const fixture = TestBed.createComponent(SessionsSection);
    fixture.componentRef.setInput('guestId', guestId);
    if (guestId) fixture.componentRef.setInput('guestName', 'Bia');
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const click = (text: string) => {
      const button = Array.from(el.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === text,
      );
      expect(button).toBeTruthy();
      button!.click();
      fixture.detectChanges();
    };
    return { fixture, el, click };
  }

  it('shows the current device and requires confirmation before revoking the other session', async () => {
    const { fixture, el } = await render();
    expect(el.textContent).toContain('Safari · iPhone/iPad');
    expect(el.textContent).toContain('Este aparelho');
    expect(el.textContent).toContain('192.0.2.0/24');
    expect(api.sessions).toHaveBeenCalledWith('jwt', null);
    const endButtons = Array.from(el.querySelectorAll<HTMLButtonElement>('li button')).filter(
      (b) => b.textContent?.trim() === 'Encerrar',
    );
    endButtons[1].click();
    fixture.detectChanges();
    expect(api.revokeSession).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.confirm .danger')!.click();
    await fixture.whenStable();
    expect(api.revokeSession).toHaveBeenCalledWith('jwt', 'other', null);
  });

  it('keeps session details folded until the person asks for them', async () => {
    const { el } = await render();
    const details = el.querySelector<HTMLDetailsElement>('li details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Safari · iPhone/iPad');
    expect(details.textContent).toContain('Último uso:');
  });

  it('ends the other sessions only after confirmation', async () => {
    const { fixture, click } = await render();
    click('Encerrar as outras');
    expect(api.revokeOtherSessions).not.toHaveBeenCalled();
    click('Encerrar as outras');
    await fixture.whenStable();
    expect(api.revokeOtherSessions).toHaveBeenCalledWith('jwt');
  });

  it('signs out when ending the current session', async () => {
    const { fixture, el } = await render();
    const first = el.querySelector<HTMLButtonElement>('li button')!;
    first.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.confirm .danger')!.click();
    await fixture.whenStable();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(api.revokeSession).toHaveBeenCalledWith('jwt', 'own');
  });

  it('uses the administrator route for a guest and never offers the bulk action', async () => {
    const { fixture, el } = await render('guest-1');
    expect(api.sessions).toHaveBeenCalledWith('jwt', 'guest-1');
    expect(el.textContent).not.toContain('Encerrar as outras');
    el.querySelector<HTMLButtonElement>('li button')!.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.confirm .danger')!.click();
    await fixture.whenStable();
    expect(api.revokeSession).toHaveBeenCalledWith('jwt', 'own', 'guest-1');
  });

  it('waits for the owner role before reading a guest', async () => {
    role.set('guest');
    const { fixture } = await render('guest-1');
    expect(api.sessions).not.toHaveBeenCalled();
    role.set('owner');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.sessions).toHaveBeenCalledWith('jwt', 'guest-1');
  });

  it('lets a guest read only the self-service route', async () => {
    role.set('guest');
    await render();
    expect(api.sessions).toHaveBeenCalledWith('jwt', null);
  });

  it('uses cards as the loading state instead of a loose sentence', () => {
    api.sessions.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(SessionsSection);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
    ).not.toBeNull();
    expect(root.querySelectorAll('app-loading-skeleton .card')).toHaveLength(2);
  });

  describe('device and installed app', () => {
    const titles = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('summary strong')).map((node) => node.textContent?.trim());

    it('says "App Instalado" for a session the app reported as installed', async () => {
      api.sessions.mockResolvedValue([{ ...own, platform: 'iphone', installed: true }]);
      const { el } = await render();
      expect(titles(el)).toEqual(['iPhone · App Instalado']);
    });

    it('says the browser for a session opened in a tab, on every device', async () => {
      api.sessions.mockResolvedValue([
        { ...own, id: 'a', platform: 'iphone', installed: false },
        {
          ...own,
          id: 'b',
          userAgent:
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
          platform: 'android',
          installed: false,
        },
        { ...other, id: 'c', platform: 'pc', installed: false },
        { ...other, id: 'd', platform: 'ipad', installed: true },
      ]);
      const { el } = await render();
      expect(titles(el)).toEqual([
        'iPhone · Safari',
        'Android · Chrome',
        'PC · Chrome',
        'iPad · App Instalado',
      ]);
    });

    it('keeps the old text for a session from before the app reported anything', async () => {
      api.sessions.mockResolvedValue([own, { ...other, platform: null, installed: null }]);
      const { el } = await render();
      expect(titles(el)).toEqual(['Safari · iPhone/iPad', 'Chrome · Windows']);
    });
  });
});
