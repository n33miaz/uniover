import {
  GOAL_KINDS,
  GOAL_LIMITS,
  distanceToGoal,
  goalKey,
  goalRequiresExercise,
  isGoalKind,
  validateGoal,
} from './goal-model';

describe('goal model', () => {
  it('has the three kinds of the API with the same limits', () => {
    expect([...GOAL_KINDS]).toEqual(['exercise_e1rm', 'weekly_sessions', 'daily_kcal']);
    expect(GOAL_LIMITS).toEqual({
      exercise_e1rm: { min: 1, max: 1000 },
      weekly_sessions: { min: 1, max: 14 },
      daily_kcal: { min: 500, max: 10000 },
    });
    expect(isGoalKind('weekly_sessions')).toBe(true);
    expect(isGoalKind('body_fat')).toBe(false);
  });

  it('only the e1RM goal is per exercise', () => {
    expect(goalRequiresExercise('exercise_e1rm')).toBe(true);
    expect(goalRequiresExercise('weekly_sessions')).toBe(false);
    expect(goalRequiresExercise('daily_kcal')).toBe(false);
  });

  it('builds the natural key from the kind and the exercise', () => {
    expect(goalKey('weekly_sessions', null)).toBe('weekly_sessions:');
    expect(goalKey('exercise_e1rm', 'supino')).toBe('exercise_e1rm:supino');
    expect(goalKey('exercise_e1rm', 'supino')).not.toBe(goalKey('exercise_e1rm', 'agacha'));
  });

  describe('validateGoal', () => {
    it.each([
      ['weekly_sessions', 1],
      ['weekly_sessions', 14],
      ['daily_kcal', 500],
      ['daily_kcal', 10000],
    ] as const)('accepts %s at %d', (kind, value) => {
      expect(validateGoal(kind, value, null)).toEqual([]);
    });

    it.each([
      ['weekly_sessions', 0],
      ['weekly_sessions', 15],
      ['daily_kcal', 499],
      ['daily_kcal', 10001],
    ] as const)('refuses %s at %d', (kind, value) => {
      expect(validateGoal(kind, value, null)).toEqual([{ path: 'value', code: 'value-range' }]);
    });

    it('accepts an e1RM goal with an exercise, from 1 to 1000 kg, with up to two decimals', () => {
      expect(validateGoal('exercise_e1rm', 55, 'supino')).toEqual([]);
      expect(validateGoal('exercise_e1rm', 55.25, 'supino')).toEqual([]);
      expect(validateGoal('exercise_e1rm', 1000, 'supino')).toEqual([]);
      expect(validateGoal('exercise_e1rm', 1001, 'supino')).toEqual([
        { path: 'value', code: 'value-range' },
      ]);
      expect(validateGoal('exercise_e1rm', 55.255, 'supino')).toEqual([
        { path: 'value', code: 'value-decimals' },
      ]);
    });

    it('asks for the exercise on the e1RM goal and refuses it on the others', () => {
      expect(validateGoal('exercise_e1rm', 55, null)).toEqual([
        { path: 'exerciseId', code: 'exercise-required' },
      ]);
      expect(validateGoal('exercise_e1rm', 55, '')).toEqual([
        { path: 'exerciseId', code: 'exercise-required' },
      ]);
      expect(validateGoal('daily_kcal', 2200, 'supino')).toEqual([
        { path: 'exerciseId', code: 'exercise-not-allowed' },
      ]);
    });

    it('reports every problem at once', () => {
      expect(validateGoal('exercise_e1rm', 0, null)).toHaveLength(2);
    });
  });

  it('measures the distance to the goal: remaining when below, reached when at or above it', () => {
    expect(distanceToGoal(53.8, 55)).toEqual({ remaining: 55 - 53.8, reached: false });
    expect(distanceToGoal(55, 55)).toEqual({ remaining: 0, reached: true });
    expect(distanceToGoal(57, 55)).toEqual({ remaining: -2, reached: true });
  });
});
