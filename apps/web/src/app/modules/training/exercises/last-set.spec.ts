import { summarizeLastSets } from './last-set';

const set = (weightKg: number | null, reps: number | null, durationS: number | null = null) => ({
  weightKg,
  reps,
  durationS,
});

describe('summarizeLastSets', () => {
  it('shows the heaviest set, and with the same load the one with more repetitions', () => {
    expect(summarizeLastSets([set(40, 10), set(42.5, 8), set(42.5, 6)], 'weight_reps')).toBe(
      '42,5 kg × 8',
    );
    expect(summarizeLastSets([set(40, 6), set(40, 9)], 'weight_reps')).toBe('40 kg × 9');
  });

  it('skips sets without load or repetitions', () => {
    expect(summarizeLastSets([set(null, 10), set(20, null), set(0, 5)], 'weight_reps')).toBeNull();
    expect(summarizeLastSets([], 'weight_reps')).toBeNull();
  });

  it('shows only the repetitions for a repetitions-only exercise', () => {
    expect(summarizeLastSets([set(null, 12), set(null, 15)], 'reps_only')).toBe('× 15');
    expect(summarizeLastSets([set(null, null)], 'reps_only')).toBeNull();
  });

  it('shows the longest time for a timed exercise', () => {
    expect(summarizeLastSets([set(null, null, 45), set(null, null, 90)], 'time')).toBe(
      '1 min 30 s',
    );
    expect(summarizeLastSets([set(null, null, 40)], 'time')).toBe('40 s');
    expect(summarizeLastSets([set(null, null, 120)], 'time')).toBe('2 min');
  });
});
