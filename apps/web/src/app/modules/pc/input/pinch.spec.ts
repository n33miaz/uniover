import { DEFAULT_PINCH, PinchTracker, classifyTwoFingers } from './pinch';
import { PAD_SLOP_PX } from './pad-gesture';

describe('classifyTwoFingers', () => {
  const classify = (spreadChange: number, centerTravel: number) =>
    classifyTwoFingers(spreadChange, centerTravel, PAD_SLOP_PX);

  it('does not know yet while the fingers barely moved', () => {
    expect(classify(0, 0)).toBe('undecided');
    expect(classify(5, 3)).toBe('undecided');
    expect(classify(-8, 2)).toBe('undecided');
  });

  it('a pinch is a change of the distance past the slack, with the center staying about where it was', () => {
    expect(classify(DEFAULT_PINCH.startPx, 0)).toBe('pinch');
    expect(classify(-DEFAULT_PINCH.startPx, 0)).toBe('pinch');
    expect(classify(40, 6)).toBe('pinch');
    expect(classify(-60, 20)).toBe('pinch');
  });

  it('a slack below the start never pinches, however still the center is', () => {
    expect(classify(DEFAULT_PINCH.startPx - 1, 0)).toBe('undecided');
    expect(classify(-(DEFAULT_PINCH.startPx - 1), 0)).toBe('undecided');
  });

  it('two fingers that move together scroll, as soon as the center leaves the tremor radius', () => {
    expect(classify(0, PAD_SLOP_PX + 1)).toBe('scroll');
    expect(classify(3, 20)).toBe('scroll');
    expect(classify(-4, 40)).toBe('scroll');
  });

  it('the scroll wins the tie: a distance that drifts while the center travels is a scroll', () => {
    // a mudança de distância passa da folga, mas o centro andou quase o mesmo: é um deslize torto, não uma pinça
    expect(classify(20, 20)).toBe('scroll');
    expect(classify(-20, 16)).toBe('scroll');
    // 1,5 vez é o piso da pinça: logo abaixo, a rolagem vence
    expect(classify(29, 20)).toBe('scroll');
    expect(classify(30, 20)).toBe('pinch');
  });

  it('the decision follows the numbers it is given, with the settings passed in', () => {
    const strict = { startPx: 30, dominance: 3, pxPerStep: 24 };
    expect(classifyTwoFingers(20, 0, PAD_SLOP_PX, strict)).toBe('undecided');
    expect(classifyTwoFingers(30, 0, PAD_SLOP_PX, strict)).toBe('pinch');
    expect(classifyTwoFingers(30, 12, PAD_SLOP_PX, strict)).toBe('scroll');
  });
});

describe('PinchTracker', () => {
  it('turns the change of distance into whole steps and keeps the remainder', () => {
    const tracker = new PinchTracker({ startPx: 14, dominance: 1.5, pxPerStep: 20 });
    tracker.begin(100);
    expect(tracker.update(110)).toBe(0);
    expect(tracker.update(125)).toBe(1); // 25 px: um passo, sobram 5
    expect(tracker.update(139)).toBe(0); // 39 px no total: o segundo passo ainda não
    expect(tracker.update(140)).toBe(1);
    expect(tracker.update(140)).toBe(0);
  });

  it('closing the fingers is negative, and going and coming back cancels out', () => {
    const tracker = new PinchTracker({ startPx: 14, dominance: 1.5, pxPerStep: 20 });
    tracker.begin(100);
    expect(tracker.update(55)).toBe(-2);
    expect(tracker.update(100)).toBe(2);
    expect(tracker.update(100)).toBe(0);
  });

  it('a jump gives every step at once, with the sign', () => {
    const tracker = new PinchTracker({ startPx: 14, dominance: 1.5, pxPerStep: 20 });
    tracker.begin(50);
    expect(tracker.update(190)).toBe(7);
    expect(tracker.update(30)).toBe(-8);
  });

  it('begin takes the distance of now as the new reference (a finger left or landed)', () => {
    const tracker = new PinchTracker({ startPx: 14, dominance: 1.5, pxPerStep: 20 });
    tracker.begin(100);
    tracker.update(115);
    tracker.begin(300);
    expect(tracker.update(310)).toBe(0);
    expect(tracker.update(321)).toBe(1);
  });

  it('never turns a number that is not a distance into steps', () => {
    const tracker = new PinchTracker();
    tracker.begin(100);
    expect(tracker.update(Number.NaN)).toBe(0);
    expect(tracker.update(Number.POSITIVE_INFINITY)).toBe(0);
    tracker.begin(Number.NaN);
    expect(tracker.update(100)).toBe(Math.trunc(100 / DEFAULT_PINCH.pxPerStep));
  });
});
