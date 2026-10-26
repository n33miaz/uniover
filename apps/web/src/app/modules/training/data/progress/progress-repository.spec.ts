import { SAO_PAULO, at } from '../../domain/progress/progress-test-kit';
import { localExercise } from '../sync/training-test-kit';
import {
  localSet,
  seedExerciseCatalog,
  session,
  sets,
  setupProgress,
} from './progress-data-test-kit';

const NOW = at('2026-10-18', 20);
const OPTIONS = { timeZone: SAO_PAULO, now: NOW };

/** O histórico de supino de referência: 29/08, 26/09 e 18/10, mais os 4 x 10 a 40 kg de 10/10. */
async function seedBenchHistory(t: ReturnType<typeof setupProgress>) {
  await seedExerciseCatalog(t.trainingDb);
  await t.trainingDb.sessions.bulkPut([
    session('s-0829', '2026-08-29'),
    session('s-0926', '2026-09-26'),
    session('s-1010', '2026-10-10'),
    session('s-1018', '2026-10-18'),
  ]);
  await t.trainingDb.sets.bulkPut([
    ...sets('a', 's-0829', 'supino', 3, '2026-08-29', { weightKg: 32.5, reps: 10 }),
    ...sets('b', 's-0926', 'supino', 3, '2026-09-26', { weightKg: 37.5, reps: 8 }),
    ...sets('c', 's-1010', 'supino', 4, '2026-10-10', { weightKg: 40, reps: 10 }),
    ...sets('d', 's-1018', 'supino', 3, '2026-10-18', { weightKg: 42.5, reps: 8 }),
  ]);
}

