import {
  EMPTY_FIELDS,
  bumpValue,
  formatField,
  loadStepFor,
  parseField,
  toRepositoryDraft,
} from './set-draft';

describe('set fields', () => {
  describe('load step', () => {
    it('follows the equipment: barbell 2.5, dumbbell 2, machine and cable 5', () => {
      expect(loadStepFor({ stepKg: null, equipment: 'barbell' })).toBe(2.5);
      expect(loadStepFor({ stepKg: null, equipment: 'dumbbell' })).toBe(2);
      expect(loadStepFor({ stepKg: null, equipment: 'machine' })).toBe(5);
      expect(loadStepFor({ stepKg: null, equipment: 'cable' })).toBe(5);
    });

    it('uses the step the owner chose for the exercise', () => {
      expect(loadStepFor({ stepKg: 1.25, equipment: 'barbell' })).toBe(1.25);
    });

    it('falls back to one kilo when the equipment has no step, so the button always does something', () => {
      expect(loadStepFor({ stepKg: null, equipment: 'bodyweight' })).toBe(1);
      expect(loadStepFor(undefined)).toBe(1);
    });
  });

  describe('bump', () => {
    it('adds and removes one step without floating point noise', () => {
      expect(bumpValue(42.5, 1, 2.5, 0, 999)).toBe(45);
      expect(bumpValue(0.1, 1, 0.2, 0, 999)).toBe(0.3);
      expect(bumpValue(42.5, -1, 2.5, 0, 999)).toBe(40);
    });

    it('never leaves the limits', () => {
      expect(bumpValue(1, -1, 2.5, 0, 999)).toBe(0);
      expect(bumpValue(998, 1, 5, 0, 999)).toBe(999);
    });

    it('starts from zero when the field is empty', () => {
      expect(bumpValue(null, 1, 2.5, 0, 999)).toBe(2.5);
      expect(bumpValue(null, -1, 2.5, 0, 999)).toBe(0);
    });
  });

  describe('typing', () => {
    it('accepts a comma or a dot as the decimal mark', () => {
      expect(parseField('42,5', true)).toEqual({ ok: true, value: 42.5 });
      expect(parseField('42.5', true)).toEqual({ ok: true, value: 42.5 });
    });

    it('takes an empty field as no value, and refuses what is not a number', () => {
      expect(parseField('  ', true)).toEqual({ ok: true, value: null });
      expect(parseField('abc', true)).toEqual({ ok: false });
      expect(parseField('-3', true)).toEqual({ ok: false });
      expect(parseField('1,234', true)).toEqual({ ok: false });
    });

    it('keeps repetitions whole', () => {
      expect(parseField('12', false)).toEqual({ ok: true, value: 12 });
      expect(parseField('12,5', false)).toEqual({ ok: false });
    });

    it('shows the number in Brazilian format', () => {
      expect(formatField(42.5)).toBe('42,5');
      expect(formatField(40)).toBe('40');
      expect(formatField(null)).toBe('');
    });
  });

  describe('what goes to the repository', () => {
    const fields = { ...EMPTY_FIELDS, weightKg: 42.5, reps: 8, durationS: 30, rpe: 8, note: 'x' };

    it('sends load and repetitions for a weighted exercise', () => {
      expect(toRepositoryDraft({ id: 'e', recordType: 'weight_reps' }, fields)).toEqual({
        exerciseId: 'e',
        setType: 'work',
        weightKg: 42.5,
        reps: 8,
        durationS: null,
        rpe: 8,
        note: 'x',
      });
    });

    it('drops the load for a repetitions-only exercise and the repetitions for a timed one', () => {
      expect(toRepositoryDraft({ id: 'e', recordType: 'reps_only' }, fields)).toMatchObject({
        weightKg: null,
        reps: 8,
        durationS: null,
      });
      expect(toRepositoryDraft({ id: 'e', recordType: 'time' }, fields)).toMatchObject({
        weightKg: null,
        reps: null,
        durationS: 30,
      });
    });

    it('marks a warm-up set', () => {
      expect(
        toRepositoryDraft({ id: 'e', recordType: 'weight_reps' }, { ...fields, warmup: true }),
      ).toMatchObject({ setType: 'warmup' });
    });
  });
});
