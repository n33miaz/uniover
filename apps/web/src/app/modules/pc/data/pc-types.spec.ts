import {
  PC_KEY_MAX_REPEAT,
  clampKeyRepeat,
  keyNeedsV2,
  type PcKeyV1,
  type PcKeyV2Only,
} from './pc-types';

const V1_SAMPLE: readonly PcKeyV1[] = ['ENTER', 'BACKSPACE', 'DELETE', 'UP', 'F12', 'A', 'Z'];
const V2_ONLY: readonly PcKeyV2Only[] = [
  'D0',
  'D9',
  'MINUS',
  'EQUALS',
  'COMMA',
  'PERIOD',
  'INSERT',
  'PRINT_SCREEN',
  'APPS',
  'WIN',
  'CAPS_LOCK',
  'CTRL',
  'ALT',
  'SHIFT',
];

describe('keyNeedsV2', () => {
  it.each(V1_SAMPLE)('%s pressed once fits the v1', (key) => {
    expect(keyNeedsV2(key)).toBe(false);
    expect(keyNeedsV2(key, { repeat: 1, action: 'PRESS' })).toBe(false);
  });

  it.each(V2_ONLY)('%s needs the v2', (key) => {
    expect(keyNeedsV2(key)).toBe(true);
  });

  it('a repeat above one or a hold needs the v2, whatever the key', () => {
    expect(keyNeedsV2('BACKSPACE', { repeat: 2 })).toBe(true);
    expect(keyNeedsV2('BACKSPACE', { repeat: PC_KEY_MAX_REPEAT })).toBe(true);
    expect(keyNeedsV2('ALT', { action: 'UP' })).toBe(true);
    expect(keyNeedsV2('C', { action: 'DOWN' })).toBe(true);
  });

  it('a repeat that is clamped to one still fits the v1', () => {
    expect(keyNeedsV2('BACKSPACE', { repeat: 0 })).toBe(false);
    expect(keyNeedsV2('BACKSPACE', { repeat: Number.NaN })).toBe(false);
  });
});

describe('clampKeyRepeat', () => {
  it.each([
    [undefined, 1],
    [1, 1],
    [12, 12],
    [50, 50],
    [51, 50],
    [10_000, 50],
    [0, 1],
    [-5, 1],
    [3.9, 3],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('%s becomes %s', (given, expected) => {
    expect(clampKeyRepeat(given)).toBe(expected);
  });
});
