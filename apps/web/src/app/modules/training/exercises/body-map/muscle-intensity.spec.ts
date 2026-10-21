import { intensityOf, legendSteps } from './muscle-intensity';

describe('muscle intensity', () => {
  it('keeps zero as the neutral level, with no alarm for a muscle that was not trained', () => {
    expect(intensityOf(0)).toBe(0);
  });

  it('steps up with the sets of the week', () => {
    expect([1, 3].map(intensityOf)).toEqual([1, 1]);
    expect([4, 9].map(intensityOf)).toEqual([2, 2]);
    expect([10, 11, 40].map(intensityOf)).toEqual([3, 3, 3]);
  });

  it('describes every level in numbers for the legend, from the lightest to the strongest', () => {
    expect(legendSteps()).toEqual([
      { level: 0, range: '0' },
      { level: 1, range: '1–3' },
      { level: 2, range: '4–9' },
      { level: 3, range: '10+' },
    ]);
  });

  it('makes the legend agree with the levels: the ends of each range map to that level', () => {
    for (const step of legendSteps()) {
      const first = Number.parseInt(step.range, 10);
      expect(intensityOf(first)).toBe(step.level);
    }
  });
});
