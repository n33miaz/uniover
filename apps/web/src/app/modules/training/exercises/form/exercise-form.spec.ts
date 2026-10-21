import {
  EMPTY_EXERCISE_FORM,
  ExerciseForm,
  isFormDirty,
  parseSteps,
  sameExerciseName,
  validateExerciseForm,
} from './exercise-form';

const valid: ExerciseForm = {
  name: 'Remada na máquina articulada',
  muscle: 'middle_back',
  equipment: 'machine',
  recordType: 'weight_reps',
  steps: '',
};

describe('exercise form', () => {
  it('accepts a form with a name and a main muscle', () => {
    expect(validateExerciseForm(valid)).toEqual([]);
  });

  it('asks for the name and the muscle', () => {
    expect(validateExerciseForm(EMPTY_EXERCISE_FORM)).toEqual(['name-missing', 'muscle-missing']);
    expect(validateExerciseForm({ ...valid, name: '   ' })).toContain('name-missing');
  });

  it('refuses what the server would refuse: a name over 120 characters, and too many or too long steps', () => {
    expect(validateExerciseForm({ ...valid, name: 'a'.repeat(121) })).toEqual(['name-too-long']);
    const steps = Array.from({ length: 21 }, (_, n) => `passo ${n}`).join('\n');
    expect(validateExerciseForm({ ...valid, steps })).toEqual(['steps-invalid']);
    expect(validateExerciseForm({ ...valid, steps: 'a'.repeat(501) })).toEqual(['steps-invalid']);
  });

  it('refuses a muscle, equipment or record type outside the taxonomy', () => {
    expect(validateExerciseForm({ ...valid, muscle: 'asas' })).toEqual(['muscle-missing']);
    expect(validateExerciseForm({ ...valid, equipment: 'rede' })).toEqual(['equipment-invalid']);
    expect(validateExerciseForm({ ...valid, recordType: 'cores' })).toEqual(['type-invalid']);
  });

  it('reads one step per line, without blanks', () => {
    expect(parseSteps('  um  \n\n dois\r\n   \ntrês')).toEqual(['um', 'dois', 'três']);
    expect(parseSteps('')).toEqual([]);
  });

  it('counts a real change as dirty and spaces or blank lines as nothing', () => {
    expect(isFormDirty(valid, { ...valid })).toBe(false);
    expect(isFormDirty(valid, { ...valid, name: ' Remada na máquina articulada ' })).toBe(false);
    expect(isFormDirty({ ...valid, steps: 'a\nb' }, { ...valid, steps: 'a\n\nb\n' })).toBe(false);
    expect(isFormDirty(valid, { ...valid, muscle: 'lats' })).toBe(true);
    expect(isFormDirty(valid, { ...valid, steps: 'novo' })).toBe(true);
  });

  it('treats names that differ only by accent, case or punctuation as the same', () => {
    expect(sameExerciseName('Supino RETO com barra', 'supino reto, com barra')).toBe(true);
    expect(sameExerciseName('Elevação lateral', 'elevacao lateral')).toBe(true);
    expect(sameExerciseName('Supino reto', 'Supino inclinado')).toBe(false);
    expect(sameExerciseName('', '')).toBe(false);
  });
});
