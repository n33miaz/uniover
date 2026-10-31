import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GoalRepository } from '../../data/goals/goal-repository';
import { eventually, seedHistory } from '../../shell/screen-test-kit';
import { setupProgress } from '../progress-test-kit';
import { ProgressFrequency, WEEKDAYS, constancyLine, monthWorkouts } from './frequency-section';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('constancyLine', () => {
  it('says how many workouts a week in the last two weeks, with a range when they differ', () => {
    expect(constancyLine([3, 3], null, 0)).toBe(
      'Constância: 3 treinos por semana nas duas últimas semanas',
    );
    expect(constancyLine([1, 1], null, 0)).toBe(
      'Constância: 1 treino por semana nas duas últimas semanas',
    );
    expect(constancyLine([2, 3], null, 0)).toBe(
      'Constância: entre 2 e 3 treinos por semana nas duas últimas semanas',
    );
    expect(constancyLine([3, 2], null, 0)).toBe(
      'Constância: entre 2 e 3 treinos por semana nas duas últimas semanas',
    );
    expect(constancyLine([0, 0], null, 0)).toBe(
      'Constância: nenhum treino nas duas últimas semanas',
    );
  });

  it('adds the goal, and the streak when there is one, only when the owner defined a goal', () => {
    expect(constancyLine([3, 3], 3, 0)).toBe(
      'Constância: 3 treinos por semana nas duas últimas semanas (meta: 3)',
    );
    expect(constancyLine([3, 3], 3, 1)).toBe(
      'Constância: 3 treinos por semana nas duas últimas semanas (meta: 3). 1 semana seguida com a meta',
    );
    expect(constancyLine([3, 3], 3, 4)).toBe(
      'Constância: 3 treinos por semana nas duas últimas semanas (meta: 3). 4 semanas seguidas com a meta',
    );
  });
});

describe('monthWorkouts', () => {
  it('counts the workouts of the month', () => {
    expect(monthWorkouts(0)).toBe('nenhum treino');
    expect(monthWorkouts(1)).toBe('1 treino');
    expect(monthWorkouts(8)).toBe('8 treinos');
  });
});

describe('WEEKDAYS', () => {
  it('starts on Sunday and ends on Saturday', () => {
    expect(WEEKDAYS.map((day) => day.short)).toEqual([
      'dom',
      'seg',
      'ter',
      'qua',
      'qui',
      'sex',
      'sáb',
    ]);
    expect(WEEKDAYS[0].long).toBe('domingo');
    expect(WEEKDAYS[6].long).toBe('sábado');
  });
});

describe('ProgressFrequency', () => {
  /**
   * O "agora" dos testes é quinta-feira, 9/10/2025. Treinos: 22/09 (dia 99), 1/10 (dia 108), 6/10 (dia 113) e 8/10
   * (dia 115). Semanas completas mais recentes: 22 a 28/09 (1 treino) e 29/09 a 5/10 (1 treino).
   */
  async function open() {
    const kit = await setupProgress();
    await seedHistory(kit.trainingDb, 'supino-reto', [
      [99, 40, 10],
      [108, 40, 10],
      [113, 40, 10],
    ]);
    await seedHistory(kit.trainingDb, 'agachamento', [[115, 60, 8]]);
    const fixture = TestBed.createComponent(ProgressFrequency);
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.toggle')!;
  const trained = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.day.on')).map((day) => text(day));

  async function openSection() {
    const opened = await open();
    await eventually(opened.fixture, () =>
      expect(text(opened.el.querySelector('.ui-row-sub'))).toBe('Outubro · 3 treinos'),
    );
    toggle(opened.el).click();
    opened.fixture.detectChanges();
    return opened;
  }

  it('says on the closed row how many workouts there were this month', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('Outubro · 3 treinos'),
    );
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('table')).toBeNull();
  });

  it('marks the trained days with a filled shape, today with an outline, and names them for a screen reader', async () => {
    const { fixture, el } = await openSection();
    await eventually(fixture, () => expect(trained(el)).toEqual(['1', '6', '8']));

    expect(text(el.querySelector('.range b'))).toBe('Outubro de 2025');
    expect(text(el.querySelector('.range span'))).toBe('3 treinos no mês');
    // Hoje (9/10) tem contorno e é anunciado como a data de hoje; não treinou, então não é um dia cheio.
    const today = el.querySelector('.day.today')!;
    expect(text(today)).toBe('9');
    expect(today.classList.contains('on')).toBe(false);
    expect(today.parentElement!.getAttribute('aria-current')).toBe('date');
    // O dia treinado diz "treino em 06/10" em vez do número.
    const labels = Array.from(el.querySelectorAll('td[aria-label]')).map((cell) =>
      cell.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['treino em 01/10', 'treino em 06/10', 'treino em 08/10']);
    expect(text(el.querySelector('caption'))).toBe('Outubro de 2025: dias com treino marcados');
  });

  it('lays the month out from Sunday: October 2025 starts on a Wednesday', async () => {
    const { fixture, el } = await openSection();
    await eventually(fixture, () => expect(el.querySelectorAll('tbody tr')).toHaveLength(5));

    const headers = Array.from(el.querySelectorAll('thead abbr')).map((abbr) => text(abbr));
    expect(headers).toEqual(['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']);
    const first = Array.from(el.querySelectorAll('tbody tr')[0].children).map((cell) => text(cell));
    expect(first).toEqual(['', '', '', '1', '2', '3', '4']);
    const last = Array.from(el.querySelectorAll('tbody tr')[4].children).map((cell) => text(cell));
    expect(last).toEqual(['26', '27', '28', '29', '30', '31', '']);
  });

  it('goes to the previous month and back, and does not go past the current month', async () => {
    const { fixture, el } = await openSection();
    await eventually(fixture, () => expect(trained(el)).toEqual(['1', '6', '8']));
    const previous = el.querySelector<HTMLButtonElement>('button[aria-label="Mês anterior"]')!;
    const next = el.querySelector<HTMLButtonElement>('button[aria-label="Próximo mês"]')!;
    expect(next.disabled).toBe(true);

    previous.click();
    await eventually(fixture, () => expect(trained(el)).toEqual(['22']));
    expect(text(el.querySelector('.range b'))).toBe('Setembro de 2025');
    expect(text(el.querySelector('.range span'))).toBe('1 treino no mês');
    expect(el.querySelector('.day.today')).toBeNull();
    expect(next.disabled).toBe(false);

    next.click();
    await eventually(fixture, () => expect(trained(el)).toEqual(['1', '6', '8']));
    expect(next.disabled).toBe(true);
  });

  it('shows the constancy of the last two weeks, and that the goal is the owner’s to define', async () => {
    const { fixture, el } = await openSection();
    await eventually(fixture, () =>
      expect(text(el)).toContain('Constância: 1 treino por semana nas duas últimas semanas'),
    );
    expect(text(el)).not.toContain('(meta:');
    expect(text(el)).toContain('Sem meta semanal definida.');
  });

  it('counts the streak against the weekly goal once there is one', async () => {
    const { fixture, el } = await openSection();
    await TestBed.inject(GoalRepository).set('weekly_sessions', 1);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(text(el)).toContain(
        'Constância: 1 treino por semana nas duas últimas semanas (meta: 1). 3 semanas seguidas com a meta',
      );
    });
    expect(text(el)).not.toContain('Sem meta semanal definida');
  });
});
