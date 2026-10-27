import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { version } from '../../../../package.json';
import { AboutPage } from './about.page';

const ME = { id: '1', email: 'dono@exemplo.com', displayName: 'Dono da Casa' };

describe('AboutPage', () => {
  const api = { refresh: vi.fn(), me: vi.fn(), deploymentVersion: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    api.refresh.mockReset().mockResolvedValue({ accessToken: 't', expiresIn: 600 });
    api.me.mockReset().mockResolvedValue(ME);
    api.deploymentVersion.mockReset().mockResolvedValue({ commit: 'abc', version: '0.5.0' });
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthApi, useValue: api }],
    });
  });

  afterEach(() => localStorage.clear());

  async function render() {
    await TestBed.inject(AuthService).init();
    const fixture = TestBed.createComponent(AboutPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the app version from package.json and the API version', async () => {
    const { el } = await render();
    const versions = el.querySelector('#versions-title + dl')!.textContent!;
    expect(versions).toContain('0.5.0');
    expect(versions).toContain(version);
  });

  it('handles an API that does not answer', async () => {
    api.deploymentVersion.mockRejectedValue(new ApiProblem(0, 'network', 'x'));
    const { el } = await render();
    expect(el.querySelector('#versions-title + dl')!.textContent).toContain('indisponível agora');
  });

  it('asks only for the public deployment version route, without a token', async () => {
    api.refresh.mockRejectedValue(networkProblem());
    await render();
    expect(api.deploymentVersion).toHaveBeenCalledTimes(1);
    expect(api.deploymentVersion.mock.calls[0]).toEqual([]);
  });

  it('links the credits entry to the credits screen for the administrator', async () => {
    const { el } = await render();
    const credits = Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).find((a) =>
      a.textContent?.trim().startsWith('Créditos'),
    );
    expect(credits?.getAttribute('href')).toBe('/ajustes/creditos');
  });

  it('does not offer the credits to a guest: the screen is only for the administrator, so the link would bounce', async () => {
    api.me.mockResolvedValue({ ...ME, role: 'guest' });
    const { el } = await render();
    expect(el.querySelector('a[href="/ajustes/creditos"]')).toBeNull();
    expect(el.textContent).not.toContain('Créditos');
    // As versões continuam valendo para todos.
    expect(el.querySelector('#versions-title + dl')!.textContent).toContain('0.5.0');
  });
});
