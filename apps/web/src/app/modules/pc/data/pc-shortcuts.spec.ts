import type {
  PcKeyV1BodyKey,
  PcKeyV1BodyModifiersItem,
} from '../../../core/api/generated/agent/pc_key_v1';
import { LABELLED_SHORTCUTS, shortcutLabel } from '../ui/shortcut-labels';
import { PC_KEYS, PC_MODIFIERS, type PcKeyV1, type PcModifier } from './pc-types';
import {
  DEFAULT_PINNED,
  MAX_PINNED,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  keysText,
  shortcutById,
} from './pc-shortcuts';

/** Verdadeiro só se os dois tipos são exatamente o mesmo (um a mais ou a menos em qualquer lado quebra a compilação). */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// O contrato é a fonte: estes tipos vêm do esquema `pc.key.v1`, gerado. Se o esquema ganhar ou perder uma tecla, ou um
// modificador, a tela e o catálogo precisam ser revistos, e isto deixa de compilar até serem.
const keysAreTheContractKeys: Same<PcKeyV1, PcKeyV1BodyKey> = true;
const modifiersAreTheContractModifiers: Same<PcModifier, PcKeyV1BodyModifiersItem> = true;

describe('shortcut catalog', () => {
  it('uses exactly the keys and modifiers of the current key contract', () => {
    expect(keysAreTheContractKeys).toBe(true);
    expect(modifiersAreTheContractModifiers).toBe(true);
  });

  it('every key shortcut is a key and modifiers the contract accepts, with no modifier twice', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.action.kind !== 'keys') continue;
      const { key, modifiers } = shortcut.action;
      // Compila só se a tecla e cada modificador são os do contrato gerado.
      const contractKey: PcKeyV1BodyKey = key;
      const contractModifiers: PcKeyV1BodyModifiersItem[] = [...modifiers];
      expect(PC_KEYS, shortcut.id).toContain(contractKey);
      expect(contractModifiers.length, shortcut.id).toBeLessThanOrEqual(4);
      expect(new Set(contractModifiers).size, shortcut.id).toBe(contractModifiers.length);
      for (const modifier of contractModifiers)
        expect(PC_MODIFIERS, shortcut.id).toContain(modifier);
    }
  });

  it('lists every key of the contract once, at run time, for the check above', () => {
    expect(new Set(PC_KEYS).size).toBe(PC_KEYS.length);
    // 14 de navegação e edição, 12 de função e 26 letras.
    expect(PC_KEYS).toHaveLength(52);
  });

  it('has unique ids, in English kebab-case (they go to the device storage, never to the screen)', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
  });

  it('has the groups asked for, each with shortcuts, and every shortcut in a known group', () => {
    expect(SHORTCUT_GROUPS).toEqual(['edit', 'window', 'system', 'browser', 'video', 'slides']);
    for (const group of SHORTCUT_GROUPS) {
      expect(
        SHORTCUTS.filter((shortcut) => shortcut.group === group).length,
        group,
      ).toBeGreaterThan(3);
    }
    for (const shortcut of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(shortcut.group);
  });

  it('inside a group no two shortcuts are the same keys', () => {
    for (const group of SHORTCUT_GROUPS) {
      const combos = SHORTCUTS.filter((shortcut) => shortcut.group === group).map(keysText);
      expect(new Set(combos.filter(Boolean)).size, group).toBe(combos.filter(Boolean).length);
    }
  });

  it('covers what was asked: editing, window, system, browser, video and slides', () => {
    const text = (id: string) => keysText(shortcutById(id)!);
    // edição
    expect(
      ['copy', 'paste', 'cut', 'undo', 'redo', 'select-all', 'save', 'find'].map(text),
    ).toEqual(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+S', 'Ctrl+F']);
    // janela
    expect(text('switch-window')).toBe('Alt+Tab');
    expect(text('close-window')).toBe('Alt+F4');
    expect(text('show-desktop')).toBe('Win+D');
    expect(text('task-view')).toBe('Win+Tab');
    expect(text('snap-left')).toBe('Win+←');
    expect(text('maximize')).toBe('Win+↑');
    // sistema
    expect(text('explorer')).toBe('Win+E');
    expect(text('task-manager')).toBe('Ctrl+Shift+Esc');
    expect(text('clipboard-history')).toBe('Win+V');
    // navegador
    expect(text('new-tab')).toBe('Ctrl+T');
    expect(text('close-tab')).toBe('Ctrl+W');
    expect(text('reopen-tab')).toBe('Ctrl+Shift+T');
    expect(text('reload')).toBe('F5');
    expect(text('back')).toBe('Alt+←');
    expect(text('forward')).toBe('Alt+→');
    // vídeo
    expect(text('play-pause')).toBe('Space');
    expect(text('video-fullscreen')).toBe('F');
    expect(text('video-back-5')).toBe('←');
    // apresentação
    expect(text('slides-start')).toBe('F5');
    expect(text('slides-end')).toBe('Esc');
    expect(text('slides-next')).toBe('→');
  });

  it('Lock is the power action of the PC, not the Win+L keys (injected input does not lock reliably)', () => {
    const lock = shortcutById('lock')!;
    expect(lock.action).toEqual({ kind: 'lock' });
    expect(keysText(lock)).toBe('');
    const nonKeys = SHORTCUTS.filter((shortcut) => shortcut.action.kind !== 'keys');
    expect(nonKeys.map((shortcut) => shortcut.id)).toEqual(['lock']);
    // Nenhum atalho de teclas é Win+L.
    expect(SHORTCUTS.map(keysText)).not.toContain('Win+L');
  });

  it('leaves out what the current contract cannot say (digits, punctuation, Win alone, zoom)', () => {
    const texts = SHORTCUTS.map(keysText);
    expect(texts).not.toContain('Win');
    for (const text of texts) expect(text).not.toMatch(/[+-]$|\+0$|\+\d$/);
  });

  it('has a label for every shortcut, and none for one that does not exist', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id).sort();
    expect([...LABELLED_SHORTCUTS].sort()).toEqual(ids);
    for (const id of ids) expect(shortcutLabel(id).length, id).toBeGreaterThan(1);
    // O rótulo diz o que o atalho faz, não as teclas.
    for (const id of ids) expect(shortcutLabel(id)).not.toMatch(/Ctrl\+|Alt\+|Win\+/);
  });

  it('starts with pinned shortcuts that exist, in a number that fits', () => {
    expect(DEFAULT_PINNED.length).toBeLessThanOrEqual(MAX_PINNED);
    expect(MAX_PINNED).toBe(12);
    for (const id of DEFAULT_PINNED) expect(shortcutById(id), id).toBeDefined();
    expect(new Set(DEFAULT_PINNED).size).toBe(DEFAULT_PINNED.length);
  });

  it('writes the keys as on the keyboard of the PC', () => {
    expect(
      keysText({
        id: 'x',
        group: 'edit',
        action: { kind: 'keys', key: 'PAGE_DOWN', modifiers: [] },
      }),
    ).toBe('PgDn');
    expect(
      keysText({
        id: 'x',
        group: 'edit',
        action: { kind: 'keys', key: 'A', modifiers: ['CTRL', 'SHIFT', 'ALT', 'WIN'] },
      }),
    ).toBe('Ctrl+Shift+Alt+Win+A');
  });
});
