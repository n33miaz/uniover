import {
  capsule,
  circle,
  ellipse,
  mirrorRect,
  pill,
  polygon,
  rectPath,
  rectsOverlap,
} from './body-shapes';

describe('body shapes', () => {
  it('draws a vertical capsule with round ends from its two points and radius', () => {
    expect(capsule(10, 0, 10, 20, 5)).toBe('M15 0L15 20A5 5 0 0 1 5 20L5 0A5 5 0 0 1 15 0Z');
  });

  it('draws a rotated ellipse through the ends of its turned axis', () => {
    expect(ellipse(50, 50, 10, 4)).toBe('M40 50A10 4 0 1 0 60 50A10 4 0 1 0 40 50Z');
    // A 90 graus o eixo maior fica na vertical.
    expect(ellipse(50, 50, 10, 4, 90)).toBe('M50 40A10 4 90 1 0 50 60A10 4 90 1 0 50 40Z');
    expect(circle(5, 5, 3)).toBe(ellipse(5, 5, 3, 3));
  });

  it('draws a rounded rectangle and a polygon', () => {
    expect(pill(0, 0, 10, 20, 3)).toBe(
      'M3 0H7A3 3 0 0 1 10 3V17A3 3 0 0 1 7 20H3A3 3 0 0 1 0 17V3A3 3 0 0 1 3 0Z',
    );
    expect(polygon([0, 0], [10, 0], [5, 8])).toBe('M0 0L10 0L5 8Z');
  });

  it('turns a rectangle into a path and mirrors it around the vertical axis', () => {
    expect(rectPath([1, 2, 4, 8])).toBe('M1 2H4V8H1Z');
    expect(mirrorRect([1, 2, 4, 8], 10)).toEqual([6, 2, 9, 8]);
  });

  it('tells overlapping rectangles from rectangles that only touch', () => {
    expect(rectsOverlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(rectsOverlap([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
    expect(rectsOverlap([0, 0, 10, 10], [0, 10, 10, 20])).toBe(false);
    expect(rectsOverlap([0, 0, 10, 10], [20, 20, 30, 30])).toBe(false);
  });
});
