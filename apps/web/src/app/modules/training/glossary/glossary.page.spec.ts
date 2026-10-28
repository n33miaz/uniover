import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { setupScreen } from '../shell/screen-test-kit';
import { TrainingGlossaryPage } from './glossary.page';

describe('TrainingGlossaryPage', () => {
  it('explains the weekly program, the day plan, the routine and the exercise in their hierarchy', async () => {
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
    ).toEqual(['Programa Semanal', 'Plano do Dia', 'Rotina', 'Exercício']);
    // "Plano" é só o treino marcado para o dia; o texto nunca o chama de ficha.
    expect(el.querySelectorAll('.term')[1].textContent).toContain('Rotina que o Programa escolhe');
    expect(el.textContent).not.toMatch(/ficha/i);
    expect(el.querySelector('.lead')?.textContent?.trim()).toBe(
      'O Programa tem Rotinas, e cada Rotina tem Exercícios.',
    );
    // Cada cartão leva à tela do termo.
    expect(
      Array.from(el.querySelectorAll('.term')).map((node) => node.getAttribute('href')),
    ).toEqual(['/treino', '/treino', '/treino/rotinas', '/treino/exercicios']);
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
