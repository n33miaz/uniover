import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';

describe('app routes', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter(routes)] }));

  it.each([
    ['/', 'app-home-page'],
    ['/tv', 'app-tv-page'],
    ['/treino', 'app-training-page'],
    ['/ajustes', 'app-settings-page'],
  ])('%s renders %s inside the shell', async (url, selector) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it('serves the sign-in page outside the shell', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/entrar');
    expect(harness.routeNativeElement?.matches('app-login-page')).toBe(true);
  });

  it('sends unknown paths home', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/nada');
    expect(TestBed.inject(Router).url).toBe('/');
  });
});
