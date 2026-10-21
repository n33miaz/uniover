import { MUSCLE_IDS, isMuscleId } from '../../domain/taxonomy';
import { Rect, rectsOverlap } from './body-shapes';
import {
  BODY_FACES,
  BODY_HEIGHT,
  BODY_OUTLINE,
  BODY_WIDTH,
  BODY_ZONES,
  MUSCLES_WITHOUT_ZONE,
  facesOf,
  faceFor,
} from './body-zones';

describe('body zones', () => {
  it('gives every muscle of the taxonomy a zone on the front or on the back', () => {
    const drawn = new Set(BODY_FACES.flatMap((face) => BODY_ZONES[face].map((z) => z.muscle)));
    expect([...drawn].sort()).toEqual([...MUSCLE_IDS].sort());
    expect(MUSCLES_WITHOUT_ZONE).toEqual([]);
  });

  it('points every zone to a muscle the taxonomy knows, once per face', () => {
    for (const face of BODY_FACES) {
      const muscles = BODY_ZONES[face].map((zone) => zone.muscle);
      for (const muscle of muscles) expect(isMuscleId(muscle)).toBe(true);
      expect(new Set(muscles).size).toBe(muscles.length);
    }
  });

  it('draws something and a touch area for every zone', () => {
    for (const face of BODY_FACES) {
      for (const zone of BODY_ZONES[face]) {
        expect(zone.shapes.length, `${face} ${zone.muscle} shapes`).toBeGreaterThan(0);
        expect(zone.tiles.length, `${face} ${zone.muscle} tiles`).toBeGreaterThan(0);
        for (const d of zone.shapes) expect(d).not.toMatch(/NaN|undefined/);
      }
    }
    for (const d of BODY_OUTLINE) expect(d).not.toMatch(/NaN|undefined/);
  });

  it('keeps both sides of a limb muscle in the same zone (two shapes, two touch areas)', () => {
    for (const face of BODY_FACES) {
      for (const muscle of ['shoulders', 'forearms', 'calves']) {
        const zone = BODY_ZONES[face].find((item) => item.muscle === muscle);
        if (!zone) continue;
        expect(zone.shapes).toHaveLength(2);
        expect(zone.tiles).toHaveLength(2);
      }
    }
  });

  describe('touch areas', () => {
    const all = (face: (typeof BODY_FACES)[number]) =>
      BODY_ZONES[face].flatMap((zone) => zone.tiles.map((tile) => ({ muscle: zone.muscle, tile })));

    it('never overlap each other, so a touch always belongs to one muscle', () => {
      for (const face of BODY_FACES) {
        const tiles = all(face);
        for (let a = 0; a < tiles.length; a++) {
          for (let b = a + 1; b < tiles.length; b++) {
            const clash = rectsOverlap(tiles[a].tile, tiles[b].tile);
            expect(
              clash,
              `${face}: ${tiles[a].muscle} ${tiles[a].tile} x ${tiles[b].muscle} ${tiles[b].tile}`,
            ).toBe(false);
          }
        }
      }
    });

    it('stay inside the drawing space and have a positive size', () => {
      for (const face of BODY_FACES) {
        for (const { muscle, tile } of all(face)) {
          const [left, top, right, bottom] = tile as Rect;
          expect(right - left, `${face} ${muscle} width`).toBeGreaterThan(0);
          expect(bottom - top, `${face} ${muscle} height`).toBeGreaterThan(0);
          expect(left, `${face} ${muscle} left`).toBeGreaterThanOrEqual(0);
          expect(top, `${face} ${muscle} top`).toBeGreaterThanOrEqual(0);
          expect(right, `${face} ${muscle} right`).toBeLessThanOrEqual(BODY_WIDTH);
          expect(bottom, `${face} ${muscle} bottom`).toBeLessThanOrEqual(BODY_HEIGHT);
        }
      }
    });

    it('mirror each other on the two sides of the body', () => {
      for (const face of BODY_FACES) {
        for (const zone of BODY_ZONES[face]) {
          if (zone.tiles.length !== 2) continue;
          const [left, right] = zone.tiles;
          expect(left[0]).toBeCloseTo(BODY_WIDTH - right[2], 5);
          expect(left[2]).toBeCloseTo(BODY_WIDTH - right[0], 5);
          expect(left[1]).toBe(right[1]);
          expect(left[3]).toBe(right[3]);
        }
      }
    });
  });

  describe('faces', () => {
    it('finds the faces where a muscle can be touched', () => {
      expect(facesOf('chest')).toEqual(['front']);
      expect(facesOf('lats')).toEqual(['back']);
      expect(facesOf('shoulders')).toEqual(['front', 'back']);
      expect(facesOf('unknown')).toEqual([]);
    });

    it('keeps the current face when the muscle is on it, and flips to the one that has it otherwise', () => {
      expect(faceFor('shoulders', 'back')).toBe('back');
      expect(faceFor('chest', 'front')).toBe('front');
      expect(faceFor('lats', 'front')).toBe('back');
      expect(faceFor('chest', 'back')).toBe('front');
      expect(faceFor('unknown', 'back')).toBe('back');
    });
  });
});
