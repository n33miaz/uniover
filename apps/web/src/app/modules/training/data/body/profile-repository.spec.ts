import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../../core/session/session-state';
import type { BodyProfileValues } from '../../domain/body/body-limits';
import { bodyProfileDto, setupBody } from './body-data-test-kit';
import { toLocalBodyProfile } from './body-profile';
import type { ProfileWriteResult } from './profile-repository';

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

const VALUES: BodyProfileValues = {
  heightCm: 180,
  birthDate: '1995-06-15',
  sex: 'male',
  activityFactor: 1.55,
};

function saved(result: ProfileWriteResult) {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.profile;
}

const remote = (...args: Parameters<typeof bodyProfileDto>) => {
  const row = toLocalBodyProfile(bodyProfileDto(...args));
  if (row === null) throw new Error('perfil ignorado');
  return row;
};

describe('ProfileRepository', () => {
  describe('save', () => {
    it('is empty until the owner fills it in', async () => {
      const t = setupBody();

      expect(await t.profiles.get()).toBeUndefined();
    });

    it('writes to the device first and queues exactly one PUT with the whole profile', async () => {
      const t = setupBody();

      const profile = saved(await t.profiles.save(VALUES));

      expect(profile).toMatchObject({ id: 'me', ...VALUES });
      expect(await t.profiles.get()).toEqual(profile);
      const queued = await t.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        method: 'PUT',
        url: '/api/v1/training/body/profile',
        module: 'training',
        status: 'pending',
      });
      expect(queued[0].body).toEqual({
        heightCm: 180,
        birthDate: '1995-06-15',
        sex: 'male',
        activityFactor: 1.55,
        clientUpdatedAt: new Date(profile.clientUpdatedAt).toISOString(),
      });
    });

    it('keeps one local row when saved again, with a newer clock, and a new PUT each time', async () => {
      const t = setupBody();
      const first = saved(await t.profiles.save(VALUES));

      const second = saved(await t.profiles.save({ ...VALUES, heightCm: 181.5, sex: 'female' }));

      expect(await t.trainingDb.bodyProfile.count()).toBe(1);
      expect(second.clientUpdatedAt).toBeGreaterThan(first.clientUpdatedAt);
      expect(await t.profiles.get()).toMatchObject({ heightCm: 181.5, sex: 'female' });
      expect(await t.outbox()).toHaveLength(2);
    });

    it('refuses what the API would refuse, and queues nothing', async () => {
      const t = setupBody();

      expect(await t.profiles.save({ ...VALUES, heightCm: 99.9 })).toEqual({
        status: 'invalid',
        issues: [{ path: 'heightCm', code: 'value-range' }],
      });
      expect(await t.profiles.save({ ...VALUES, activityFactor: 2.6 })).toMatchObject({
        status: 'invalid',
      });
      // O relógio falso do teste marca 09/10/2025: nascer depois disso é erro.
      expect(await t.profiles.save({ ...VALUES, birthDate: '2025-10-10' })).toEqual({
        status: 'invalid',
        issues: [{ path: 'birthDate', code: 'date-invalid' }],
      });
      expect(await t.profiles.save({ ...VALUES, sex: 'outro' as 'male' })).toMatchObject({
        status: 'invalid',
      });

      expect(await t.trainingDb.bodyProfile.count()).toBe(0);
      expect(await t.outbox()).toHaveLength(0);
    });

    it('does not refuse a minor: only the calculations stop', async () => {
      const t = setupBody();

      expect((await t.profiles.save({ ...VALUES, birthDate: '2015-01-01' })).status).toBe('saved');
    });

    it('undoes the local write when the queue has no room, and leaves the previous profile as it was', async () => {
      const t = setupBody();
      saved(await t.profiles.save(VALUES));
      const before = await t.profiles.get();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.profiles.save({ ...VALUES, heightCm: 190 })).toEqual({
        status: 'storage-full',
      });

      expect(await t.profiles.get()).toEqual(before);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('removes the first profile when the queue has no room for it', async () => {
      const t = setupBody();
      vi.spyOn(t.db.outbox, 'add').mockRejectedValue(quota());

      expect(await t.profiles.save(VALUES)).toEqual({ status: 'storage-full' });

      expect(await t.profiles.get()).toBeUndefined();
    });

    it('does not depend on a login: a 401 or a logout leaves the profile and the queue alone', async () => {
      const t = setupBody();
      saved(await t.profiles.save(VALUES));

      TestBed.inject(SessionState).clear('anonymous');

      expect((await t.profiles.get())?.heightCm).toBe(180);
      expect(await t.outbox()).toHaveLength(1);
    });

    it('bumps the revision on every local write', async () => {
      const t = setupBody();
      const before = t.profiles.revision();

      await t.profiles.save(VALUES);

      expect(t.profiles.revision()).toBeGreaterThan(before);
    });
  });

  describe('applyRemote', () => {
    it('brings the server profile in when there is none locally', async () => {
      const t = setupBody();

      await t.profiles.applyRemote([remote({ heightCm: '175.5', activityFactor: '1.40' })]);

      expect(await t.profiles.get()).toMatchObject({
        id: 'me',
        heightCm: 175.5,
        activityFactor: 1.4,
        sex: 'male',
      });
    });

    it('the local profile wins until the server confirms: an older remote one does not overwrite it', async () => {
      const t = setupBody();
      const local = saved(await t.profiles.save({ ...VALUES, heightCm: 190 }));

      await t.profiles.applyRemote([
        remote({ heightCm: 150, clientUpdatedAt: '2020-01-01T00:00:00Z' }),
      ]);

      expect((await t.profiles.get())?.heightCm).toBe(190);
      expect((await t.profiles.get())?.clientUpdatedAt).toBe(local.clientUpdatedAt);
    });

    it('lets a newer remote profile win (another device edited it later)', async () => {
      const t = setupBody();
      saved(await t.profiles.save(VALUES));

      await t.profiles.applyRemote([
        remote({ heightCm: 182, clientUpdatedAt: '2999-01-01T00:00:00Z' }),
      ]);

      expect((await t.profiles.get())?.heightCm).toBe(182);
    });

    it('on a tie the server wins (it already saw everything this device sent)', async () => {
      const t = setupBody();
      const local = saved(await t.profiles.save(VALUES));

      await t.profiles.applyRemote([
        remote({
          heightCm: 181,
          clientUpdatedAt: new Date(local.clientUpdatedAt).toISOString(),
        }),
      ]);

      expect((await t.profiles.get())?.heightCm).toBe(181);
    });

    it('ignores an empty page', async () => {
      const t = setupBody();

      await t.profiles.applyRemote([]);

      expect(await t.trainingDb.bodyProfile.count()).toBe(0);
    });
  });
});

describe('toLocalBodyProfile', () => {
  it('ignores a profile this version cannot read (unknown sex or no height)', () => {
    expect(toLocalBodyProfile(bodyProfileDto({ sex: 'outro' }))).toBeNull();
    expect(toLocalBodyProfile(bodyProfileDto({ heightCm: null as unknown as number }))).toBeNull();
  });

  it('uses the default activity factor when the server sends none', () => {
    expect(
      toLocalBodyProfile(bodyProfileDto({ activityFactor: null as unknown as number })),
    ).toMatchObject({
      activityFactor: 1.55,
    });
  });
});
