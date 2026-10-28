import { TestBed } from '@angular/core/testing';
import { TrainingSync } from '../sync/training-sync';
import { BODY_ENTRIES_PATH, BODY_PROFILE_PATH, bodyEntryPath } from './body-api';
import { bodyEntryDto, bodyProfileDto, setupBody } from './body-data-test-kit';
import { BodyRepository } from './body-repository';
import { ProfileRepository } from './profile-repository';

const EMPTY = { items: [], nextCursor: null };

describe('body pull, end to end', () => {
  it('pulls the entries and the profile after the goals and keeps them in the local database', async () => {
    const t = setupBody();
    // exercícios, rotinas, treinos, séries e metas vêm vazios; depois, as medições e o perfil.
    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      {
        items: [
          bodyEntryDto('m1', { weightKg: 82.4, waistCm: 86 }),
          bodyEntryDto('m2', { deleted: true, weightKg: 99 }),
        ],
        nextCursor: 'cursor-m',
      },
      { items: [bodyProfileDto({ heightCm: 180 })], nextCursor: 'cursor-p' },
    ];

    await TestBed.inject(TrainingSync).start();

    expect(t.pull.calls.map((call) => call.path)).toEqual([
      '/api/v1/training/exercises',
      '/api/v1/training/routines',
      '/api/v1/training/program',
      '/api/v1/training/sessions',
      '/api/v1/training/sets',
      '/api/v1/training/goals',
      '/api/v1/training/foods',
      '/api/v1/training/meals',
      BODY_ENTRIES_PATH,
      BODY_PROFILE_PATH,
      '/api/v1/training/calendar-entries',
    ]);
    expect(BODY_ENTRIES_PATH).toBe('/api/v1/training/body/entries');
    expect(BODY_PROFILE_PATH).toBe('/api/v1/training/body/profile');
    expect(bodyEntryPath('abc')).toBe('/api/v1/training/body/entries/abc');
    expect(await t.trainingDb.syncState.get('bodyEntries')).toMatchObject({ cursor: 'cursor-m' });
    expect(await t.trainingDb.syncState.get('bodyProfile')).toMatchObject({ cursor: 'cursor-p' });

    const repository = TestBed.inject(BodyRepository);
    expect((await repository.get('m1'))?.weightKg).toBe(82.4);
    expect(await repository.get('m2')).toBeUndefined();
    expect(await t.trainingDb.bodyEntries.count()).toBe(2);
    expect(await TestBed.inject(ProfileRepository).get()).toMatchObject({ heightCm: 180 });
  });

  it('a later pull reapplies the window without duplicating, and the profile page has at most one item', async () => {
    const t = setupBody();
    const sync = TestBed.inject(TrainingSync);
    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      { items: [bodyEntryDto('m1', { weightKg: 82 })], nextCursor: 'c1' },
      { items: [bodyProfileDto({ heightCm: 180 })], nextCursor: 'p1' },
    ];
    await sync.start();

    t.pull.script = [
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      {
        items: [
          bodyEntryDto('m1', {
            weightKg: 81,
            clientUpdatedAt: '2026-10-02T10:00:00Z',
            updatedAt: '2026-10-02T10:00:00Z',
          }),
        ],
        nextCursor: 'c2',
      },
      {
        items: [
          bodyProfileDto({
            heightCm: 181,
            clientUpdatedAt: '2026-10-02T10:00:00Z',
            updatedAt: '2026-10-02T10:00:00Z',
          }),
        ],
        nextCursor: 'p2',
      },
    ];
    await sync.pullNow();

    expect(await t.trainingDb.bodyEntries.count()).toBe(1);
    expect((await TestBed.inject(BodyRepository).get('m1'))?.weightKg).toBe(81);
    expect(await t.trainingDb.bodyProfile.count()).toBe(1);
    expect((await TestBed.inject(ProfileRepository).get())?.heightCm).toBe(181);
  });

  it('does not pull while a body write is waiting in the queue, and keeps the local one afterwards', async () => {
    const t = setupBody();
    const sync = TestBed.inject(TrainingSync);
    await sync.start();
    const result = await TestBed.inject(BodyRepository).saveEntry({ weightKg: 80 });
    expect(result.status).toBe('saved');
    const calls = t.pull.calls.length;

    await sync.pullNow();

    expect(t.pull.calls).toHaveLength(calls);
    expect(t.queue().pendingCount()).toBe(1);
  });
});
