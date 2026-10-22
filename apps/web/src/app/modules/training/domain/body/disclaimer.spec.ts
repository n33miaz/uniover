import { type HealthFigure, requiresDisclaimer } from './disclaimer';

describe('requiresDisclaimer', () => {
  it.each(['weight', 'trend', 'bodyFat', 'basalRate', 'calorieTarget'] as const)(
    'asks for the health notice on %s',
    (kind) => {
      expect(requiresDisclaimer(kind)).toBe(true);
    },
  );

  it.each(['measurements', 'photos'] as const)('does not ask for it on %s', (kind) => {
    expect(requiresDisclaimer(kind)).toBe(false);
  });

  it('answers for every figure the module has', () => {
    const all: HealthFigure[] = [
      'weight',
      'trend',
      'bodyFat',
      'basalRate',
      'calorieTarget',
      'measurements',
      'photos',
    ];

    expect(all.filter(requiresDisclaimer)).toHaveLength(5);
  });
});
