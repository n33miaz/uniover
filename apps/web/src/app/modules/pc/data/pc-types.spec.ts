import type { PcClickV2BodyModifiersItem } from '../../../core/api/generated/agent/pc_click_v2';
import type { PcTextV2BodyKey } from '../../../core/api/generated/agent/pc_text_v2';
import {
  PC_CLICK_MAX_GAP_MS,
  PC_CLICK_V2_CAPABILITY,
  PC_KEY_MAX_REPEAT,
  PC_TEXT_V2_CAPABILITY,
  clampClickGap,
  clampKeyRepeat,
  clickNeedsV2,
  keyNeedsV2,
  textEditNeedsV2,
  type PcClickModifier,
  type PcKeyV1,
  type PcKeyV2Only,
  type PcTextKey,
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

/** Verdadeiro só se os dois tipos são exatamente o mesmo (um a mais ou a menos em qualquer lado quebra a compilação). */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// O contrato é a fonte: se o esquema ganhar ou perder uma tecla ou um modificador, isto deixa de compilar até a tela ser revista.
const textKeysAreTheContractKeys: Same<PcTextKey, PcTextV2BodyKey> = true;
const clickModifiersAreTheContractModifiers: Same<PcClickModifier, PcClickV2BodyModifiersItem> =
  true;

describe('the v2 contracts of the text and the click', () => {
  it('the hand written types are exactly the generated ones', () => {
    expect(textKeysAreTheContractKeys).toBe(true);
    expect(clickModifiersAreTheContractModifiers).toBe(true);
  });

  it('the capabilities are the ones the agent declares', () => {
    expect(PC_TEXT_V2_CAPABILITY).toBe('pc.text.v2');
    expect(PC_CLICK_V2_CAPABILITY).toBe('pc.click.v2');
  });
});

describe('textEditNeedsV2', () => {
  it('plain text fits the v1: any agent serves it', () => {
    expect(textEditNeedsV2({ text: 'olá' })).toBe(false);
    expect(textEditNeedsV2({ erase: 0, text: 'olá' })).toBe(false);
  });

  it('erasing or a key at the end needs the v2', () => {
    expect(textEditNeedsV2({ erase: 1 })).toBe(true);
    expect(textEditNeedsV2({ erase: 3, text: 'a' })).toBe(true);
    expect(textEditNeedsV2({ text: 'a', key: 'ENTER' })).toBe(true);
    expect(textEditNeedsV2({ key: 'TAB' })).toBe(true);
  });
});

describe('clampClickGap', () => {
  it.each([
    [undefined, 0],
    [0, 0],
    [120, 120],
    [120.6, 121],
    [400, 400],
    [401, 400],
    [10_000, 400],
    [-3, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('%s becomes %s', (given, expected) => {
    expect(clampClickGap(given)).toBe(expected);
  });

  it('never goes past the contract limit', () => {
    expect(clampClickGap(PC_CLICK_MAX_GAP_MS + 1)).toBe(PC_CLICK_MAX_GAP_MS);
  });
});

describe('clickNeedsV2', () => {
  it('a plain click fits the v1: any agent serves it', () => {
    expect(clickNeedsV2()).toBe(false);
    expect(clickNeedsV2({})).toBe(false);
    expect(clickNeedsV2({ modifiers: [], gapMs: 0 })).toBe(false);
    expect(clickNeedsV2({ gapMs: -4 })).toBe(false);
    expect(clickNeedsV2({ gapMs: Number.NaN })).toBe(false);
  });

  it('a modifier or a gap needs the v2', () => {
    expect(clickNeedsV2({ modifiers: ['CTRL'] })).toBe(true);
    expect(clickNeedsV2({ gapMs: 80 })).toBe(true);
    expect(clickNeedsV2({ modifiers: ['SHIFT', 'ALT'], gapMs: 80 })).toBe(true);
  });
});
