import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../../app.routes';
import { CreditsPage } from './credits.page';

describe('credits route', () => {
  const shell = routes.find((route) => route.path === '')!;
  const settings = (shell.children ?? []).find((child) => child.path === 'ajustes')!;
  const children = settings.children ?? [];

  it('is one of the screens of Configurações, next to the others', () => {
    expect(children.map((route) => route.path)).toContain('creditos');
  });

  it('is inside the shell, behind the same guard, with its own title and the way back to Configurações', () => {
    expect(shell.canMatch).toBeDefined();
    const route = children.find((child) => child.path === 'creditos')!;
    const data = route.data as { title: string; back: { link: string } };
    expect(data.title).toBe('Créditos');
    expect(data.back.link).toBe('/ajustes');
  });

  it('is open to who uses the Treino (the screens of the Treino link to it), behind the module guard', () => {
    const route = children.find((child) => child.path === 'creditos')!;
    expect(route.canMatch).toBeDefined();
    expect(route.canMatch).toHaveLength(1);
  });

  it('lazy-loads the credits page', async () => {
    const route = children.find((child) => child.path === 'creditos')!;
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
