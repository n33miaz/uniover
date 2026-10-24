import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { SystemApi } from './system-api';

describe('system route', () => {
  it('renders the page lazily, inside the shell, under Ajustes, with the TV section', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: SystemApi, useValue: { tvConfig: () => new Promise(() => undefined) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/sistema');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector('app-system-page app-system-tv-section')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Sistema');
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('TVs');
  });
});
