import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TV_ROUTES } from './tv.routes';
import { TvPage } from './tv-page';

describe('TvPage', () => {
  it('renders the title', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(TvPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('TV');
  });

  it('resolves the lazy component', async () => {
    const loader = TV_ROUTES[0].loadComponent as () => Promise<unknown>;
    expect(await loader()).toBe(TvPage);
  });
});