describe('ProgressRepository', () => {
  describe('exerciseSeries', () => {
    it('gives the 1RM and the load by day over all the history, and the +10,5 kg since 29/08', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);

      const series = await t.repository.exerciseSeries('supino', 'all', OPTIONS);

      expect(series.points.map((point) => point.date)).toEqual([
        '2026-08-29',
        '2026-09-26',
        '2026-10-10',
        '2026-10-18',
      ]);
      expect(series.points[3].oneRepMaxKg).toBeCloseTo(53.8333, 4);
      expect(series.points[3]).toMatchObject({ topWeightKg: 42.5, topWeightReps: 8 });
      expect(series.oneRepMaxDelta?.sinceDate).toBe('2026-08-29');
      expect(series.oneRepMaxDelta?.deltaKg).toBeCloseTo(10.5, 9);
      expect(series.topWeightDelta).toMatchObject({ deltaKg: 10, sinceDate: '2026-08-29' });
    });

    it('cuts the period: 8 weeks leaves out 29/08, 6 months keeps everything', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);

      const eight = await t.repository.exerciseSeries('supino', '8w', OPTIONS);
      const six = await t.repository.exerciseSeries('supino', '6m', OPTIONS);

      // 18/10 menos 56 dias é 23/08: 29/08 ainda cabe nas oito semanas; testamos com um "agora" mais adiante.
      expect(eight.points).toHaveLength(4);
      const later = await t.repository.exerciseSeries('supino', '8w', {
        ...OPTIONS,
        now: at('2026-10-30', 12),
      });
      expect(later.points.map((point) => point.date)).toEqual([
        '2026-09-26',
        '2026-10-10',
        '2026-10-18',
      ]);
      expect(six.points).toHaveLength(4);
      expect(later.oneRepMaxDelta?.sinceDate).toBe('2026-09-26');
    });

    it('cuts the 6 months by the calendar of the person: 28/02 at night in Brasília is already 01/03 in UTC', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.bulkPut([
        session('s-0828', '2025-08-28'),
        session('s-0829', '2025-08-29'),
        session('s-0220', '2026-02-20'),
      ]);
      await t.trainingDb.sets.bulkPut([
        ...sets('a', 's-0828', 'supino', 1, '2025-08-28', { weightKg: 30 }, 12),
        ...sets('b', 's-0829', 'supino', 1, '2025-08-29', { weightKg: 35 }, 12),
        ...sets('c', 's-0220', 'supino', 1, '2026-02-20', { weightKg: 40 }, 12),
      ]);

      // Seis meses antes de 28/02/2026 23:30 (Brasília) é 28/08/2025 23:30: 29/08 cabe, 28/08 ao meio-dia não. Pela conta
      // em UTC, "agora" já era 01/03 e a janela começaria em 31/08, deixando 29/08 de fora.
      const series = await t.repository.exerciseSeries('supino', '6m', {
        timeZone: SAO_PAULO,
        now: at('2026-02-28', 23, 30),
      });

      expect(series.points.map((point) => point.date)).toEqual(['2025-08-29', '2026-02-20']);
    });

    it('does not use sets after "now"', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);

      const series = await t.repository.exerciseSeries('supino', 'all', {
        ...OPTIONS,
        now: at('2026-10-12', 12),
      });

      expect(series.points.at(-1)?.date).toBe('2026-10-10');
    });

    it('leaves out deleted sets and the sets of a deleted session, but keeps the open session of today', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.bulkPut([
        session('viva', '2026-10-10'),
        session('apagada', '2026-10-11', { deletedAt: 5 }),
        session('aberta', '2026-10-18', { finishedAt: null }),
      ]);
      await t.trainingDb.sets.bulkPut([
        localSet('v1', 'viva', { completedAt: at('2026-10-10') }),
        localSet('v2', 'viva', { completedAt: at('2026-10-10', 10), weightKg: 100, deletedAt: 9 }),
        localSet('a1', 'apagada', { completedAt: at('2026-10-11'), weightKg: 90 }),
        localSet('o1', 'aberta', { completedAt: at('2026-10-18', 9), weightKg: 45, reps: 6 }),
      ]);

      const series = await t.repository.exerciseSeries('supino', 'all', OPTIONS);

      expect(series.points.map((point) => [point.date, point.topWeightKg])).toEqual([
        ['2026-10-10', 40],
        ['2026-10-18', 45],
      ]);
    });

    it('is empty for an exercise never done', async () => {
      const t = setupProgress();

      const series = await t.repository.exerciseSeries('nunca', 'all', OPTIONS);

      expect(series).toEqual({ points: [], oneRepMaxDelta: null, topWeightDelta: null });
    });

    it('uses the chosen formula', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);

      const brzycki = await t.repository.exerciseSeries('supino', 'all', {
        ...OPTIONS,
        formula: 'brzycki',
      });

      expect(brzycki.points[3].oneRepMaxKg).toBeCloseTo(52.7586, 4);
    });
  });

  describe('records', () => {
    it('finds the records of the reference case from the stored sets', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);

      const records = await t.repository.records('supino');

      expect(records.maxWeight).toMatchObject({ weightKg: 42.5, reps: 8, sessionId: 's-1018' });
      expect(records.oneRepMax?.valueKg).toBeCloseTo(53.8333, 4);
      expect(records.maxSessionVolume).toMatchObject({
        volumeKg: 1600,
        sessionId: 's-1010',
        sets: 4,
      });
      expect(records.maxRepsAtLoad).toMatchObject({ weightKg: 40, reps: 10 });
    });

    it('does not count sets of a deleted session', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);
      await t.trainingDb.sessions.update('s-1018', { deletedAt: 9 });

      const records = await t.repository.records('supino');

      expect(records.maxWeight?.weightKg).toBe(40);
    });
  });

  describe('weekVolume', () => {
    it('closes the reference week: 54 sets, with the split by group', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.bulkPut([
        session('A', '2026-10-12'),
        session('B', '2026-10-14'),
        session('C', '2026-10-16'),
      ]);
      await t.trainingDb.sets.bulkPut([
        ...sets('a1', 'A', 'supino', 10, '2026-10-12'),
        ...sets('a2', 'A', 'triceps', 6, '2026-10-12', {}, 10),
        ...sets('a0', 'A', 'supino', 2, '2026-10-12', { setType: 'warmup' }, 8),
        ...sets('b1', 'B', 'remada', 12, '2026-10-14'),
        ...sets('b2', 'B', 'rosca', 6, '2026-10-14', {}, 10),
        ...sets('c1', 'C', 'agacha', 12, '2026-10-16'),
        ...sets('c2', 'C', 'militar', 8, '2026-10-16', {}, 10),
        ...sets('c0', 'C', 'agacha', 3, '2026-10-16', { setType: 'warmup' }, 8),
        // Fora da semana e de treino apagado: não contam.
        ...sets('x1', 'A', 'supino', 5, '2026-10-19'),
      ]);
      await t.trainingDb.sessions.put(session('D', '2026-10-15', { deletedAt: 3 }));
      await t.trainingDb.sets.bulkPut(sets('d1', 'D', 'supino', 4, '2026-10-15'));

      const { week, volume } = await t.repository.weekVolume(at('2026-10-14'), {
        timeZone: SAO_PAULO,
      });

      expect(week.startKey).toBe('2026-10-12');
      expect(volume.total).toBe(54);
      expect(volume.byGroup).toEqual({
        chest: 10,
        back: 12,
        legs: 12,
        shoulders: 8,
        arms: 12,
        core: 0,
      });
      expect(volume.byMuscle).toMatchObject({ triceps: 6, biceps: 6 });
    });
  });

  describe('monthCalendar', () => {
    it('lists the days with a workout and marks today', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.bulkPut([
        session('a', '2026-10-01'),
        session('b', '2026-10-10'),
        session('c', '2026-10-10'),
        session('d', '2026-10-18'),
        session('so-aquecimento', '2026-10-20'),
        session('vazia', '2026-10-21'),
        session('apagada', '2026-10-22', { deletedAt: 1 }),
        session('setembro', '2026-09-30'),
      ]);
      await t.trainingDb.sets.bulkPut([
        localSet('a1', 'a', {}),
        localSet('b1', 'b', {}),
        localSet('c1', 'c', {}),
        localSet('d1', 'd', {}),
        localSet('w1', 'so-aquecimento', { setType: 'warmup' }),
        localSet('p1', 'apagada', {}),
        localSet('s1', 'setembro', {}),
      ]);

      const calendar = await t.repository.monthCalendar({ year: 2026, month: 10 }, OPTIONS);

      expect(calendar).toEqual({ days: [1, 10, 18], daysInMonth: 31, today: 18 });
    });

    it('does not mark today in another month', async () => {
      const t = setupProgress();

      const calendar = await t.repository.monthCalendar({ year: 2026, month: 9 }, OPTIONS);

      expect(calendar).toEqual({ days: [], daysInMonth: 30, today: null });
    });
  });

  describe('weekSummary', () => {
    it('sums the week and lists the records broken in it', async () => {
      const t = setupProgress();
      await seedBenchHistory(t);
      await t.trainingDb.sessions.put(session('s-1014', '2026-10-14'));
      await t.trainingDb.sets.bulkPut([
        ...sets('e', 's-1014', 'remada', 3, '2026-10-14', { weightKg: 50, reps: 10 }),
        localSet('w', 's-1018', {
          setType: 'warmup',
          completedAt: at('2026-10-18', 8),
          weightKg: 20,
        }),
      ]);

      const summary = await t.repository.weekSummary(OPTIONS);

      expect(summary.week.startKey).toBe('2026-10-12');
      expect(summary.sessions).toBe(2);
      expect(summary.workingSets).toBe(6);
      expect(summary.volumeKg).toBe(3 * 42.5 * 8 + 3 * 50 * 10);
      expect(summary.volume.total).toBe(6);
      // Supino bateu a carga e o 1RM sobre o que havia antes; remada não tinha passado.
      expect(summary.records).toEqual([
        { exerciseId: 'supino', exerciseName: 'Supino reto', kinds: ['maxWeight', 'oneRepMax'] },
      ]);
    });

    it('is empty in a week without workouts', async () => {
      const t = setupProgress();

      const summary = await t.repository.weekSummary(OPTIONS);

      expect(summary).toMatchObject({ sessions: 0, workingSets: 0, volumeKg: 0, records: [] });
    });
  });

  describe('lastLoadSuggestion', () => {
    const target = { exerciseId: 'supino', repMin: 6, repMax: 10 };

    it('suggests 42,5 kg after 4 x 10 at 40 kg with RPE 8 on a barbell (step 2,5 kg)', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.bulkPut(
        sets('p', 's1', 'supino', 4, '2026-10-10', { weightKg: 40, reps: 10, rpe: 8 }),
      );

      expect(await t.repository.lastLoadSuggestion(target)).toEqual({
        weightKg: 42.5,
        repsFrom: 6,
        repsTo: 8,
        reason: 'top-of-range',
      });
    });

    it('uses the step the owner chose for the exercise', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.exercises.put(
        localExercise('supino', { equipment: 'barbell', stepKg: 5 }),
      );
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.bulkPut(
        sets('p', 's1', 'supino', 3, '2026-10-10', { weightKg: 40, reps: 10 }),
      );

      expect((await t.repository.lastLoadSuggestion(target)).weightKg).toBe(45);
    });

    it('keeps the load and says why when the repetitions fell below the floor', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.bulkPut(
        sets('p', 's1', 'supino', 3, '2026-10-10', { weightKg: 40, reps: 4 }),
      );

      expect(await t.repository.lastLoadSuggestion(target)).toMatchObject({
        weightKg: 40,
        reason: 'below-floor',
      });
    });

    it('has no suggestion without a finished session, and does not look at the open one', async () => {
      const t = setupProgress();
      await seedExerciseCatalog(t.trainingDb);
      expect((await t.repository.lastLoadSuggestion(target)).reason).toBe('no-history');

      await t.trainingDb.sessions.put(session('aberta', '2026-10-18', { finishedAt: null }));
      await t.trainingDb.sets.bulkPut(
        sets('p', 'aberta', 'supino', 3, '2026-10-18', { weightKg: 40, reps: 10 }),
      );

      expect(await t.repository.lastLoadSuggestion(target)).toMatchObject({
        weightKg: null,
        reason: 'no-history',
      });
    });

    it('does not raise a body-weight exercise (no step)', async () => {
      const t = setupProgress();
      await t.trainingDb.exercises.put(
        localExercise('flexao', { equipment: 'bodyweight', recordType: 'weight_reps' }),
      );
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.bulkPut(
        sets('p', 's1', 'flexao', 3, '2026-10-10', { weightKg: 0, reps: 20 }),
      );

      expect(
        await t.repository.lastLoadSuggestion({ exerciseId: 'flexao', repMin: 10, repMax: 20 }),
      ).toMatchObject({ weightKg: 0, reason: 'top-of-range' });
    });
  });

  it('only reads: no query writes to the database or to the queue', async () => {
    const t = setupProgress();
    await seedBenchHistory(t);
    const counts = async () => [
      await t.trainingDb.sessions.count(),
      await t.trainingDb.sets.count(),
      await t.trainingDb.exercises.count(),
      await t.trainingDb.meta.count(),
      await t.trainingDb.goals.count(),
      (await t.outbox()).length,
    ];
    const before = await counts();

    await t.repository.exerciseSeries('supino', 'all', OPTIONS);
    await t.repository.records('supino');
    await t.repository.weekVolume(NOW, OPTIONS);
    await t.repository.monthCalendar({ year: 2026, month: 10 }, OPTIONS);
    await t.repository.weekSummary(OPTIONS);
    await t.repository.lastLoadSuggestion({ exerciseId: 'supino', repMin: 6, repMax: 10 });

    expect(await counts()).toEqual(before);
  });
});
