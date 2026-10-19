import { TestBed } from '@angular/core/testing';
import { TrainingSync } from '../sync/training-sync';
import { SessionRepository } from './session-repository';
import { SESSIONS_PATH, SETS_PATH } from './session-api';
import { seedExercises, sessionDto, setDto, setupSessions } from './session-data-test-kit';

describe('sessions pull, end to end', () => {
  it('pulls the sessions and then the sets into the local database', async () => {
    const t = setupSessions();
    t.resume();
    t.pull.script = [
      { items: [], nextCursor: null },
      { items: [], nextCursor: null },
      {
        items: [
          sessionDto('s1', { finishedAt: '2026-10-01T11:00:00Z', feeling: '4', note: 'ok' }),
          sessionDto('s2', { deleted: true }),
        ],
        nextCursor: 'cursor-s',
      },
      {
        items: [
          setDto('t1', 's1', { weightKg: '82.5', reps: '6', rpe: '8.5', position: '1' }),
          setDto('t2', 's2', { deleted: true }),
        ],
        nextCursor: 'cursor-t',
      },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(t.pull.calls.map((call) => call.path)).toEqual([
      '/api/v1/training/exercises',
      '/api/v1/training/routines',
      SESSIONS_PATH,
      SETS_PATH,
      '/api/v1/training/goals',
    ]);
    expect(await t.trainingDb.sessions.get('s1')).toMatchObject({
      feeling: 4,
      note: 'ok',
      finishedAt: Date.parse('2026-10-01T11:00:00Z'),
      deviceId: 'outro-aparelho',
      deletedAt: null,
    });
    expect((await t.trainingDb.sessions.get('s2'))?.deletedAt).not.toBeNull();
    expect(await t.trainingDb.sets.get('t1')).toMatchObject({
      weightKg: 82.5,
      reps: 6,
      rpe: 8.5,
      position: 1,
      setType: 'work',
    });
    expect((await t.trainingDb.sets.get('t2'))?.deletedAt).not.toBeNull();
    expect(await t.trainingDb.syncState.get('sessions')).toMatchObject({ cursor: 'cursor-s' });
    expect(await t.trainingDb.syncState.get('sets')).toMatchObject({ cursor: 'cursor-t' });
  });

  it('a session pulled as open on another device blocks starting here', async () => {
    const t = setupSessions();
    t.resume();
    t.pull.script = [
      { items: [], nextCursor: null },
      { items: [], nextCursor: null },
      { items: [sessionDto('s-tablet', { deviceId: 'tablet' })], nextCursor: 'c' },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(await t.repository.start()).toMatchObject({
      status: 'open-elsewhere',
      session: { id: 's-tablet', deviceId: 'tablet' },
    });
    expect((await t.repository.openSessionsElsewhere()).map((row) => row.id)).toEqual(['s-tablet']);
  });

  it('does not pull while the queue has a set waiting to be sent, and keeps what was written offline', async () => {
    const t = setupSessions();
    const repository = TestBed.inject(SessionRepository);
    await seedExercises(t.trainingDb);
    const sync = TestBed.inject(TrainingSync);
    await sync.start();
    await repository.start();
    await repository.addSet({ exerciseId: 'supino', weightKg: 80, reps: 8 });

    const callsBefore = t.pull.calls.length;
    await sync.pullNow();
    expect(t.pull.calls).toHaveLength(callsBefore);

    // O servidor ainda não conhece nada disso: mesmo depois de enviar e puxar, a fusão não apaga nada por ausência.
    t.resume();
    await t.queue().syncNow();
    t.pull.script = [
      { items: [], nextCursor: null },
      { items: [], nextCursor: null },
      { items: [], nextCursor: 'c' },
      { items: [], nextCursor: 'c' },
    ];
    await sync.pullNow();

    expect(await t.trainingDb.sessions.count()).toBe(1);
    expect(await t.trainingDb.sets.count()).toBe(1);
    expect(await repository.activeSession()).toBeDefined();
  });
});
