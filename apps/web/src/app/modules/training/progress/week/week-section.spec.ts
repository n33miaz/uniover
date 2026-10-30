import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GoalRepository } from '../../data/goals/goal-repository';
import type { WeeklyVolume } from '../../domain/progress/week-stats';
import { eventually, seedHistory } from '../../shell/screen-test-kit';
import { setupProgress } from '../progress-test-kit';
import { ProgressWeek, groupBars, weekLine } from './week-section';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('groupBars', () => {
  // A semana do desenho aprovado: Peito 10, Costas 12, Pernas 12, Ombros 8, Bíceps 6 + Tríceps 6 = 54 séries.
  const volume: WeeklyVolume = {
    total: 54,
    byGroup: { chest: 10, back: 12, legs: 12, shoulders: 8, arms: 12, core: 0 },
    byMuscle: {},
    unclassified: 0,
  };

  it('makes each bar relative to the most trained group, with the real number beside it', () => {
    const bars = groupBars(volume);

    expect(bars.map((bar) => [bar.label, bar.sets, bar.percent])).toEqual([
      ['Peito', 10, 83.3],
      ['Costas', 12, 100],
      ['Pernas', 12, 100],
      ['Ombros', 8, 66.7],
      ['Braços', 12, 100],
      ['Abdômen', 0, 0],
    ]);
    // Os seis grupos somam as 54 séries da semana (nenhuma série fora de grupo).
    expect(bars.reduce((sum, bar) => sum + bar.sets, 0)).toBe(volume.total);
  });

  it('draws empty bars, not a division by zero, in a week with no set', () => {
    const empty: WeeklyVolume = {
      total: 0,
      byGroup: { chest: 0, back: 0, legs: 0, shoulders: 0, arms: 0, core: 0 },
      byMuscle: {},
      unclassified: 0,
    };
    expect(groupBars(empty).map((bar) => bar.percent)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('weekLine', () => {
  it('counts workouts and sets, and compares with the weekly goal only when there is one', () => {
    expect(weekLine(3, 54, null)).toBe('3 treinos · 54 séries');
    expect(weekLine(3, 54, 4)).toBe('3 de 4 treinos · 54 séries');
    expect(weekLine(1, 1, null)).toBe('1 treino · 1 série');
    expect(weekLine(0, 0, null)).toBe('Nenhum treino nesta semana');
    expect(weekLine(0, 0, 3)).toBe('Nenhum treino nesta semana');
  });
});

describe('ProgressWeek', () => {
  /**
   * O "agora" dos testes é quinta-feira, 9/10/2025 (dia 114 a partir de `HISTORY_START`). A semana de hoje vai de domingo
   * 5/10 a sábado 11/10; a anterior, de 28/09 a 4/10.
   *
   *   esta semana:   dia 113 supino × 3 séries (peito) · dia 115 agachamento × 2 séries (pernas) → 2 treinos, 5 séries
   *   semana passada: dia 108 supino × 2 séries → 1 treino, 2 séries
   */
  async function open() {
    const kit = await setupProgress();
    await seedHistory(kit.trainingDb, 'supino-reto', [
      [113, 40, 10],
      [113, 40, 10],
      [113, 40, 10],
      [108, 40, 10],
      [108, 40, 10],
    ]);
    await seedHistory(kit.trainingDb, 'agachamento', [
      [115, 60, 8],
      [115, 60, 8],
    ]);
    const fixture = TestBed.createComponent(ProgressWeek);
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.toggle')!;
  const bars = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.bar')).map((bar) => [
      text(bar.querySelector('.name')),
      text(bar.querySelector('.count')),
      bar.querySelector('rect.fill')?.getAttribute('width'),
    ]);

  it('says on the closed row what happened this week, and opens to the volume by group', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('2 treinos · 5 séries'),
    );
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.bars')).toBeNull();

    toggle(el).click();
    await eventually(fixture, () => expect(el.querySelectorAll('.bar')).toHaveLength(6));

    expect(text(el.querySelector('.range b'))).toBe('5 a 11 de outubro');
    expect(text(el.querySelector('.range span'))).toBe('Esta semana');
    expect(text(el.querySelector('.totals b'))).toBe('2 treinos · 5 séries');
    expect(text(el.querySelector('.totals span'))).toBe('Semana anterior: 2 séries');
    // Barras relativas ao grupo mais treinado (peito, 3): pernas é 2 de 3.
    expect(bars(el)).toEqual([
      ['Peito', '3', '100'],
      ['Costas', '0', '0'],
      ['Pernas', '2', '66.7'],
      ['Ombros', '0', '0'],
      ['Braços', '0', '0'],
      ['Abdômen', '0', '0'],
    ]);
    expect(el.querySelector('.bars')?.getAttribute('aria-label')).toBe(
      'Séries de trabalho por grupo muscular',
    );
    expect(text(el)).toContain('Aquecimento não conta');
    expect(text(el)).toContain('não recomenda quanto fazer');
    // Sem meta definida pelo dono, nenhuma meta é imposta.
    expect(text(el.querySelector('.goal-text b'))).toBe('Meta de Treinos por Semana');
    expect(text(el.querySelector('.goal-text span'))).toBe('Sem meta: você define');
    expect(text(el.querySelector('.goal button'))).toBe('Definir');
  });

  it('walks back week by week, naming both months when the week crosses the month', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(toggle(el)).not.toBeNull());
    toggle(el).click();
    await eventually(fixture, () => expect(el.querySelectorAll('.bar')).toHaveLength(6));

    const next = el.querySelector<HTMLButtonElement>('button[aria-label="Próxima semana"]')!;
    const previous = el.querySelector<HTMLButtonElement>('button[aria-label="Semana anterior"]')!;
    expect(next.disabled).toBe(true);

    previous.click();
    await eventually(fixture, () =>
      expect(text(el.querySelector('.range b'))).toBe('28 de setembro a 4 de outubro'),
    );
    expect(text(el.querySelector('.range span'))).toBe('Semana passada');
    expect(text(el.querySelector('.totals b'))).toBe('1 treino · 2 séries');
    expect(text(el.querySelector('.totals span'))).toBe('Semana anterior: nenhuma série');
    expect(bars(el)[0]).toEqual(['Peito', '2', '100']);
    expect(next.disabled).toBe(false);

    previous.click();
    await eventually(fixture, () =>
      expect(text(el.querySelector('.range b'))).toBe('21 a 27 de setembro'),
    );
    // Duas semanas atrás não tem nome próprio.
    expect(el.querySelector('.range span')).toBeNull();

    next.click();
    next.click();
    await eventually(fixture, () =>
      expect(text(el.querySelector('.range span'))).toBe('Esta semana'),
    );
  });

  it('compares the workouts with the goal once the owner defines one, and offers to change it', async () => {
    const { fixture, el } = await open();
    await TestBed.inject(GoalRepository).set('weekly_sessions', 4);
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('2 de 4 treinos · 5 séries'),
    );
    toggle(el).click();
    fixture.detectChanges();
    expect(text(el.querySelector('.goal-text span'))).toBe('4 por semana');
    expect(text(el.querySelector('.goal button'))).toBe('Mudar');
  });

  it('saves the weekly goal typed in the sheet once, in the local database and in the send queue', async () => {
    const { fixture, el, trainingDb, db } = await open();
    await eventually(fixture, () => expect(toggle(el)).not.toBeNull());
    toggle(el).click();
    await eventually(fixture, () => expect(el.querySelector('.goal button')).not.toBeNull());

    el.querySelector<HTMLButtonElement>('.goal button')!.click();
    fixture.detectChanges();
    const input = el.querySelector<HTMLInputElement>('app-goal-sheet input')!;
    input.value = '3';
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('app-goal-sheet button.primary')!.click();

    await vi.waitFor(async () => {
      expect(await trainingDb.goals.get('weekly_sessions:')).toMatchObject({ value: 3 });
    });
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('2 de 3 treinos · 5 séries'),
    );
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].url).toMatch(/\/goals\/weekly_sessions$/);
  });
});
