import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TRAINING_ROUTES } from './training.routes';
import { TrainingPage } from './training-page';

describe('TrainingPage', () => {
  it('renders the title', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(TrainingPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('Treino');
  });

  it('resolves the lazy component', async () => {
    const loader = TRAINING_ROUTES[0].loadComponent as () => Promise<unknown>;
    expect(await loader()).toBe(TrainingPage);
  });
});
