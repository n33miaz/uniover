import { TestBed } from '@angular/core/testing';
import { TV_ROUTES } from './tv.routes';
import { TvPage } from './tv-page';

describe('TvPage', () => {
  it('renders the placeholder text', async () => {
    const fixture = TestBed.createComponent(TvPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ainda não está disponível',
    );
  });

  it('resolves the lazy component and declares its tabs', async () => {
    const route = TV_ROUTES[0];
    expect(await (route.loadComponent as () => Promise<unknown>)()).toBe(TvPage);
    expect((route.data as { tabs: unknown[] }).tabs).toHaveLength(1);
  });
});
