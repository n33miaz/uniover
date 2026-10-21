import { TestBed } from '@angular/core/testing';
import type { TrainingDb } from '../../data/training-db';
import { personalRecords } from '../../domain/progress/records';
import { SAO_PAULO, at, pset } from '../../domain/progress/progress-test-kit';
import { eventually, seedHistory } from '../../shell/screen-test-kit';
import { BENCH_HISTORY, setupProgress } from '../progress-test-kit';
import { ProgressRecords, recordRows } from './records-section';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('recordRows', () => {
  /**
   * O exemplo do desenho aprovado, feito à mão:
   *   10/10  4 séries de 40 kg × 10          → volume 4 × 10 × 40 = 1.600 kg
   *   18/10  1 série de 42,5 kg × 8          → 1RM 42,5 × (1 + 8/30) = 53,83
   * A carga mais usada nos últimos treinos é 40 kg (4 séries contra 1), e o máximo de repetições com ela é 10.
   */
  const records = personalRecords([
    ...[0, 1, 2, 3].map((index) =>
      pset({
        sessionId: 'a',
        weightKg: 40,
        reps: 10,
        completedAt: at('2026-10-10', 9, index),
      }),
    ),
    pset({ sessionId: 'b', weightKg: 42.5, reps: 8, completedAt: at('2026-10-18', 9) }),
  ]);

  it('writes the four records, with the load of the repetitions record spelled out', () => {
    const rows = recordRows(records, '2026-10-18', SAO_PAULO);

    expect(rows.map((row) => [row.title, row.value, row.detail])).toEqual([
      ['Carga máxima', '42,5 kg × 8', '18/10'],
      ['1RM estimado', '53,8 kg', '18/10 · de 42,5 kg × 8'],
      ['Maior volume em um treino', '1.600 kg', '10/10 · 4 séries'],
      ['Mais repetições com 40 kg', '10', '10/10'],
    ]);
  });

  it('badges only what was set on the last day the exercise was trained', () => {
    const rows = recordRows(records, '2026-10-18', SAO_PAULO);
    expect(rows.map((row) => [row.key, row.recent])).toEqual([
      ['maxWeight', true],
      ['oneRepMax', true],
      ['sessionVolume', false],
      ['repsAtLoad', false],
    ]);
    // Se o último treino foi outro dia, nenhum selo.
    expect(recordRows(records, '2026-10-20', SAO_PAULO).some((row) => row.recent)).toBe(false);
    expect(recordRows(records, null, SAO_PAULO).some((row) => row.recent)).toBe(false);
  });

  it('has no row without history', () => {
    expect(recordRows(personalRecords([]), null, SAO_PAULO)).toEqual([]);
  });

  it('skips the 1RM when no set has 10 repetitions or fewer', () => {
    const heavyReps = personalRecords([pset({ weightKg: 30, reps: 15 })]);
    const rows = recordRows(heavyReps, null, SAO_PAULO);
    expect(rows.map((row) => row.key)).toEqual(['maxWeight', 'sessionVolume', 'repsAtLoad']);
  });
});

describe('ProgressRecords', () => {
  /** O histórico é gravado antes de a tela existir: ela lê o banco local assim que nasce. */
  async function open(
    exerciseId: string,
    seed: (db: TrainingDb) => Promise<void> = async () => undefined,
  ) {
    const kit = await setupProgress();
    await seed(kit.trainingDb);
    const fixture = TestBed.createComponent(ProgressRecords);
    fixture.componentRef.setInput('exerciseId', exerciseId);
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the main numbers on the closed row and the four records when opened', async () => {
    const { fixture, el } = await open('supino-reto', (db) =>
      seedHistory(db, 'supino-reto', BENCH_HISTORY),
    );

    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('Carga máx. 42,5 kg · 1RM 53,8 kg'),
    );
    const toggle = el.querySelector<HTMLButtonElement>('button.toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.list')).toBeNull();

    toggle.click();
    fixture.detectChanges();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(el.querySelectorAll('.row')).map((row) => [
      text(row.querySelector('.title')),
      text(row.querySelector('.detail')),
      text(row.querySelector('.value')),
      row.querySelector('.ui-chip') !== null,
    ]);
    expect(rows).toEqual([
      ['Carga máxima', '22/09', '42,5 kg × 8', true],
      ['1RM estimado', '22/09 · de 42,5 kg × 8', '53,8 kg', true],
      // Maior volume: 40 × 10 em 15/09 (400 kg); o de 22/09 foi 42,5 × 8 = 340.
      ['Maior volume em um treino', '15/09 · 1 série', '400 kg', false],
      ['Mais repetições com 40 kg', '15/09', '10', false],
    ]);
    expect(text(el)).toContain('carga que você mais usou nos últimos quatro treinos');
  });

  it('says there are no records yet for an exercise without history', async () => {
    const { fixture, el } = await open('elevacao');
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('Sem registro ainda'),
    );
    el.querySelector<HTMLButtonElement>('button.toggle')!.click();
    fixture.detectChanges();
    expect(text(el)).toContain('Sem recordes ainda');
    expect(el.querySelector('.list')).toBeNull();
  });

  it('follows the exercise it is given', async () => {
    const { fixture, el } = await open('supino-reto', async (db) => {
      await seedHistory(db, 'supino-reto', BENCH_HISTORY);
      await seedHistory(db, 'agachamento', [[100, 60, 8]]);
    });
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toContain('42,5 kg'),
    );

    fixture.componentRef.setInput('exerciseId', 'agachamento');
    await eventually(fixture, () =>
      expect(text(el.querySelector('.ui-row-sub'))).toBe('Carga máx. 60 kg · 1RM 76 kg'),
    );
  });
});
