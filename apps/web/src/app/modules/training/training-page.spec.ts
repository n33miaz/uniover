import { TestBed } from '@angular/core/testing';
import { TRAINING_ROUTES } from './training.routes';
import { TrainingPage } from './training-page';

describe('TrainingPage', () => {
  it('renders the placeholder text', async () => {
    const fixture = TestBed.createComponent(TrainingPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'ainda não está disponível',
    );
  });

  it('resolves the lazy component and declares its tabs', async () => {
    const route = TRAINING_ROUTES[0];
    expect(await (route.loadComponent as () => Promise<unknown>)()).toBe(TrainingPage);
    expect((route.data as { tabs: unknown[] }).tabs).toHaveLength(1);
  });
});
