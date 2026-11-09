import { MAX_SLIDE, parseSlideNumber, slideKeys } from './pc-slides';

describe('slide numbers', () => {
  it.each([
    ['1', 1],
    [' 12 ', 12],
    ['999', 999],
  ])('accepts %j as slide %i', (text, slide) => {
    expect(parseSlideNumber(text)).toBe(slide);
  });

  it.each(['', '0', '000', '1000', '-3', '1.5', '1e2', 'ab', '١٢', '1 2'])('refuses %j', (text) => {
    expect(parseSlideNumber(text)).toBeNull();
  });

  it('turns a slide into digit keys and Enter, in order', () => {
    expect(slideKeys(7)).toEqual(['D7', 'ENTER']);
    expect(slideKeys(120)).toEqual(['D1', 'D2', 'D0', 'ENTER']);
    expect(slideKeys(MAX_SLIDE)).toEqual(['D9', 'D9', 'D9', 'ENTER']);
  });
});
