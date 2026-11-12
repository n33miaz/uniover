import { TestBed } from '@angular/core/testing';
import { localExercise } from '../data/sync/training-test-kit';
import { ExerciseRowBody } from './exercise-row-body';

describe('ExerciseRowBody', () => {
  it('keeps the full long exercise name in a title while the row can clamp it visually', () => {
    const name = 'Remada Unilateral na Máquina Articulada com Pegada Neutra e Apoio de Peito';
    const fixture = TestBed.createComponent(ExerciseRowBody);
    fixture.componentRef.setInput('exercise', localExercise('remada-longa', { name }));
    fixture.detectChanges();

    const title = (fixture.nativeElement as HTMLElement).querySelector('.name');
    expect(title?.textContent).toBe(name);
    expect(title?.getAttribute('title')).toBe(name);
  });
});
