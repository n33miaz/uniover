import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../../core/session/session-state';
import { goalKey } from '../../domain/progress/goal-model';
import { goalDto, setupGoals } from './goal-data-test-kit';
import { toLocalGoal } from './goal';
import type { GoalWriteResult } from './goal-repository';

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

function saved(result: GoalWriteResult) {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.goal;
}

const remote = (...args: Parameters<typeof goalDto>) => {
  const row = toLocalGoal(goalDto(...args));
  if (row === null) throw new Error('tipo desconhecido');
  return row;
};

describe('GoalRepository', () => {
  describe('set', () => {
    it('writes to the device first and queues exactly one PUT by the natural key', async () => {
      const t = setupGoals();

      const goal = saved(await t.repository.set('weekly_sessions', 3));

      expect(goal).toMatchObject({
        id: 'weekly_sessions:',
        kind: 'weekly_sessions',
        exerciseId: null,
        value: 3,
        serverId: null,
        deletedAt: null,
      });
      expect(await t.repository.get('weekly_sessions')).toEqual(goal);
      expect(await t.repository.value('weekly_sessions')).toBe(3);
      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: '/api/v1/training/goals/weekly_sessions',
        module: 'training',
        status: 'pending',
      });
      expect(queued[0].body).toEqual({
        exerciseId: null,
        value: 3,
        clientUpdatedAt: new Date(goal.clientUpdatedAt).toISOString(),
      });
    });

    it('keeps the exercise in the key and in the body of an e1RM goal', async () => {
      const t = setupGoals();

      const goal = saved(await t.repository.set('exercise_e1rm', 55, 'supino'));

      expect(goal.id).toBe('exercise_e1rm:supino');
      expect(goalKey('exercise_e1rm', 'supino')).toBe(goal.id);
      expect(await t.repository.value('exercise_e1rm', 'supino')).toBe(55);
      expect(await t.repository.value('exercise_e1rm', 'agacha')).toBeNull();
      const [item] = await t.outbox();
      expect(item.url).toBe('/api/v1/training/goals/exercise_e1rm');
      expect(item.body).toMatchObject({ exerciseId: 'supino', value: 55 });
    });

    it('keeps one local row per natural key when the same goal is set again, with a newer clock', async () => {
      const t = setupGoals();
      const first = saved(await t.repository.set('weekly_sessions', 3));

      const second = saved(await t.repository.set('weekly_sessions', 4));

      expect(await t.trainingDb.goals.count()).toBe(1);
      expect(second.clientUpdatedAt).toBeGreaterThan(first.clientUpdatedAt);
      expect(await t.repository.value('weekly_sessions')).toBe(4);
      expect(await t.outbox()).toHaveLength(2);
    });

    it('moves the clock forward by at least one even when the device clock is stuck', async () => {
      const t = setupGoals();
      const a = saved(await t.repository.set('daily_kcal', 2200));
      const b = saved(await t.repository.set('daily_kcal', 2300));
      const c = saved(await t.repository.set('daily_kcal', 2400));

      expect(b.clientUpdatedAt).toBeGreaterThan(a.clientUpdatedAt);
      expect(c.clientUpdatedAt).toBeGreaterThan(b.clientUpdatedAt);
    });

    it('refuses what the API would refuse, and queues nothing', async () => {
      const t = setupGoals();

      expect(await t.repository.set('weekly_sessions', 0)).toEqual({
        status: 'invalid',
        issues: [{ path: 'value', code: 'value-range' }],
      });
      expect((await t.repository.set('weekly_sessions', 15)).status).toBe('invalid');
      expect((await t.repository.set('daily_kcal', 499)).status).toBe('invalid');
      expect((await t.repository.set('daily_kcal', 10001)).status).toBe('invalid');
      expect(await t.repository.set('exercise_e1rm', 55)).toEqual({
        status: 'invalid',
        issues: [{ path: 'exerciseId', code: 'exercise-required' }],
      });
      expect(await t.repository.set('weekly_sessions', 3, 'supino')).toEqual({
        status: 'invalid',
        issues: [{ path: 'exerciseId', code: 'exercise-not-allowed' }],
      });
      expect(await t.repository.set('exercise_e1rm', 55.555, 'supino')).toEqual({
        status: 'invalid',
        issues: [{ path: 'value', code: 'value-decimals' }],
      });
      expect(await t.repository.set('exercise_e1rm', Number.NaN, 'supino')).toMatchObject({
        status: 'invalid',
      });

      expect(await t.trainingDb.goals.count()).toBe(0);
      expect(await t.outbox()).toHaveLength(0);
    });

    it('undoes the local write when the queue has no room, and leaves the previous goal as it was', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));
      const before = await t.trainingDb.goals.get('weekly_sessions:');
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.set('weekly_sessions', 5)).toEqual({ status: 'storage-full' });
      expect(await t.repository.set('daily_kcal', 2200)).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.goals.get('weekly_sessions:')).toEqual(before);
      expect(await t.trainingDb.goals.get('daily_kcal:')).toBeUndefined();
      expect(await t.outbox()).toHaveLength(1);
    });

    it('does not depend on a login: a 401 or a logout leaves the goals and the queue alone', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));

      TestBed.inject(SessionState).clear('anonymous');

      expect(await t.repository.value('weekly_sessions')).toBe(3);
      expect(await t.outbox()).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('removes the goal by tombstone: the row stays, hidden, and the PUT carries an empty value', async () => {
      const t = setupGoals();
      saved(await t.repository.set('exercise_e1rm', 55, 'supino'));

      const removed = saved(await t.repository.clear('exercise_e1rm', 'supino'));

      expect(removed).toMatchObject({ value: null, deletedAt: expect.any(Number) });
      expect(await t.repository.get('exercise_e1rm', 'supino')).toBeUndefined();
      expect(await t.repository.list()).toEqual([]);
      expect(await t.trainingDb.goals.count()).toBe(1);
      const queued = await t.outbox();
      expect(queued).toHaveLength(2);
      expect(queued[1].body).toMatchObject({ exerciseId: 'supino', value: null });
    });

    it('has nothing to remove when there is no live goal, and queues nothing', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));
      saved(await t.repository.clear('weekly_sessions'));
      const queued = (await t.outbox()).length;

      expect(await t.repository.clear('weekly_sessions')).toEqual({ status: 'not-found' });
      expect(await t.repository.clear('daily_kcal')).toEqual({ status: 'not-found' });

      expect(await t.outbox()).toHaveLength(queued);
    });

    it('a goal set again after being removed comes back on the same row, with a newer clock', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));
      const removed = saved(await t.repository.clear('weekly_sessions'));

      const back = saved(await t.repository.set('weekly_sessions', 4));

      expect(back.deletedAt).toBeNull();
      expect(back.clientUpdatedAt).toBeGreaterThan(removed.clientUpdatedAt);
      expect(await t.trainingDb.goals.count()).toBe(1);
      expect(await t.repository.value('weekly_sessions')).toBe(4);
    });

    it('restores the goal when the queue has no room for the removal', async () => {
      const t = setupGoals();
      const goal = saved(await t.repository.set('weekly_sessions', 3));
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.repository.clear('weekly_sessions')).toEqual({ status: 'storage-full' });

      expect(await t.repository.get('weekly_sessions')).toEqual(goal);
    });
  });

  describe('list', () => {
    it('lists only live goals in a stable order', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));
      saved(await t.repository.set('exercise_e1rm', 55, 'supino'));
      saved(await t.repository.set('daily_kcal', 2200));
      saved(await t.repository.clear('daily_kcal'));

      expect((await t.repository.list()).map((row) => row.id)).toEqual([
        'exercise_e1rm:supino',
        'weekly_sessions:',
      ]);
    });

    it('bumps the revision on every local write', async () => {
      const t = setupGoals();
      const before = t.repository.revision();

      await t.repository.set('weekly_sessions', 3);

      expect(t.repository.revision()).toBeGreaterThan(before);
    });
  });

  describe('applyRemote', () => {
    it('brings in goals by the natural key and keeps the id the server gave', async () => {
      const t = setupGoals();

      await t.repository.applyRemote([
        remote('weekly_sessions', { value: 4 }),
        remote('exercise_e1rm', { exerciseId: 'supino', value: '55.5' }),
      ]);

      expect(await t.repository.value('weekly_sessions')).toBe(4);
      expect(await t.repository.value('exercise_e1rm', 'supino')).toBe(55.5);
      expect((await t.repository.get('weekly_sessions'))?.serverId).toBe(
        'servidor-weekly_sessions',
      );
    });

    it('lets the newer clientUpdatedAt win: the local edit survives an older remote one', async () => {
      const t = setupGoals();
      const local = saved(await t.repository.set('weekly_sessions', 5));

      await t.repository.applyRemote([
        remote('weekly_sessions', { value: 2, clientUpdatedAt: '2020-01-01T00:00:00Z' }),
      ]);

      expect(await t.repository.value('weekly_sessions')).toBe(5);
      // O que o servidor já sabe (o id dele) não se perde por a escrita local ser a mais nova.
      expect((await t.repository.get('weekly_sessions'))?.serverId).toBe(
        'servidor-weekly_sessions',
      );
      expect((await t.repository.get('weekly_sessions'))?.clientUpdatedAt).toBe(
        local.clientUpdatedAt,
      );
    });

    it('lets a newer remote edit win, and a tombstone removes the goal', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 5));
      saved(await t.repository.set('daily_kcal', 2200));

      await t.repository.applyRemote([
        remote('weekly_sessions', { value: 6, clientUpdatedAt: '2999-01-01T00:00:00Z' }),
        remote('daily_kcal', {
          value: null,
          deleted: true,
          clientUpdatedAt: '2999-01-01T00:00:00Z',
        }),
      ]);

      expect(await t.repository.value('weekly_sessions')).toBe(6);
      expect(await t.repository.get('daily_kcal')).toBeUndefined();
      expect(await t.trainingDb.goals.get('daily_kcal:')).toMatchObject({ value: null });
    });

    it('never deletes a local goal for not being in the pull: it may be a write still in the queue', async () => {
      const t = setupGoals();
      saved(await t.repository.set('weekly_sessions', 3));

      await t.repository.applyRemote([remote('daily_kcal', { value: 2500 })]);

      expect(await t.repository.value('weekly_sessions')).toBe(3);
      expect(await t.repository.value('daily_kcal')).toBe(2500);
    });

    it('ignores an empty page', async () => {
      const t = setupGoals();

      await t.repository.applyRemote([]);

      expect(await t.trainingDb.goals.count()).toBe(0);
    });
  });
});

describe('toLocalGoal', () => {
  it('ignores a kind that this version does not know', () => {
    expect(toLocalGoal(goalDto('body_fat'))).toBeNull();
  });

  it('turns the numbers of the generated type into numbers and the tombstone into an empty value', () => {
    expect(toLocalGoal(goalDto('daily_kcal', { value: '2200.5' }))).toMatchObject({
      value: 2200.5,
      deletedAt: null,
    });
    expect(toLocalGoal(goalDto('daily_kcal', { value: 2200, deleted: true }))).toMatchObject({
      value: null,
      deletedAt: expect.any(Number),
    });
  });
});
