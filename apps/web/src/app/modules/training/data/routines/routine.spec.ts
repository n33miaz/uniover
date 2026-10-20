import { item, routine } from '../../domain/routines/routine-test-kit';
import {
  type LocalRoutine,
  resolveRoutine,
  toLocalRoutine,
  toRoutineTemplates,
  toUpsertBody,
} from './routine';
import { TEMPLATES_DTO, routineDto } from './routine-data-test-kit';

const local = (overrides: Partial<LocalRoutine> = {}): LocalRoutine => ({
  ...routine(),
  updatedAt: 1000,
  clientUpdatedAt: 1000,
  deletedAt: null,
  ...overrides,
});

describe('toLocalRoutine', () => {
  it('converts the API response, with instants in milliseconds and the items in position order', () => {
    const row = toLocalRoutine(
      routineDto('r1', {
        name: 'A · Peito',
        position: '2',
        note: null,
        updatedAt: '2026-10-19T12:00:00.1234567+00:00',
        clientUpdatedAt: '2026-10-19T11:59:59.0000000+00:00',
        items: [
          {
            id: 'i2',
            exerciseId: 'e2',
            position: 1,
            targetSets: '3',
            repMin: 8,
            repMax: 12,
            restSeconds: '90',
            supersetGroup: null,
            note: 'devagar',
          },
          {
            id: 'i1',
            exerciseId: 'e1',
            position: 0,
            targetSets: 4,
            repMin: 6,
            repMax: 10,
            restSeconds: 120,
            supersetGroup: 1,
            note: null,
          },
        ],
      }),
    );

    expect(row).toEqual({
      id: 'r1',
      name: 'A · Peito',
      position: 2,
      active: true,
      note: '',
      items: [
        {
          id: 'i1',
          exerciseId: 'e1',
          position: 0,
          targetSets: 4,
          repMin: 6,
          repMax: 10,
          restSeconds: 120,
          supersetGroup: 1,
          note: '',
        },
        {
          id: 'i2',
          exerciseId: 'e2',
          position: 1,
          targetSets: 3,
          repMin: 8,
          repMax: 12,
          restSeconds: 90,
          supersetGroup: null,
          note: 'devagar',
        },
      ],
      updatedAt: Date.parse('2026-10-19T12:00:00.123Z'),
      clientUpdatedAt: Date.parse('2026-10-19T11:59:59Z'),
      deletedAt: null,
    });
  });

  it('turns the tombstone flag into a deletedAt instant', () => {
    const row = toLocalRoutine(routineDto('r1', { deleted: true }));

    expect(row.deletedAt).toBe(row.updatedAt);
  });

  it('falls back to the server clock when the device clock is unreadable', () => {
    const row = toLocalRoutine(routineDto('r1', { clientUpdatedAt: 'lixo' }));

    expect(row.clientUpdatedAt).toBe(row.updatedAt);
  });
});

describe('toUpsertBody', () => {
  it('sends the whole routine, with ISO instants and blank notes as null', () => {
    const row = local({
      name: 'A',
      note: '   ',
      clientUpdatedAt: Date.parse('2026-10-19T12:00:00Z'),
      items: [item('i1', 0, { supersetGroup: 2, note: '' }), item('i2', 1, { note: 'obs' })],
    });

    expect(toUpsertBody(row, false)).toEqual({
      name: 'A',
      position: 0,
      active: true,
      note: null,
      items: [
        {
          id: 'i1',
          exerciseId: 'ex-i1',
          position: 0,
          targetSets: 3,
          repMin: 8,
          repMax: 12,
          restSeconds: 90,
          supersetGroup: 2,
          note: null,
        },
        {
          id: 'i2',
          exerciseId: 'ex-i2',
          position: 1,
          targetSets: 3,
          repMin: 8,
          repMax: 12,
          restSeconds: 90,
          supersetGroup: null,
          note: 'obs',
        },
      ],
      clientUpdatedAt: '2026-10-19T12:00:00.000Z',
      deleted: false,
    });
  });

  it('marks the tombstone', () => {
    expect(toUpsertBody(local(), true).deleted).toBe(true);
  });
});

describe('resolveRoutine', () => {
  it('the newer remote beats the local one', () => {
    const remote = local({ name: 'Servidor', clientUpdatedAt: 2000 });

    expect(resolveRoutine(local({ name: 'Local' }), remote)).toBe(remote);
  });

  it('the older remote does not beat the local one', () => {
    const mine = local({ name: 'Local', clientUpdatedAt: 3000 });

    expect(resolveRoutine(mine, local({ name: 'Servidor', clientUpdatedAt: 2000 }))).toBe(mine);
  });

  it('a tie goes to the server', () => {
    const remote = local({ name: 'Servidor' });

    expect(resolveRoutine(local({ name: 'Local' }), remote)).toBe(remote);
  });

  it('a newer tombstone beats an older edit, and a newer edit beats an older tombstone', () => {
    const tombstone = local({ clientUpdatedAt: 2000, deletedAt: 2000 });
    const edit = local({ name: 'Editada', clientUpdatedAt: 1500 });

    expect(resolveRoutine(edit, tombstone).deletedAt).toBe(2000);
    expect(resolveRoutine(local({ clientUpdatedAt: 1000, deletedAt: 1000 }), edit)).toBe(edit);
  });
});

describe('toRoutineTemplates', () => {
  it('converts the numbers the generator writes as number or string', () => {
    const [template] = toRoutineTemplates(TEMPLATES_DTO);

    expect(template.id).toBe('duplo');
    expect(template.routines.map((day) => day.name)).toEqual(['A · Peito', 'B · Braços']);
    expect(template.routines[0].items[1]).toEqual({
      exerciseSlug: 'crucifixo',
      targetSets: 3,
      repMin: 10,
      repMax: 15,
      restSeconds: 60,
      supersetGroup: null,
    });
    expect(template.routines[1].items.map((entry) => entry.supersetGroup)).toEqual([1, 1]);
  });
});
