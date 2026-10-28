import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { setupScreen } from '../shell/screen-test-kit';
import { TrainingGlossaryPage } from './glossary.page';

describe('TrainingGlossaryPage', () => {
  it('explains the weekly program, routine and exercise in their hierarchy', async () => {
    const kit = await setupScreen([
      { path: 'treino/glossario', component: TrainingGlossaryPage },
      { path: 'treino', children: [] },
    ]);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino/glossario', TrainingGlossaryPage);
    const el = harness.routeNativeElement as HTMLElement;

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Entenda o Treino');
    expect(
      Array.from(el.querySelectorAll('.terms h3')).map((node) => node.textContent?.trim()),
    ).toEqual(['Programa Semanal', 'Rotina', 'Exercício']);
    expect(el.textContent).not.toContain('Plano');
  });

  it('returns to the training home when opened directly', async () => {
    const kit = await setupScreen([
      { path: 'treino/glossario', component: TrainingGlossaryPage },
      { path: 'treino', children: [] },
    ]);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino/glossario', TrainingGlossaryPage);
    const el = harness.routeNativeElement as HTMLElement;

    history.replaceState({ navigationId: 1 }, '');
    el.querySelector<HTMLButtonElement>('.back')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/treino');
  });
});
