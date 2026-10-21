import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GoalRepository } from '../../data/goals/goal-repository';
import type { GoalKind } from '../../domain/progress/goal-model';
import { eventually } from '../../shell/screen-test-kit';
import { setupProgress } from '../progress-test-kit';
import { GoalSheet } from './goal-sheet';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('GoalSheet', () => {
  async function open(kind: GoalKind, current: number | null = null) {
    const kit = await setupProgress();
    const goals = TestBed.inject(GoalRepository);
    const exerciseId = kind === 'exercise_e1rm' ? 'supino-reto' : null;
    if (current !== null) await goals.set(kind, current, exerciseId);
    const fixture = TestBed.createComponent(GoalSheet);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('exerciseId', exerciseId);
    fixture.componentRef.setInput(
      'heading',
      kind === 'exercise_e1rm' ? 'Meta de 1RM' : 'Meta semanal',
    );
    fixture.componentRef.setInput(
      'fieldLabel',
      kind === 'exercise_e1rm' ? 'Meta, em kg' : 'Treinos',
    );
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const type = (value: string) => {
      const input = el.querySelector<HTMLInputElement>('input')!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const save = () => el.querySelector<HTMLButtonElement>('button.primary')!.click();
    const error = () => text(el.querySelector('.error'));
    return { ...kit, goals, exerciseId, fixture, el, type, save, error };
  }

  it('titles the sheet and asks for the value, with the goal as the owner’s: no value is suggested', async () => {
    const { el } = await open('exercise_e1rm');

    expect(text(el.querySelector('h2'))).toBe('Meta de 1RM');
    expect(text(el.querySelector('label'))).toBe('Meta, em kg');
    expect(el.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(el.querySelector('input')!.getAttribute('inputmode')).toBe('decimal');
    expect(text(el)).toContain('linha tracejada no gráfico de 1RM');
    expect(text(el)).not.toContain('Remover meta');
  });

  it('refuses what the server would refuse, and says why, without writing anything', async () => {
    const { type, save, error, fixture, trainingDb, db } = await open('exercise_e1rm');

    type('0');
    save();
    await eventually(fixture, () => expect(error()).toBe('Use de 1 a 1.000 kg.'));
    type('abc');
    save();
    await eventually(fixture, () => expect(error()).toBe('Digite um número, como 55 ou 42,5.'));
    type('');
    save();
    await eventually(fixture, () => expect(error()).toBe('Digite um número, como 55 ou 42,5.'));
    type('55,555');
    save();
    await eventually(fixture, () => expect(error()).toBe('Use no máximo duas casas decimais.'));

    expect(await trainingDb.goals.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('saves a decimal typed with a comma, once, and queues one request', async () => {
    const { type, save, fixture, trainingDb, db, goals } = await open('exercise_e1rm');

    type('55,5');
    save();
    await vi.waitFor(async () =>
      expect(await goals.value('exercise_e1rm', 'supino-reto')).toBe(55.5),
    );

    expect(await trainingDb.goals.count()).toBe(1);
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].url).toMatch(/\/goals\/exercise_e1rm$/);
    expect(queued[0].body).toMatchObject({ exerciseId: 'supino-reto', value: 55.5 });
    fixture.detectChanges();
  });

  it('saves with the Enter key too', async () => {
    const { type, el, goals } = await open('exercise_e1rm');

    type('60');
    el.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(async () =>
      expect(await goals.value('exercise_e1rm', 'supino-reto')).toBe(60),
    );
  });

  it('asks for a whole number of workouts a week, from 1 to 14', async () => {
    const { type, save, error, fixture, el, goals } = await open('weekly_sessions');
    expect(el.querySelector('input')!.getAttribute('inputmode')).toBe('numeric');
    expect(text(el)).toContain('De 1 a 14 treinos');

    type('3,5');
    save();
    await eventually(fixture, () => expect(error()).toBe('Use um número inteiro de treinos.'));
    type('15');
    save();
    await eventually(fixture, () => expect(error()).toBe('Use de 1 a 14 treinos por semana.'));
    type('4');
    save();
    await vi.waitFor(async () => expect(await goals.value('weekly_sessions')).toBe(4));
  });

  it('starts from the current value, and removes the goal on request', async () => {
    const { el, fixture, goals, trainingDb } = await open('exercise_e1rm', 42.5);

    expect(el.querySelector<HTMLInputElement>('input')!.value).toBe('42,5');
    el.querySelector<HTMLButtonElement>('button.remove')!.click();

    await vi.waitFor(async () =>
      expect(await goals.value('exercise_e1rm', 'supino-reto')).toBeNull(),
    );
    // A remoção é uma lápide (a linha fica, marcada), para valer em todos os aparelhos.
    expect(await trainingDb.goals.get('exercise_e1rm:supino-reto')).toMatchObject({
      value: null,
    });
    fixture.detectChanges();
  });
});
