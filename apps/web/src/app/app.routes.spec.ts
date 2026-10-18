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
  ])('%s resolves to %s', async (url, selector) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    expect(harness.routeNativeElement?.matches(selector)).toBe(true);
  });

  it('sends unknown paths home', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/nada');
    expect(TestBed.inject(Router).url).toBe('/');
  });
});
