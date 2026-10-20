import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../../app.routes';
import { CreditsPage } from './credits.page';

describe('credits route', () => {
  const shell = routes.find((route) => route.path === '')!;
  const children = shell.children ?? [];

  it('sits right before the Ajustes route, so the longer path wins', () => {
    const paths = children.map((route) => route.path);
    expect(paths.indexOf('ajustes/creditos')).toBeGreaterThan(-1);
    expect(paths.indexOf('ajustes/creditos')).toBeLessThan(paths.indexOf('ajustes'));
  });

  it('is inside the shell, behind the same guard, with its own title', () => {
    expect(shell.canMatch).toBeDefined();
    const route = children.find((child) => child.path === 'ajustes/creditos')!;
    expect((route.data as { title: string }).title).toBe('Créditos');
  });

  it('lazy-loads the credits page', async () => {
    const route = children.find((child) => child.path === 'ajustes/creditos')!;
    expect(await (route.loadComponent as () => Promise<unknown>)()).toBe(CreditsPage);
  });

  it('renders the credits page inside the shell', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/creditos');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector('app-credits-page')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Créditos');
  });
});
