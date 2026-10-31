import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../../app.routes';
import { CreditsPage } from './credits.page';

// Estes testes carregam módulos sob demanda (e o último, o shell inteiro): com a máquina ocupada pelas outras suítes o
// primeiro carregamento passava dos 5 s do padrão e o teste falhava só às vezes.
const LAZY_LOAD_TIMEOUT_MS = 20_000;

describe('credits route', () => {
  const shell = routes.find((route) => route.path === '')!;
  const settings = (shell.children ?? []).find((child) => child.path === 'ajustes')!;
  const children = settings.children ?? [];
  const about = children.find((child) => child.path === 'sobre')!;
  const sheet = (about.children ?? []).find((child) => child.path === 'creditos')!;

  it('is a child of Sobre, so the sheet opens over that screen', () => {
    expect(sheet).toBeDefined();
    expect(about.children).toHaveLength(1);
  });

  it('keeps the old address working for the screens of the Treino', () => {
    const old = children.find((child) => child.path === 'creditos')!;
    expect(old.redirectTo).toBe('sobre/creditos');
  });

  it('is open to who uses the Treino, behind the module guard', () => {
    expect(sheet.canMatch).toHaveLength(1);
  });

  it(
    'lazy-loads the credits page',
    async () => {
      expect(await (sheet.loadComponent as () => Promise<unknown>)()).toBe(CreditsPage);
    },
    LAZY_LOAD_TIMEOUT_MS,
  );

  it(
    'renders the credits sheet over Sobre, inside the shell',
    async () => {
      TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/ajustes/creditos');
      const root = harness.routeNativeElement as HTMLElement;
      expect(root.matches('app-shell')).toBe(true);
      expect(root.querySelector('app-about-page')).not.toBeNull();
      expect(root.querySelector('app-about-page app-credits-page')).not.toBeNull();
      expect(root.querySelector('h1')?.textContent).toBe('Sobre');
    },
    LAZY_LOAD_TIMEOUT_MS,
  );
});
