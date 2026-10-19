import { exerciseDto, localExercise } from '../sync/training-test-kit';
import { parseInstant, resolveExercise, toLocalExercise, toNumberOrNull } from './exercise';

describe('toLocalExercise', () => {
  it('converts the generated nullable numbers in one place', () => {
    expect(toNumberOrNull(2.5)).toBe(2.5);
    expect(toNumberOrNull('2.5')).toBe(2.5);
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull('')).toBeNull();
    expect(toNumberOrNull('abc')).toBeNull();

    expect(toLocalExercise(exerciseDto('a', { stepKg: '5' })).stepKg).toBe(5);
    expect(toLocalExercise(exerciseDto('a', { stepKg: 0 })).stepKg).toBe(0);
    expect(toLocalExercise(exerciseDto('a', { stepKg: null })).stepKg).toBeNull();
  });

  it('reads dates with seven fraction digits, as .NET writes them', () => {
    expect(parseInstant('2026-10-19T12:30:45.1234567+00:00')).toBe(
      Date.parse('2026-10-19T12:30:45.123Z'),
    );
    expect(parseInstant('2026-10-19T12:30:45Z')).toBe(Date.parse('2026-10-19T12:30:45Z'));
    expect(parseInstant(null)).toBeNull();
    expect(parseInstant('não é data')).toBeNull();
  });

  it('builds the search key and the tombstone marker', () => {
    const row = toLocalExercise(
      exerciseDto('a', {
        name: 'Elevação Pélvica',
        deleted: true,
        updatedAt: '2026-10-02T10:00:00Z',
      }),
    );
    expect(row.nameKey).toBe('elevacao pelvica');
    expect(row.deletedAt).toBe(Date.parse('2026-10-02T10:00:00Z'));
    expect(toLocalExercise(exerciseDto('b')).deletedAt).toBeNull();
  });

  it('carries the step clock of the owner choice', () => {
    const row = toLocalExercise(
      exerciseDto('a', { stepKg: 1.25, stepClientUpdatedAt: '2026-10-03T10:00:00Z' }),
    );
    expect(row.stepKg).toBe(1.25);
    expect(row.stepClientUpdatedAt).toBe(Date.parse('2026-10-03T10:00:00Z'));
  });
});

describe('resolveExercise', () => {
  const T1 = '2026-10-01T10:00:00Z';
  const T2 = '2026-10-02T10:00:00Z';
  const T3 = '2026-10-03T10:00:00Z';

  it('keeps the local content of an own exercise when it is newer', () => {
    const local = localExercise('a', { source: 'own', name: 'Meu', clientUpdatedAt: T2 });
    const remote = localExercise('a', { source: 'own', name: 'Velho', clientUpdatedAt: T1 });
    expect(resolveExercise(local, remote)).toBe(local);
  });

  it('takes the remote content of an own exercise when it is newer or equal', () => {
    const local = localExercise('a', { source: 'own', name: 'Meu', clientUpdatedAt: T1 });
    const newer = localExercise('a', { source: 'own', name: 'Novo', clientUpdatedAt: T2 });
    const tie = localExercise('a', { source: 'own', name: 'Empate', clientUpdatedAt: T1 });
    expect(resolveExercise(local, newer)).toBe(newer);
    expect(resolveExercise(local, tie)).toBe(tie);
  });

  it('applies a newer tombstone and ignores an older one', () => {
    const edited = localExercise('a', { source: 'own', clientUpdatedAt: T2 });
    const olderTombstone = localExercise('a', {
      source: 'own',
      clientUpdatedAt: T1,
      deleted: true,
    });
    const newerTombstone = localExercise('a', {
      source: 'own',
      clientUpdatedAt: T3,
      deleted: true,
    });
    expect(resolveExercise(edited, olderTombstone)).toBe(edited);
    expect(resolveExercise(edited, newerTombstone)).toBe(newerTombstone);
  });

  it('always takes the server text of a catalog row, so a seed correction arrives', () => {
    const local = localExercise('a', { name: 'Texto antigo', clientUpdatedAt: T3 });
    const remote = localExercise('a', { name: 'Texto corrigido', clientUpdatedAt: T1 });
    expect(resolveExercise(local, remote)).toBe(remote);
  });

  it('decides the load step by its own clock, apart from the content', () => {
    // O dono mudou o salto em outro aparelho: o exercício em si não mudou.
    const local = localExercise('a', { source: 'own', clientUpdatedAt: T2, stepKg: 2.5 });
    const remote = localExercise('a', {
      source: 'own',
      clientUpdatedAt: T1,
      stepKg: 1.25,
      stepClientUpdatedAt: T3,
    });

    const merged = resolveExercise(local, remote);

    expect(merged.clientUpdatedAt).toBe(local.clientUpdatedAt);
    expect(merged.stepKg).toBe(1.25);
    expect(merged.stepClientUpdatedAt).toBe(remote.stepClientUpdatedAt);
  });

  it('keeps a newer local step choice over an older remote one', () => {
    const local = localExercise('a', { stepKg: 5, stepClientUpdatedAt: T3 });
    const remote = localExercise('a', { stepKg: 1.25, stepClientUpdatedAt: T2 });
    const merged = resolveExercise(local, remote);
    expect(merged.stepKg).toBe(5);
    expect(merged.stepClientUpdatedAt).toBe(local.stepClientUpdatedAt);
  });

  it('keeps a local choice the server has not seen, and takes a remote one the device lacks', () => {
    const unsent = localExercise('a', { stepKg: 5, stepClientUpdatedAt: T2 });
    const noChoice = localExercise('a', { stepKg: null, stepClientUpdatedAt: null });
    expect(resolveExercise(unsent, noChoice).stepKg).toBe(5);

    const chosen = localExercise('a', { stepKg: 1.25, stepClientUpdatedAt: T2 });
    expect(resolveExercise(noChoice, chosen).stepKg).toBe(1.25);
  });

  it('lets the server win a tie on the step clock', () => {
    const local = localExercise('a', { stepKg: 5, stepClientUpdatedAt: T2 });
    const remote = localExercise('a', { stepKg: 2, stepClientUpdatedAt: T2 });
    expect(resolveExercise(local, remote).stepKg).toBe(2);
  });
});
