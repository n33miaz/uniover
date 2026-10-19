import {
  DEFAULT_ONE_RM_FORMULA,
  ONE_RM_FORMULAS,
  ONE_RM_MAX_REPS,
  estimate1RM,
  estimateSet1RM,
  isEstimable,
  isLoadSet,
  isRecordSetType,
} from './one-rep-max';

const work = (weightKg: number | null, reps: number | null, setType = 'work') => ({
  setType,
  weightKg,
  reps,
});

describe('estimate1RM', () => {
  it('Epley: 42,5 kg x 8 gives 53,8 kg and 40 kg x 10 gives 53,3 kg (golden values)', () => {
    expect(estimate1RM(42.5, 8, 'epley')).toBeCloseTo(53.8333, 4);
    expect(estimate1RM(40, 10, 'epley')).toBeCloseTo(53.3333, 4);
    expect(Math.round((estimate1RM(42.5, 8, 'epley') as number) * 10) / 10).toBe(53.8);
    expect(Math.round((estimate1RM(40, 10, 'epley') as number) * 10) / 10).toBe(53.3);
  });

  it('Brzycki: 42,5 kg x 8 gives 52,76 kg (own calculation: 42,5 x 36 / 29)', () => {
    expect(estimate1RM(42.5, 8, 'brzycki')).toBeCloseTo(52.7586, 4);
    expect(estimate1RM(42.5, 8, 'brzycki') as number).toBeCloseTo(52.76, 2);
  });

  it('uses Epley by default and does not round inside the engine', () => {
    expect(DEFAULT_ONE_RM_FORMULA).toBe('epley');
    expect(estimate1RM(42.5, 8)).toBe(42.5 * (1 + 8 / 30));
    expect(estimate1RM(42.5, 8)).not.toBe(53.8);
  });

  it('keeps each formula exactly as published, also at the edges of 1 and 10 repetitions', () => {
    expect(estimate1RM(100, 1, 'epley')).toBeCloseTo(103.3333, 4);
    expect(estimate1RM(100, 1, 'brzycki')).toBe(100);
    expect(estimate1RM(60, 10, 'epley')).toBeCloseTo(80, 6);
    expect(estimate1RM(60, 10, 'brzycki')).toBeCloseTo(80, 6);
  });

  it('only estimates from 1 to 10 repetitions: 0 and 11 give no 1RM', () => {
    expect(ONE_RM_MAX_REPS).toBe(10);
    for (const formula of ONE_RM_FORMULAS) {
      expect(estimate1RM(50, 0, formula)).toBeNull();
      expect(estimate1RM(50, 11, formula)).toBeNull();
      expect(estimate1RM(50, 12, formula)).toBeNull();
      expect(estimate1RM(50, 1, formula)).not.toBeNull();
      expect(estimate1RM(50, 10, formula)).not.toBeNull();
    }
  });

  it('refuses a load that is not positive and repetitions that are not whole numbers', () => {
    expect(estimate1RM(0, 8)).toBeNull();
    expect(estimate1RM(-20, 8)).toBeNull();
    expect(estimate1RM(Number.NaN, 8)).toBeNull();
    expect(estimate1RM(Number.POSITIVE_INFINITY, 8)).toBeNull();
    expect(estimate1RM(50, 8.5)).toBeNull();
    expect(estimate1RM(50, -1)).toBeNull();
  });

  it('has exactly two formulas: Lombardi is not offered', () => {
    expect([...ONE_RM_FORMULAS]).toEqual(['epley', 'brzycki']);
  });
});

describe('isEstimable and isLoadSet', () => {
  it('accepts work and failure sets with a positive load and 1 to 10 repetitions', () => {
    expect(isEstimable(work(40, 8))).toBe(true);
    expect(isEstimable(work(40, 8, 'failure'))).toBe(true);
    expect(isEstimable(work(40, 1))).toBe(true);
    expect(isEstimable(work(40, 10))).toBe(true);
  });

  it('leaves warm-up and drop sets out', () => {
    expect(isEstimable(work(40, 8, 'warmup'))).toBe(false);
    expect(isEstimable(work(40, 8, 'drop'))).toBe(false);
    expect(isRecordSetType('warmup')).toBe(false);
    expect(isRecordSetType('drop')).toBe(false);
    expect(isRecordSetType('work')).toBe(true);
    expect(isRecordSetType('failure')).toBe(true);
  });

  it('leaves out sets without load, with zero load, or outside 1 to 10 repetitions', () => {
    expect(isEstimable(work(null, 8))).toBe(false);
    expect(isEstimable(work(0, 8))).toBe(false);
    expect(isEstimable(work(40, null))).toBe(false);
    expect(isEstimable(work(40, 0))).toBe(false);
    expect(isEstimable(work(40, 11))).toBe(false);
  });

  it('a set above 10 repetitions still counts as a load set (for the maximum load) but not as estimable', () => {
    expect(isLoadSet(work(40, 15))).toBe(true);
    expect(isEstimable(work(40, 15))).toBe(false);
    expect(isLoadSet(work(0, 15))).toBe(false);
  });

  it('estimateSet1RM follows the same rules', () => {
    expect(estimateSet1RM(work(42.5, 8))).toBeCloseTo(53.8333, 4);
    expect(estimateSet1RM(work(42.5, 8, 'warmup'))).toBeNull();
    expect(estimateSet1RM(work(42.5, 12))).toBeNull();
    expect(estimateSet1RM(work(42.5, 8), 'brzycki')).toBeCloseTo(52.7586, 4);
  });
});
